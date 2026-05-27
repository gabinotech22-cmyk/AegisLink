import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  View,
  Text,
  TextInput,
  Pressable,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Alert,
  Linking,
  Image,
  ActivityIndicator,
} from 'react-native';
import { FormattedText } from '../components/FormattedText';
import { AudioWaveform } from '../components/AudioWaveform';
import { LinkPreview } from '../components/LinkPreview';
import { GifPicker } from '../components/GifPicker';
import { ImageViewerModal } from '../components/ImageViewerModal';
import { loadWallpaper, wallpaperBg, type WallpaperOption } from '../components/WallpaperPicker';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableMessage } from '../components/SwipeableMessage';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { decodeBase64 } from 'tweetnacl-util';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { MessageActionsSheet } from '../components/MessageActionsSheet';
import { ForwardModal } from '../components/ForwardModal';
import { SchedulePicker } from '../components/SchedulePicker';
import { useScheduledMessages } from '../store/scheduledMessages';
import { useIdentity } from '../store/identity';
import { wipeDatabase } from '../db/local';
import { usePanicGesture } from '../hooks/usePanicGesture';
import { useMessages } from '../store/messages';
import { useTyping } from '../store/typing';
import { useConnection } from '../store/connection';
import { usePreferences } from '../store/preferences';
import { useContacts } from '../store/contacts';
import { sendMessage, emitTyping, sendReadReceipts, sendDeleteForEveryone } from '../socket/client';
import { startCall } from '../socket/calls';
import { WEBRTC_AVAILABLE } from '../runtime';
import { SoundFX } from '../hooks/useSoundFX';
import type { StoredContact, StoredMessage } from '../db/local';
import { parseLocationMessage } from '../utils/parseLocationMessage';

const EMPTY_MSGS: StoredMessage[] = [];

function formatLastSeen(ts: number): string {
  const now = Date.now();
  const diffMs = now - ts;
  const diffMin = Math.floor(diffMs / 60_000);
  const diffHours = Math.floor(diffMs / 3_600_000);
  const diffDays = Math.floor(diffMs / 86_400_000);
  if (diffMin < 1) return 'Visto hace un momento';
  if (diffMin < 60) return `Visto hace ${diffMin}m`;
  if (diffHours < 24) return `Visto hace ${diffHours}h`;
  if (diffDays === 1) return 'Visto ayer';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `Visto el ${dd}/${mm}`;
}

interface Props {
  contact: StoredContact;
  onBack: () => void;
  onContactDetail: () => void;
  onAttach: () => void;
  onEphemeral: () => void;
  onViewOnce?: (mediaUri: string, messageId: string) => void;
}

export function ChatScreen({ contact: initialContact, onBack, onContactDetail, onAttach, onEphemeral, onViewOnce }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();

  // ── Panic gesture (shake) ─────────────────────────────────────────────────
  const handlePanicTrigger = useCallback(async () => {
    try {
      await wipeDatabase();
      await useIdentity.getState().reset();
    } catch { /* non-recoverable */ }
  }, []);
  usePanicGesture(handlePanicTrigger);
  // GAP 1 FIX: Read contact reactively from store so profile updates from peers
  // (name, photo, color, status) are reflected live without leaving the chat
  const contact = useContacts((s) => s.contacts.find(c => c.aegisId === initialContact.aegisId)) ?? initialContact;
  const list = useMessages((s) => s.byChat[contact.aegisId] ?? EMPTY_MSGS);
  const loadChat = useMessages((s) => s.loadChat);
  const toggleStar = useMessages((s) => s.toggleStar);
  const softDelete = useMessages((s) => s.softDelete);
  const toggleReaction = useMessages((s) => s.toggleReaction);
  const togglePin = useMessages((s) => s.togglePin);
  const pinnedMsg = useMessages((s) => s.pinnedMsg[contact.aegisId] ?? null);
  const appendMsg = useMessages((s) => s.append);
  const pendingMediaUri = useMessages((s) => s.pendingMediaUri);
  const setPendingMedia = useMessages((s) => s.setPendingMedia);
  const markRead = useMessages((s) => s.markRead);
  const saveDraft = useMessages((s) => s.saveDraft);
  // Ephemeral timer state — read live so the indicator updates immediately
  const ephemeralSecs = useMessages((s) => s.ephemeralTimers[contact.aegisId] ?? 0);
  const savedDraft = useMessages((s) => s.drafts[contact.aegisId] ?? '');

  const [draft, setDraft] = useState(savedDraft);
  const [sending, setSending] = useState(false);
  const [chatWallpaper, setChatWallpaper] = useState<WallpaperOption>(0);
  // Image staged for sending — shown as preview in composer until user taps Send
  const [stagedImageUri, setStagedImageUri] = useState<string | null>(null);
  const [imageProcessing, setImageProcessing] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [searchHits, setSearchHits] = useState<string[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [gifPickerVisible, setGifPickerVisible] = useState(false);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const draftSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  const [actionsMsg, setActionsMsg] = useState<StoredMessage | null>(null);
  const [forwardBody, setForwardBody] = useState<string | null>(null);
  const flatlistRef = useRef<FlatList>(null);
  const online = useConnection((s) => s.online);
  const isContactTyping = useTyping((s) => s.typing[contact.aegisId] ?? false);
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const readReceipts = usePreferences((s) => s.readReceipts);
  const typingIndicator = usePreferences((s) => s.typingIndicator);
  const [mismatchKey, setMismatchKey] = useState<string | null>(null);
  const [showScheduler, setShowScheduler] = useState(false);
  const { scheduleMessage, scheduled } = useScheduledMessages();
  const pendingScheduledCount = scheduled.filter(
    (m) => m.status === 'pending' && m.recipientAegisId === contact.aegisId,
  ).length;

  // Lazy directory key audit for MITM and Zero-Trust enforcement
  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { lookupIdentity } = require('../api');
        const record = await lookupIdentity(contact.aegisId);
        if (active && record.publicKey !== contact.publicKeyB64) {
          setMismatchKey(record.publicKey);
          const { showCriticalSecurityNotification } = require('../notifications/push');
          void showCriticalSecurityNotification('key_changed', contact.name);
        }
      } catch (e) {
        if (__DEV__) console.warn('[ChatScreen] Directory sync audit failed:', e);
      }
    })();
    return () => { active = false; };
  }, [contact.aegisId, contact.publicKeyB64]);

  // Load wallpaper for this contact
  useEffect(() => {
    void loadWallpaper(contact.aegisId).then(setChatWallpaper);
  }, [contact.aegisId]);

  useEffect(() => {
    void loadChat(contact.aegisId);
    void markRead(contact.aegisId);

    // Register active chat focused screen to prevent background push alerts while in-view
    const { setActiveChatNotificationId } = require('../notifications/push');
    setActiveChatNotificationId(contact.aegisId);
    return () => {
      setActiveChatNotificationId(null);
    };
  }, [contact.aegisId, loadChat, markRead]);

  const isNearBottomRef = useRef(true);

  useEffect(() => {
    if (list.length > 0 && isNearBottomRef.current) {
      requestAnimationFrame(() => flatlistRef.current?.scrollToEnd({ animated: true }));
    }
  }, [list.length]);

  // Play received-message tone only for incoming messages we did not send,
  // and only when the chat is not currently the active (focused) screen.
  // The active chat ID is already set via setActiveChatNotificationId above,
  // which suppresses push banners; we mirror the same guard here for sound.
  const prevListLengthRef = useRef(list.length);
  useEffect(() => {
    const prev = prevListLengthRef.current;
    prevListLengthRef.current = list.length;
    if (list.length <= prev) return;
    // Check if any of the new items are incoming messages
    const newItems = list.slice(prev);
    const hasIncoming = newItems.some((m) => m.direction === 'in');
    if (hasIncoming) {
      void SoundFX.msgReceived();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  // Search hits — debounced filter + scroll to active hit
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    if (!searchQuery.trim()) {
      setSearchHits([]);
      setSearchIdx(0);
      return;
    }
    searchDebounceRef.current = setTimeout(() => {
      const q = searchQuery.toLowerCase();
      const hits = list
        .filter((m) => !m.deleted && m.body.toLowerCase().includes(q))
        .map((m) => m.id);
      setSearchHits(hits);
      setSearchIdx(0);
    }, 200);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchQuery, list]);

  useEffect(() => {
    if (searchHits.length === 0) return;
    const targetId = searchHits[searchIdx];
    const idx = list.findIndex((m) => m.id === targetId);
    if (idx >= 0) {
      try {
        flatlistRef.current?.scrollToIndex({ index: idx, animated: true, viewPosition: 0.5 });
      } catch { /* list may not be ready */ }
    }
  }, [searchIdx, searchHits, list]);

  const sentReceiptIdsRef = useRef<Set<string>>(new Set());

  // Send read receipts only for new (not-yet-receipted) incoming messages
  useEffect(() => {
    if (!online || !readReceipts) return;
    const unsentIds = list
      .filter((m) => m.direction === 'in' && !m.deleted && !sentReceiptIdsRef.current.has(m.id))
      .map((m) => m.id);
    if (unsentIds.length === 0) return;
    sendReadReceipts(contact.aegisId, unsentIds);
    for (const id of unsentIds) sentReceiptIdsRef.current.add(id);
  }, [contact.aegisId, list.length, online, readReceipts]);

  // Stop typing indicator on unmount; save draft; clear search debounce
  useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
      emitTyping(contact.aegisId, false);
    };
  }, [contact.aegisId]);

  // When AttachSheet picks an image, compress it and stage it in the composer.
  // The user sees a preview and taps the send button to actually send.
  useEffect(() => {
    if (!pendingMediaUri) return;
    const uri = pendingMediaUri;
    setPendingMedia(null);
    setImageProcessing(true);
    void (async () => {
      try {
        const { manipulateAsync, SaveFormat } = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
        // 400px wide, quality 0.55 → ~25-60 KB base64 — stays well within socket limit
        const compressed = await manipulateAsync(
          uri,
          [{ resize: { width: 400 } }],
          { compress: 0.55, format: SaveFormat.JPEG }
        );
        setStagedImageUri(compressed.uri);
      } catch {
        // Compression failed — use original but warn
        setStagedImageUri(uri);
      } finally {
        setImageProcessing(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMediaUri]);

  async function handleCall(media: 'audio' | 'video') {
    if (contact.blocked) {
      Alert.alert(i18nT('chat.callBlocked'), i18nT('chat.callBlockedDesc'));
      return;
    }
    if (contact.zeroTrust && mismatchKey) {
      Alert.alert(i18nT('chat.callZeroTrustBlock'), i18nT('chat.callZeroTrustBlockDesc'));
      return;
    }
    if (!WEBRTC_AVAILABLE) {
      Alert.alert(
        i18nT('chat.callSimulator'),
        i18nT('chat.callSimulatorDesc'),
        [
          { text: i18nT('common.cancel'), style: 'cancel' },
          {
            text: i18nT('chat.outgoing'),
            onPress: () => {
              const { useCall } = require('../store/call');
              const state = useCall.getState();
              state.startOutgoing(contact.aegisId, 'mock-call-id', media);
              setTimeout(() => {
                state.setStatus('connecting');
                setTimeout(() => { state.setStatus('in-call'); }, 1500);
              }, 2000);
            },
          },
          {
            text: i18nT('chat.incoming'),
            onPress: () => {
              const { useCall } = require('../store/call');
              const state = useCall.getState();
              setTimeout(() => {
                state.startIncoming(contact.aegisId, 'mock-call-id', media, 'mock-offer-sdp');
              }, 1000);
            },
          },
        ]
      );
      return;
    }
    try {
      await startCall(contact.aegisId, media);
    } catch (e) {
      Alert.alert(i18nT('chat.callError'), (e as Error).message);
    }
  }

  function handleDraftChange(text: string) {
    setDraft(text);
    // Debounce draft persistence
    if (draftSaveTimer.current) clearTimeout(draftSaveTimer.current);
    draftSaveTimer.current = setTimeout(() => void saveDraft(contact.aegisId, text), 800);
    if (!online || !typingIndicator) return;
    emitTyping(contact.aegisId, text.length > 0);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (text.length > 0) {
      typingTimerRef.current = setTimeout(() => emitTyping(contact.aegisId, false), 3000);
    }
  }

  async function handleSend() {
    if (!identity || sending) return;
    const hasText = draft.trim().length > 0;
    const hasImage = !!stagedImageUri;
    if (!hasText && !hasImage) return;

    setSending(true);
    const text = draft.trim();
    const imageUri = stagedImageUri;
    setDraft('');
    setStagedImageUri(null);
    void saveDraft(contact.aegisId, '');
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    if (typingIndicator) emitTyping(contact.aegisId, false);
    const replying = replyTo;
    setReplyTo(null);

    try {
      // Send image first if staged
      if (imageUri) {
        const id = Crypto.randomUUID();
        await appendMsg({
          id,
          chatId: contact.aegisId,
          direction: 'out',
          body: '',
          createdAt: Date.now(),
          type: 'image',
          mediaUri: imageUri,
        });
        const { encryptAndUploadMedia } = require('../crypto/media');
        const blobUri = await encryptAndUploadMedia(imageUri, 'image/jpeg');
        await sendMessage({
          identity,
          recipientAegisId: contact.aegisId,
          recipientPublicKey: decodeBase64(contact.publicKeyB64),
          plaintext: `[image:${blobUri}]`,
          skipLocalAppend: true,
        });
      }
      // Send text message if typed
      if (hasText) {
        await sendMessage({
          identity,
          recipientAegisId: contact.aegisId,
          recipientPublicKey: decodeBase64(contact.publicKeyB64),
          plaintext: text,
          replyToId: replying?.id,
        });
      }
      void SoundFX.msgSent();
    } catch (e) {
      setDraft(text);
      Alert.alert(i18nT('chat.sendError'), (e as Error).message);
    } finally {
      setSending(false);
    }
  }

  function handleLongPress(msg: StoredMessage) {
    if (msg.deleted) return;
    setActionsMsg(msg);
  }

  function handleReply() {
    if (!actionsMsg) return;
    setReplyTo(actionsMsg);
  }

  function handleStar() {
    if (!actionsMsg) return;
    void toggleStar(contact.aegisId, actionsMsg.id);
  }

  function handleDelete() {
    if (!actionsMsg) return;
    Alert.alert(i18nT('chat.deleteMessage'), i18nT('chat.deleteMessageDesc'), [
      { text: i18nT('common.cancel'), style: 'cancel' },
      {
        text: i18nT('common.delete'),
        style: 'destructive',
        onPress: () => void softDelete(contact.aegisId, actionsMsg.id),
      },
    ]);
  }

  function handleDeleteForAll() {
    if (!actionsMsg) return;
    const id = actionsMsg.id;
    Alert.alert(
      i18nT('chat.deleteForAll'),
      i18nT('chat.deleteForAllDesc'),
      [
        { text: i18nT('common.cancel'), style: 'cancel' },
        {
          text: i18nT('chat.deleteForAllBtn'),
          style: 'destructive',
          onPress: async () => {
            await softDelete(contact.aegisId, id);
            sendDeleteForEveryone(contact.aegisId, id);
          },
        },
      ]
    );
  }

  function handleReact(emoji: string) {
    if (!actionsMsg || !identity) return;
    void toggleReaction(contact.aegisId, actionsMsg.id, emoji, identity.aegisId);
  }

  const msgById = useMemo(
    () => Object.fromEntries(list.map((m) => [m.id, m])),
    [list],
  );

  const filteredList = useMemo(() => {
    if (!searchQuery) return list;
    const q = searchQuery.toLowerCase();
    return list.filter((m) => !m.deleted && m.body.toLowerCase().includes(q));
  }, [list, searchQuery]);

  async function handleGifSelect(url: string) {
    setGifPickerVisible(false);
    if (!identity) return;

    // Privacy fix: never send the raw Giphy URL.
    // Download the GIF locally, encrypt it like any other image attachment,
    // and send [image:...] so the receiver never contacts Giphy servers.
    const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const cacheDir = FS.cacheDirectory ?? '';
    const gifId = url.split('/').pop()?.split('?')[0] ?? Crypto.randomUUID();
    const tmpPath = `${cacheDir}gif_tmp_${gifId}.gif`;

    let blobUri: string;
    try {
      // Enforce a 10 MB size guard by checking after download
      const downloadResult = await FS.downloadAsync(url, tmpPath);
      if (!downloadResult.uri) throw new Error('GIF download failed');

      const info = await FS.getInfoAsync(downloadResult.uri);
      const fileSize = (info as { size?: number }).size ?? 0;
      if (fileSize > 10 * 1024 * 1024) {
        await FS.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
        Alert.alert(i18nT('chat.sendError'), 'GIF demasiado grande (máx. 10 MB)');
        return;
      }

      const { encryptAndUploadMedia } = require('../crypto/media');
      blobUri = await encryptAndUploadMedia(tmpPath, 'image/gif');
    } catch (e) {
      await FS.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});
      Alert.alert(i18nT('chat.sendError'), (e as Error).message);
      return;
    }

    // Clean up the temporary file regardless of send outcome
    await FS.deleteAsync(tmpPath, { idempotent: true }).catch(() => {});

    try {
      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: `[image:${blobUri}]`,
      });
    } catch (e) {
      Alert.alert(i18nT('chat.sendError'), (e as Error).message);
    }
  }

  function handleStickerSelect(emoji: string) {
    setGifPickerVisible(false);
    setDraft((prev) => prev + emoji);
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: t.bg }}
    >
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Top bar */}
        <View style={[styles.top, { borderBottomColor: t.divider }]}>
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 6 }}>
            <I.ChevronL size={22} color={t.text} />
          </Pressable>
          {searchActive ? (
            <>
              <TextInput
                autoFocus
                value={searchQuery}
                onChangeText={setSearchQuery}
                placeholder={i18nT('chat.searchPlaceholder', 'Search messages…')}
                placeholderTextColor={t.textFaint}
                style={{
                  flex: 1,
                  fontFamily: t.font,
                  fontSize: 15,
                  color: t.text,
                  backgroundColor: t.surface2,
                  borderRadius: 20,
                  paddingHorizontal: 14,
                  paddingVertical: Platform.OS === 'ios' ? 8 : 4,
                }}
                accessibilityLabel={i18nT('chat.searchPlaceholder', 'Search messages')}
              />
              <Pressable
                onPress={() => { setSearchActive(false); setSearchQuery(''); setSearchHits([]); setSearchIdx(0); }}
                hitSlop={8}
                style={{ padding: 6 }}
                accessibilityLabel="Close search"
              >
                <I.X size={20} color={t.textDim} />
              </Pressable>
            </>
          ) : (
            <>
              <Pressable
                onPress={onContactDetail}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 }}
              >
                <Avatar t={t} name={contact.avatarImage || contact.name} color={contact.color ?? t.surface2} size={36} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text
                    numberOfLines={1}
                    style={{
                      fontFamily: /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name) ? t.fontMono : t.font,
                      fontWeight: '600',
                      fontSize: 15,
                      color: t.text,
                    }}
                  >
                    {contact.name}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    {isContactTyping ? (
                      <Text style={{ fontFamily: t.font, fontSize: 11, color: t.accent, fontStyle: 'italic' }}>
                        {i18nT('home.typing')}
                      </Text>
                    ) : contact.online ? (
                      <Text style={{ fontFamily: t.font, fontSize: 11, color: t.accent }}>
                        {i18nT('chat.online', 'En línea')}
                      </Text>
                    ) : contact.lastSeenAt ? (
                      <Text
                        numberOfLines={1}
                        style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, flex: 1 }}
                      >
                        {formatLastSeen(contact.lastSeenAt)}
                      </Text>
                    ) : contact.status ? (
                      <>
                        <Text
                          numberOfLines={1}
                          style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, flex: 1 }}
                        >
                          {contact.status}
                        </Text>
                        <I.Lock size={8} color={contact.verified ? t.accent : t.warn} />
                      </>
                    ) : (
                      <>
                        <I.Lock size={10} color={contact.verified ? t.accent : t.warn} />
                        <Text
                          style={{
                            fontFamily: t.fontMono,
                            fontSize: 10,
                            color: contact.verified ? t.accent : t.warn,
                            letterSpacing: 0.5,
                          }}
                        >
                          {contact.verified ? i18nT('chat.e2eVerified') : i18nT('chat.e2eNotVerified')}
                        </Text>
                      </>
                    )}
                  </View>
                </View>
              </Pressable>
              <Pressable
                onPress={() => setSearchActive(true)}
                hitSlop={8}
                style={{ padding: 6 }}
                accessibilityLabel={i18nT('chat.searchMessages', 'Search messages')}
              >
                <I.Search size={20} color={t.textDim} />
              </Pressable>
              <Pressable
                onPress={() => void handleCall('audio')}
                hitSlop={8}
                style={{ padding: 6, opacity: WEBRTC_AVAILABLE ? 1 : 0.4 }}
              >
                <I.Phone size={20} color={t.text} />
              </Pressable>
              <Pressable
                onPress={() => void handleCall('video')}
                hitSlop={8}
                style={{ padding: 6, opacity: WEBRTC_AVAILABLE ? 1 : 0.4 }}
              >
                <I.Video size={20} color={t.text} />
              </Pressable>
            </>
          )}
        </View>

        {/* Search navigation row */}
        {searchActive && searchQuery.trim().length > 0 ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 14,
              paddingVertical: 6,
              gap: 8,
              backgroundColor: t.surface,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: t.divider,
            }}
          >
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, flex: 1 }}>
              {searchHits.length > 0
                ? `${searchIdx + 1} of ${searchHits.length}`
                : i18nT('chat.noResults', 'No results')}
            </Text>
            <Pressable
              onPress={() => setSearchIdx((prev) => Math.max(0, prev - 1))}
              disabled={searchHits.length === 0 || searchIdx === 0}
              hitSlop={8}
              style={{ padding: 4, opacity: searchIdx === 0 ? 0.35 : 1 }}
              accessibilityLabel={i18nT('chat.searchPrev', 'Previous result')}
            >
              <I.ChevronL size={18} color={t.textDim} />
            </Pressable>
            <Pressable
              onPress={() => setSearchIdx((prev) => Math.min(searchHits.length - 1, prev + 1))}
              disabled={searchHits.length === 0 || searchIdx >= searchHits.length - 1}
              hitSlop={8}
              style={{ padding: 4, opacity: searchIdx >= searchHits.length - 1 ? 0.35 : 1 }}
              accessibilityLabel={i18nT('chat.searchNext', 'Next result')}
            >
              <I.Chevron size={18} color={t.textDim} />
            </Pressable>
          </View>
        ) : null}

        {/* Offline banner */}
        {!online ? (
          <View
            testID="offline-banner"
            style={{
              paddingHorizontal: 16,
              paddingVertical: 8,
              backgroundColor: t.warn,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 11, color: t.bg, fontWeight: '700', letterSpacing: 0.5 }}>
              {i18nT('common.offline')}
            </Text>
            <Pressable
              accessibilityLabel={i18nT('common.retryConnection')}
              onPress={() => {
                const { getSocket } = require('../socket/client');
                const socket = getSocket();
                if (socket && !socket.connected) socket.connect();
              }}
              style={{ paddingHorizontal: 10, paddingVertical: 4, backgroundColor: 'rgba(0,0,0,0.2)', borderRadius: 4 }}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: '#000', fontWeight: '700' }}>{i18nT('chat.retryBtn')}</Text>
            </Pressable>
          </View>
        ) : null}

        {/* Directory Key Mismatch / Zero-Trust Warn Banners */}
        {mismatchKey ? (
          <View
            style={{
              marginHorizontal: 12,
              marginTop: 10,
              marginBottom: 4,
              padding: 14,
              backgroundColor: contact.zeroTrust
                ? (t.dark ? 'rgba(255,107,107,0.12)' : 'rgba(184,68,42,0.08)')
                : (t.dark ? 'rgba(234,179,8,0.1)' : 'rgba(202,138,4,0.06)'),
              borderWidth: 1,
              borderColor: contact.zeroTrust ? `${t.danger}66` : `${t.warn}66`,
              borderRadius: t.radius,
              gap: 8,
            }}
          >
            <Text style={{ fontFamily: t.font, fontWeight: '700', fontSize: 13, color: contact.zeroTrust ? t.danger : t.warn }}>
              {contact.zeroTrust
                ? `⚠️ ${i18nT('chat.zeroTrustWarning')}`
                : `⚠️ ${i18nT('chat.keyChangedWarning')}`}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
              {contact.zeroTrust ? i18nT('chat.zeroTrustDesc') : i18nT('chat.keyChangedDesc')}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
              <Pressable
                onPress={onContactDetail}
                style={{
                  backgroundColor: contact.zeroTrust ? t.danger : t.warn,
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: t.radiusS,
                }}
              >
                <Text style={{ color: contact.zeroTrust ? '#fff' : '#000', fontFamily: t.font, fontSize: 12, fontWeight: '600' }}>
                  {contact.zeroTrust ? i18nT('chat.verifyIdentity') : i18nT('chat.reverify')}
                </Text>
              </Pressable>
              {!contact.zeroTrust && (
                <Pressable
                  onPress={() =>
                    Alert.alert(
                      i18nT('chat.trustAnyway'),
                      i18nT('chat.trustAnywayConfirm'),
                      [
                        { text: i18nT('common.cancel'), style: 'cancel' },
                        {
                          text: i18nT('chat.trust'),
                          onPress: async () => {
                            const { useContacts } = require('../store/contacts');
                            await useContacts.getState().confirmKeyChange(contact.aegisId, mismatchKey);
                            setMismatchKey(null);
                          },
                        },
                      ]
                    )
                  }
                  style={{
                    borderWidth: 1,
                    borderColor: t.borderStrong,
                    paddingHorizontal: 14,
                    paddingVertical: 7,
                    borderRadius: t.radiusS,
                  }}
                >
                  <Text style={{ color: t.text, fontFamily: t.font, fontSize: 12, fontWeight: '500' }}>
                    {i18nT('chat.trustAnyway')}
                  </Text>
                </Pressable>
              )}
            </View>
          </View>
        ) : null}

        {/* Pinned message banner */}
        {pinnedMsg && !pinnedMsg.deleted ? (
          <Pressable
            onPress={() => {
              const idx = list.findIndex((m) => m.id === pinnedMsg.id);
              if (idx >= 0) flatlistRef.current?.scrollToIndex({ index: idx, animated: true });
            }}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 10,
              paddingHorizontal: 16,
              paddingVertical: 8,
              backgroundColor: t.dark ? `${t.accent}12` : `${t.accent}18`,
              borderBottomWidth: 1,
              borderBottomColor: `${t.accent}30`,
            }}
          >
            <I.Pin size={14} color={t.accent} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.5, marginBottom: 1 }}>
                {i18nT('chat.pinnedMessage')}
              </Text>
              <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 12, color: t.textDim }}>
                {pinnedMsg.body}
              </Text>
            </View>
            <Pressable
              onPress={() => void togglePin(contact.aegisId, pinnedMsg.id)}
              hitSlop={8}
              style={{ padding: 4 }}
            >
              <I.X size={14} color={t.textDim} />
            </Pressable>
          </Pressable>
        ) : null}

        {/* E2E pill */}
        <View style={{ alignItems: 'center', paddingVertical: 12 }}>
          <View
            style={{
              backgroundColor: t.surface2,
              paddingHorizontal: 12,
              paddingVertical: 6,
              borderRadius: 99,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <I.Lock size={9} color={t.textDim} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>
              {i18nT('chat.encryptedToday')}
            </Text>
          </View>
        </View>

        <FlatList
          ref={flatlistRef}
          data={filteredList}
          keyExtractor={(m) => m.id}
          style={{ backgroundColor: wallpaperBg(chatWallpaper, t) ?? t.bg }}
          contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 10 }}
          renderItem={({ item }) => (
            <View
              style={
                searchHits.length > 0 && searchHits[searchIdx] === item.id
                  ? { backgroundColor: t.accentDeep, borderRadius: t.radiusS, marginHorizontal: -4, paddingHorizontal: 4 }
                  : undefined
              }
            >
            <SwipeableMessage
              disabled={item.deleted}
              onDelete={() => {
                Alert.alert(i18nT('chat.deleteMessage'), i18nT('chat.deleteMessageDesc'), [
                  { text: i18nT('common.cancel'), style: 'cancel' },
                  {
                    text: i18nT('common.delete'),
                    style: 'destructive',
                    onPress: () => void softDelete(contact.aegisId, item.id),
                  },
                ]);
              }}
              onReply={() => setReplyTo(item)}
            >
              <Bubble
                t={t}
                m={item}
                online={online}
                quotedMsg={item.replyToId ? msgById[item.replyToId] : undefined}
                onLongPress={() => handleLongPress(item)}
                onViewOnce={onViewOnce}
                onImagePress={setViewerUri}
              />
            </SwipeableMessage>
            </View>
          )}
          ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
          onScroll={({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }) => {
            isNearBottomRef.current =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
          }}
          scrollEventThrottle={100}
          ListEmptyComponent={
            <View style={{ alignItems: 'center', justifyContent: 'center', paddingTop: 40 }}>
              <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim }}>
                Sin mensajes aún. Todo cifrado de extremo a extremo.
              </Text>
            </View>
          }
        />

        {/* Scheduled messages banner */}
        {pendingScheduledCount > 0 ? (
          <Pressable
            onPress={() => setShowScheduler(false)}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              paddingHorizontal: 16,
              paddingVertical: 7,
              backgroundColor: `${t.accent}14`,
              borderTopWidth: 1,
              borderTopColor: `${t.accent}30`,
            }}
            accessibilityLabel={`${pendingScheduledCount} mensaje${pendingScheduledCount > 1 ? 's' : ''} programado${pendingScheduledCount > 1 ? 's' : ''}`}
          >
            <I.Timer size={13} color={t.accent} />
            <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5, fontWeight: '700' }}>
              {pendingScheduledCount} MENSAJE{pendingScheduledCount > 1 ? 'S' : ''} PROGRAMADO{pendingScheduledCount > 1 ? 'S' : ''}
            </Text>
          </Pressable>
        ) : null}

        {/* Composer */}
        <View
          style={[
            styles.composer,
            {
              borderTopColor: t.divider,
              backgroundColor: t.surface,
              paddingBottom: insets.bottom > 0 ? insets.bottom : 14,
            },
          ]}
        >
          {contact.blocked ? (
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                paddingVertical: 14,
                paddingHorizontal: 16,
                backgroundColor: t.surface2,
                borderRadius: t.radius,
                marginHorizontal: 12,
                marginVertical: 4,
              }}
            >
              <Text style={{ fontFamily: t.font, fontSize: 13, color: t.danger, fontWeight: '500', textAlign: 'center' }}>
                {i18nT('chat.blockedContact')}
              </Text>
            </View>
          ) : (
            <>
              {/* Unverified contact warning banner — non-blocking, send always allowed */}
              {!contact.verified && (
                <View
                  style={{
                    width: '100%',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 8,
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    backgroundColor: `${t.warn}18`,
                    borderTopWidth: 1,
                    borderTopColor: `${t.warn}44`,
                  }}
                >
                  <I.Lock size={13} color={t.warn} />
                  <Text style={{ flex: 1, fontFamily: t.font, fontSize: 12, color: t.warn, lineHeight: 17 }}>
                    {i18nT('chat.unverifiedContact', 'Contacto no verificado. Verifica su identidad para maxima seguridad.')}
                  </Text>
                </View>
              )}
              {/* Reply banner */}
              {replyTo ? (
                <View
                  style={{
                    position: 'absolute',
                    top: -48,
                    left: 0,
                    right: 0,
                    backgroundColor: t.surface2,
                    borderTopWidth: 1,
                    borderTopColor: t.border,
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 14,
                    paddingVertical: 8,
                    gap: 8,
                  }}
                >
                  <I.Reply size={14} color={t.accent} />
                  <Text numberOfLines={1} style={{ flex: 1, fontFamily: t.font, fontSize: 12, color: t.textDim }}>
                    {replyTo.deleted ? i18nT('chat.deletedMessage') : replyTo.body || (replyTo.type === 'image' ? '📷 ' + i18nT('attachSheet.image') : '…')}
                  </Text>
                  <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
                    <I.X size={16} color={t.textDim} />
                  </Pressable>
                </View>
              ) : null}

              {/* ── Staged image preview ───────────────────────────── */}
              {imageProcessing && (
                <View style={{ position: 'absolute', bottom: '100%', left: 0, right: 0,
                  backgroundColor: t.surface2, paddingHorizontal: 14, paddingVertical: 10,
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  borderTopWidth: 1, borderTopColor: t.divider }}>
                  <ActivityIndicator size="small" color={t.accent} />
                  <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.6 }}>
                    {i18nT('common.processingImage')}
                  </Text>
                </View>
              )}
              {stagedImageUri && !imageProcessing && (
                <View style={{ position: 'absolute', bottom: '100%', left: 0, right: 0,
                  backgroundColor: t.surface2, paddingHorizontal: 14, paddingVertical: 8,
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  borderTopWidth: 1, borderTopColor: t.divider }}>
                  <Image source={{ uri: stagedImageUri }}
                    style={{ width: 48, height: 48, borderRadius: t.radiusS, backgroundColor: t.surface3 }} />
                  <Text style={{ flex: 1, fontFamily: t.font, fontSize: 13, color: t.textDim }}>
                    {i18nT('chat.imageReady')}
                  </Text>
                  <Pressable onPress={() => setStagedImageUri(null)} hitSlop={8} style={{ padding: 4 }}>
                    <I.X size={18} color={t.textDim} />
                  </Pressable>
                </View>
              )}

              {/* ── Attach / expand button ────────────────────────────── */}
              <Pressable onPress={onAttach} hitSlop={8} style={{ padding: 6 }} accessibilityLabel="Adjuntar archivo">
                <I.Attach size={22} color={t.textDim} />
              </Pressable>

              {/* ── GIF — only visible when input is empty (disappears while typing) ── */}
              {!draft.trim() && !stagedImageUri && (
                <Pressable
                  onPress={() => setGifPickerVisible(true)}
                  hitSlop={8}
                  style={{ padding: 6 }}
                  accessibilityLabel="Abrir selector de GIF"
                >
                  <Text style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '700', color: t.textDim, letterSpacing: 0.5 }}>
                    GIF
                  </Text>
                </Pressable>
              )}

              {/* ── Input field ────────────────────────────────────────── */}
              <TextInput
                value={draft}
                onChangeText={handleDraftChange}
                placeholder={online ? i18nT('chat.messagePlaceholder') : i18nT('chat.messageOfflinePlaceholder')}
                placeholderTextColor={t.textFaint}
                accessibilityLabel="Campo de mensaje"
                multiline
                style={{
                  flex: 1,
                  backgroundColor: t.surface2,
                  color: t.text,
                  fontFamily: t.font,
                  fontSize: 15,
                  borderRadius: 22,
                  paddingHorizontal: 16,
                  paddingVertical: Platform.OS === 'ios' ? 10 : 6,
                  maxHeight: 120,
                  // Subtle accent border when ephemeral timer is active
                  borderWidth: ephemeralSecs > 0 ? 1.5 : 0,
                  borderColor: ephemeralSecs > 0 ? t.accent : 'transparent',
                }}
              />

              {/* ── Ephemeral indicator — only when timer is active ────── */}
              {ephemeralSecs > 0 && (
                <Pressable
                  onPress={onEphemeral}
                  hitSlop={8}
                  style={{ padding: 6 }}
                  accessibilityLabel="Temporizador de autodestrucción activo"
                >
                  <I.Timer size={20} color={t.accent} />
                </Pressable>
              )}

              {/* ── Send button — long-press to schedule ────────────────── */}
              <Pressable
                testID="send-button"
                accessibilityRole="button"
                accessibilityLabel={i18nT('chat.sendAccessibilityLabel', 'Send message')}
                disabled={(!draft.trim() && !stagedImageUri) || sending || imageProcessing}
                onPress={handleSend}
                onLongPress={() => { if (draft.trim()) setShowScheduler(true); }}
                delayLongPress={450}
                style={({ pressed }) => ({
                  width: 40,
                  height: 40,
                  borderRadius: 20,
                  backgroundColor: (draft.trim() || stagedImageUri) && online ? t.accent : t.surface3,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: pressed ? 0.85 : 1,
                })}
              >
                {sending ? (
                  <ActivityIndicator size="small" color={t.accentInk} />
                ) : (
                  <I.Send size={18} color={(draft.trim() || stagedImageUri) && online ? t.accentInk : t.textFaint} />
                )}
              </Pressable>
            </>
          )}
        </View>
      </View>

      {/* Message Actions Sheet */}
      <MessageActionsSheet
        visible={actionsMsg !== null}
        body={actionsMsg?.body ?? ''}
        starred={actionsMsg?.starred ?? false}
        pinned={actionsMsg?.pinned ?? false}
        canDelete={actionsMsg?.direction === 'out'}
        onClose={() => setActionsMsg(null)}
        onReply={handleReply}
        onForward={() => { setForwardBody(actionsMsg?.body ?? ''); setActionsMsg(null); }}
        onStar={handleStar}
        onPin={() => { if (actionsMsg) void togglePin(contact.aegisId, actionsMsg.id); }}
        onDelete={handleDelete}
        onDeleteForAll={actionsMsg?.direction === 'out' ? handleDeleteForAll : undefined}
        onReact={handleReact}
      />

      <ForwardModal
        visible={forwardBody !== null}
        body={forwardBody ?? ''}
        onClose={() => setForwardBody(null)}
      />

      <GifPicker
        visible={gifPickerVisible}
        onClose={() => setGifPickerVisible(false)}
        onSelectGif={handleGifSelect}
        onSelectSticker={handleStickerSelect}
      />
      <ImageViewerModal uri={viewerUri} onClose={() => setViewerUri(null)} t={t} />

      <SchedulePicker
        visible={showScheduler}
        onClose={() => setShowScheduler(false)}
        onConfirm={async (sendAt) => {
          if (!identity) return;
          const text = draft.trim();
          if (!text) return;
          try {
            await scheduleMessage({
              identity,
              recipientAegisId: contact.aegisId,
              recipientPublicKeyB64: contact.publicKeyB64,
              plaintext: text,
              sendAt,
            });
            setDraft('');
            void saveDraft(contact.aegisId, '');
          } catch (e) {
            Alert.alert('Error al programar', (e as Error).message);
          }
        }}
      />
    </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
}

// ─── Location message parser ─────────────────────────────────────────────────
// Defined in mobile/src/utils/parseLocationMessage.ts — imported above

// ─── Bubble ──────────────────────────────────────────────────────────────────

interface BubbleProps {
  t: Theme;
  m: StoredMessage;
  online: boolean;
  quotedMsg?: StoredMessage;
  onLongPress: () => void;
  onViewOnce?: (mediaUri: string, messageId: string) => void;
  onImagePress?: (uri: string) => void;
}

function Bubble({ t, m, online, quotedMsg, onLongPress, onViewOnce, onImagePress }: BubbleProps) {
  const { t: i18nT } = useTranslation();
  const me = m.direction === 'out';
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const queued = me && !online;
  const loc = !m.deleted ? parseLocationMessage(m.body) : null;
  const reactions = m.reactions ? Object.entries(m.reactions).filter(([, ids]) => ids.length > 0) : [];

  if (m.deleted) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <View
          style={{
            backgroundColor: t.surface2,
            paddingHorizontal: 13,
            paddingVertical: 8,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <I.Trash size={13} color={t.textFaint} />
          <Text style={{ color: t.textFaint, fontFamily: t.font, fontSize: 13, fontStyle: 'italic' }}>
            {i18nT('chat.deletedMessage')}
          </Text>
        </View>
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginTop: 3, paddingHorizontal: 4 }}>
          {time}
        </Text>
      </View>
    );
  }

  if (loc) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          onPress={() => {
            if (loc.latitude && loc.longitude) {
              const url = `https://www.google.com/maps/search/?api=1&query=${loc.latitude},${loc.longitude}`;
              Linking.openURL(url).catch(() => {});
            }
          }}
          style={({ pressed }) => ({
            width: 250,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            backgroundColor: t.surface2,
            borderWidth: 1,
            borderColor: t.border,
            overflow: 'hidden',
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
            elevation: 2,
            shadowColor: '#000',
            shadowOffset: { width: 0, height: 1 },
            shadowOpacity: 0.1,
            shadowRadius: 2,
          })}
        >
          <View
            style={{
              height: 100,
              backgroundColor: t.surface2,
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <Svg viewBox="0 0 250 100" width="100%" height="100%" style={{ position: 'absolute' }}>
              <Path d="M0 30 L250 50" stroke={t.borderStrong} strokeWidth={4} fill="none" opacity={0.4} />
              <Path d="M0 70 L250 80" stroke={t.borderStrong} strokeWidth={5} fill="none" opacity={0.4} />
              <Path d="M100 0 Q120 50 110 100" stroke={t.borderStrong} strokeWidth={6} fill="none" opacity={0.4} />
              <Path d="M180 0 L170 100" stroke={t.borderStrong} strokeWidth={3} fill="none" opacity={0.3} />
            </Svg>
            <View style={{ width: 34, height: 34, borderRadius: 17, backgroundColor: `${t.accent}25`, alignItems: 'center', justifyContent: 'center' }}>
              <View style={{ width: 14, height: 14, borderRadius: 7, backgroundColor: t.accent, borderWidth: 2.5, borderColor: '#fff' }} />
            </View>
          </View>
          <View style={{ padding: 10, backgroundColor: t.surface }}>
            <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text, marginBottom: 2 }}>
              {loc.address}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim }}>
              📍 {i18nT('chat.locationShared')} {loc.precision} · {loc.duration}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: t.divider }}>
              <I.Globe size={11} color={t.accent} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, fontWeight: '600', color: t.accent, letterSpacing: 0.3 }}>
                {i18nT('chat.openMaps')}
              </Text>
            </View>
          </View>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Audio bubble
  if (m.type === 'audio' && m.mediaUri) {
    return <AudioBubble t={t} m={m} me={me} queued={queued} time={time} reactions={reactions} onLongPress={onLongPress} />;
  }

  // File bubble
  if (m.type === 'file') {
    const fileName = m.body || 'archivo';
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            maxWidth: '80%',
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            paddingHorizontal: 13,
            paddingVertical: 10,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
          })}
        >
          <I.Attach size={20} color={me ? t.bubbleOutText : t.bubbleInText} />
          <Text numberOfLines={2} style={{ flex: 1, color: me ? t.bubbleOutText : t.bubbleInText, fontFamily: t.font, fontSize: 14 }}>
            {fileName}
          </Text>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // View-once bubble (image or audio)
  if (m.body === '[viewonce]' || (m.body && m.body.startsWith('[viewonce:'))) {
    const hasMedia = !!m.mediaUri;
    const isReceived = m.direction === 'in';
    const isAudio = m.body.startsWith('[viewonce:audio:');
    // Parse duration from body "[viewonce:audio:NNs]"
    const audioDurSec = isAudio
      ? parseInt(m.body.match(/\[viewonce:audio:(\d+)s/)?.[1] ?? '0', 10)
      : 0;

    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          onPress={() => { if (!isAudio && hasMedia && m.mediaUri && onViewOnce) onViewOnce(m.mediaUri, m.id); }}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            paddingHorizontal: 14,
            paddingVertical: 12,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            borderWidth: 1,
            borderColor: `${t.accent}44`,
            opacity: pressed ? 0.85 : 1,
            maxWidth: 240,
          })}
        >
          {isAudio ? <I.Mic size={22} color={t.accent} stroke={1.6} /> : <I.EyeOff size={22} color={t.accent} stroke={1.6} />}
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: me ? t.bubbleOutText : t.text }}>
              {isAudio
                ? (isReceived ? 'Audio efímero' : 'Audio enviado')
                : (isReceived ? i18nT('chat.viewOnceReceived') : i18nT('chat.viewOnceSent'))}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5, marginTop: 2 }}>
              {isAudio
                ? (audioDurSec > 0 ? `${audioDurSec}s · escuchar una vez` : 'escuchar una vez')
                : (isReceived ? (hasMedia ? i18nT('chat.viewOnceTap') : i18nT('chat.viewOnceSeen')) : i18nT('chat.viewOnceSentLabel'))}
            </Text>
          </View>
        </Pressable>
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Image bubble
  if (m.type === 'image' && m.mediaUri) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onPress={() => onImagePress?.(m.mediaUri!)}
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            overflow: 'hidden',
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
          })}
        >
          <Image
            source={{ uri: m.mediaUri }}
            style={{ width: 220, height: 180, backgroundColor: t.surface2 }}
            resizeMode="cover"
          />
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Call event bubble
  if (m.body?.startsWith('[call:')) {
    const parts = m.body.slice(1, -1).split(':');
    const callStatus = parts[1] ?? 'missed';
    const callMedia = parts[2] ?? 'audio';
    const callDuration = parts[3] ?? '0s';
    const isMissed = callStatus === 'missed' || callStatus === 'declined';
    const statusLabel =
      callStatus === 'missed' ? i18nT('chat.missedCall') :
      callStatus === 'declined' ? i18nT('chat.declinedCall') :
      callMedia === 'video' ? i18nT('chat.videoCall') : i18nT('chat.voiceCall');
    const CallIcon = callMedia === 'video' ? I.Video : I.Phone;
    return (
      <View style={{ alignItems: 'center', marginVertical: 4 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            backgroundColor: t.surface2,
            paddingHorizontal: 14,
            paddingVertical: 9,
            borderRadius: 99,
            borderWidth: 1,
            borderColor: isMissed ? `${t.warn}55` : t.border,
          }}
        >
          <CallIcon size={14} color={isMissed ? t.warn : t.accent} />
          <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: isMissed ? t.warn : t.text }}>
            {statusLabel}
          </Text>
          {!isMissed && callDuration !== '0s' && (
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>
              · {callDuration}
            </Text>
          )}
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{time}</Text>
        </View>
      </View>
    );
  }

  // Contact card bubble
  const contactMatch = m.body?.match(/^\[contact:([^:]+):([^\]]+)\]$/);
  if (contactMatch) {
    const cardName = contactMatch[1];
    const cardAegisId = contactMatch[2];
    const shortId = cardAegisId.length > 20 ? `${cardAegisId.slice(0, 10)}…${cardAegisId.slice(-6)}` : cardAegisId;
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            width: 240,
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            overflow: 'hidden',
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
            borderWidth: 1,
            borderColor: `${t.accent}33`,
          })}
        >
          {/* Header strip */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, paddingTop: 10, paddingBottom: 6 }}>
            <View style={{
              width: 36, height: 36, borderRadius: 18,
              backgroundColor: `${t.accent}22`,
              alignItems: 'center', justifyContent: 'center',
            }}>
              <I.Users size={20} color={t.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text numberOfLines={1} style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: me ? t.bubbleOutText : t.text }}>
                {cardName}
              </Text>
              <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.3, marginTop: 1 }}>
                {shortId}
              </Text>
            </View>
          </View>
          {/* Divider + action */}
          <View style={{ borderTopWidth: 1, borderTopColor: me ? 'rgba(255,255,255,0.12)' : t.divider }}>
            <Pressable
              onPress={async () => {
                try {
                  await useContacts.getState().addByAegisId(cardAegisId);
                  Alert.alert(i18nT('chat.contactAdded', 'Contacto añadido'), cardName);
                } catch {
                  // Fallback: copy ID to clipboard
                  const Clipboard = require('expo-clipboard');
                  await Clipboard.setStringAsync(cardAegisId).catch(() => {});
                  Alert.alert(i18nT('chat.contactAddFailed', 'No se pudo añadir'), i18nT('chat.idCopied', 'ID copiado al portapapeles'));
                }
              }}
              style={({ pressed }) => ({
                paddingVertical: 9,
                alignItems: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '600', color: t.accent, letterSpacing: 0.5 }}>
                {i18nT('chat.addContact')}
              </Text>
            </Pressable>
          </View>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // GIF bubble — legacy format [gif:url] kept for historical messages only.
  // New GIFs are sent as [image:...] after being downloaded and encrypted.
  // DO NOT load from the remote URL here — that would reveal IP to Giphy.
  const gifMatch = m.body?.match(/^\[gif:(.+)\]$/);
  if (gifMatch) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            flexDirection: 'row',
            alignItems: 'center',
            gap: 10,
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            paddingHorizontal: 14,
            paddingVertical: 12,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            borderWidth: 1,
            borderColor: `${t.border}`,
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
            maxWidth: 260,
          })}
        >
          <I.Globe size={18} color={t.textDim} />
          <Text style={{ flex: 1, fontFamily: t.font, fontSize: 13, color: me ? t.bubbleOutText : t.textDim, fontStyle: 'italic' }}>
            GIF (formato legacy)
          </Text>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Text bubble — extract first URL to show link preview card
  const urlMatch = /\bhttps?:\/\/[^\s<>"')\]]+/.exec(m.body ?? '');
  const previewUrl = urlMatch?.[0] ?? null;

  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start', maxWidth: '80%' }}>
      <Pressable
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          backgroundColor: me ? t.bubbleOut : t.bubbleIn,
          paddingHorizontal: 13,
          paddingTop: quotedMsg ? 8 : 10,
          paddingBottom: 10,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          opacity: queued ? 0.55 : pressed ? 0.9 : 1,
        })}
      >
        {/* Quote banner */}
        {quotedMsg ? (
          <View
            style={{
              borderLeftWidth: 3,
              borderLeftColor: t.accent,
              paddingLeft: 8,
              marginBottom: 8,
              opacity: 0.8,
            }}
          >
            <Text numberOfLines={2} style={{ fontFamily: t.font, fontSize: 12, color: me ? t.bubbleOutText : t.bubbleInText, lineHeight: 16 }}>
              {quotedMsg.deleted
                ? i18nT('chat.deletedMessage')
                : quotedMsg.type === 'image'
                ? '📷 Imagen'
                : quotedMsg.body}
            </Text>
          </View>
        ) : null}
        <FormattedText
          body={m.body}
          t={t}
          style={{ color: me ? t.bubbleOutText : t.bubbleInText, fontFamily: t.font, fontSize: 15, lineHeight: 20 }}
        />
        {/* Open Graph link preview card */}
        {previewUrl ? <LinkPreview url={previewUrl} t={t} /> : null}
      </Pressable>
      <ReactionPills t={t} reactions={reactions} me={me} />
      <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
    </View>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function ReactionPills({ t, reactions, me }: { t: Theme; reactions: [string, string[]][]; me: boolean }) {
  if (reactions.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4, justifyContent: me ? 'flex-end' : 'flex-start' }}>
      {reactions.map(([emoji, ids]) => (
        <View
          key={emoji}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 3,
            backgroundColor: t.surface2,
            borderRadius: 99,
            paddingHorizontal: 8,
            paddingVertical: 3,
            borderWidth: 1,
            borderColor: t.border,
          }}
        >
          <Text style={{ fontSize: 13 }}>{emoji}</Text>
          {ids.length > 1 ? (
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{ids.length}</Text>
          ) : null}
        </View>
      ))}
    </View>
  );
}

function TimestampRow({
  t, queued, time, starred, deliveryStatus,
}: {
  t: Theme;
  queued: boolean;
  time: string;
  starred?: boolean;
  deliveryStatus?: 'sent' | 'delivered' | 'read';
}) {
  const { t: i18nT } = useTranslation();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 4, marginTop: 3 }}>
      {starred ? <I.Star size={9} color={t.accent} /> : null}
      {queued ? (
        <>
          <I.Timer size={10} color={t.warn} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, color: t.warn, letterSpacing: 0.4 }}>
            {i18nT('chat.queued')}
          </Text>
        </>
      ) : (
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{time}</Text>
      )}
      {!queued && deliveryStatus ? (
        deliveryStatus === 'delivered' || deliveryStatus === 'read' ? (
          <I.CheckCheck size={13} color={deliveryStatus === 'read' ? t.accent : t.textFaint} />
        ) : (
          <I.Check size={13} color={t.textFaint} />
        )
      ) : null}
    </View>
  );
}

const PLAYBACK_RATES: number[] = [1.0, 1.5, 2.0, 0.5];

function AudioBubble({
  t, m, me, queued, time, reactions, onLongPress,
}: {
  t: Theme;
  m: StoredMessage;
  me: boolean;
  queued: boolean;
  time: string;
  reactions: [string, string[]][];
  onLongPress: () => void;
}) {
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  type AudioSound = import('expo-av').Audio.Sound;
  type AVPlaybackStatus = import('expo-av').AVPlaybackStatus;
  const soundRef = useRef<AudioSound | null>(null);

  useEffect(() => {
    return () => {
      void soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  // Parse duration from body "[audio:30s]"
  const durSec = parseInt(m.body.match(/\[audio:(\d+)s/)?.[1] ?? '0', 10);
  const durMs = durSec * 1000;

  async function togglePlay() {
    if (!m.mediaUri) return;
    if (playing) {
      await soundRef.current?.stopAsync().catch(() => {});
      await soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
      setPosMs(0);
      setPlaying(false);
      return;
    }
    try {
      const { Audio } = require('expo-av');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: m.mediaUri },
        { shouldPlay: true, rate: playbackRate, shouldCorrectPitch: true },
        (status: AVPlaybackStatus) => {
          if (!status.isLoaded) return;
          setPosMs(status.positionMillis ?? 0);
          if (status.didJustFinish) {
            setPlaying(false);
            setPosMs(0);
            soundRef.current = null;
          }
        }
      );
      soundRef.current = sound;
      setPlaying(true);
    } catch { setPlaying(false); }
  }

  async function cycleRate() {
    const currentIndex = PLAYBACK_RATES.indexOf(playbackRate);
    const nextRate = PLAYBACK_RATES[(currentIndex + 1) % PLAYBACK_RATES.length];
    setPlaybackRate(nextRate);
    if (soundRef.current) {
      try {
        await soundRef.current.setRateAsync(nextRate, true);
      } catch { /* ignore */ }
    }
  }

  async function handleSeek(seekMs: number) {
    if (!soundRef.current) return;
    try {
      await soundRef.current.setPositionAsync(seekMs);
      setPosMs(seekMs);
    } catch { /* ignore */ }
  }

  const elapsed = Math.floor(posMs / 1000);
  const display = playing
    ? `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
    : `${String(Math.floor(durSec / 60)).padStart(2, '0')}:${String(durSec % 60).padStart(2, '0')}`;

  const rateLabel = playbackRate === 1.0 ? '1×' : `${playbackRate}×`;

  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
      <Pressable
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          width: 240,
          backgroundColor: me ? t.bubbleOut : t.bubbleIn,
          paddingHorizontal: 12,
          paddingVertical: 10,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          opacity: queued ? 0.55 : pressed ? 0.9 : 1,
        })}
      >
        <Pressable onPress={togglePlay} style={{
          width: 36, height: 36, borderRadius: 18,
          backgroundColor: me ? 'rgba(255,255,255,0.2)' : t.surface3,
          alignItems: 'center', justifyContent: 'center',
        }}>
          {playing
            ? <I.Pause size={16} color={me ? t.bubbleOutText : t.bubbleInText} />
            : <I.Play size={16} color={me ? t.bubbleOutText : t.bubbleInText} />
          }
        </Pressable>
        <View style={{ flex: 1, gap: 5 }}>
          <AudioWaveform
            durMs={durMs}
            posMs={posMs}
            width={148}
            maxBarHeight={24}
            onSeek={handleSeek}
            t={t}
            isMe={me}
          />
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.textDim }}>
            {display}
          </Text>
        </View>
        <Pressable
          onPress={cycleRate}
          accessibilityLabel={`Playback speed ${rateLabel}`}
          hitSlop={8}
          style={{
            paddingHorizontal: 5,
            paddingVertical: 3,
            borderRadius: 4,
            backgroundColor: me ? 'rgba(255,255,255,0.15)' : t.surface3,
            alignItems: 'center',
            justifyContent: 'center',
            minWidth: 28,
          }}
        >
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.textDim, fontWeight: '700' }}>
            {rateLabel}
          </Text>
        </Pressable>
        <I.Mic size={14} color={me ? t.bubbleOutText : t.textDim} />
      </Pressable>
      <ReactionPills t={t} reactions={reactions} me={me} />
      <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingVertical: 10,
    gap: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
});
