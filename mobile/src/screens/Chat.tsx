import { useEffect, useRef, useState, useMemo } from 'react';
import { logger } from '../utils/logger';
import { useTranslation } from 'react-i18next';
import { View, Text, TextInput, Pressable, FlatList, KeyboardAvoidingView, Keyboard, Platform, StyleSheet, Image, ActivityIndicator, Modal } from 'react-native';
import { MediaEditorModal } from '../components/MediaEditorModal';
import { VoiceRecorderScreen } from './VoiceRecorder';
import { GifPicker } from '../components/GifPicker';
import { ImageViewerModal } from '../components/ImageViewerModal';
import { loadWallpaper, ChatWallpaper, type WallpaperOption } from '../components/WallpaperPicker';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableMessage } from '../components/SwipeableMessage';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { decodeBase64 } from 'tweetnacl-util';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { MessageActionsSheet } from '../components/MessageActionsSheet';
import { ForwardModal } from '../components/ForwardModal';
import { SchedulePicker } from '../components/SchedulePicker';
import { useScheduledMessages } from '../store/scheduledMessages';
import { useIdentity } from '../store/identity';
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
import { themedAlert } from '../components/AlertHost';
import { isSameLocalDay, dayLabel } from './chat/dateUtils';
import { Bubble } from './chat/bubbles';

const EMPTY_MSGS: StoredMessage[] = [];


interface Props {
  contact: StoredContact;
  onBack: () => void;
  onContactDetail: () => void;
  onAttach: () => void;
  onEphemeral: () => void;
  onViewOnce?: (mediaUri: string, messageId: string) => void;
  /** Navigate to the Verify screen for this contact. */
  onVerify?: () => void;
}

export function ChatScreen({ contact: initialContact, onBack, onContactDetail, onAttach, onEphemeral, onViewOnce, onVerify }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();

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
  const setMediaUri = useMessages((s) => s.setMediaUri);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const pendingMediaUri = useMessages((s) => s.pendingMediaUri);
  const setPendingMedia = useMessages((s) => s.setPendingMedia);
  const pendingVideoUri = useMessages((s) => s.pendingVideoUri);
  const setPendingVideo = useMessages((s) => s.setPendingVideo);
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
  // Image currently open in the media editor (crop/rotate/draw/text/caption).
  const [editorUri, setEditorUri] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchActive, setSearchActive] = useState(false);
  const [searchHits, setSearchHits] = useState<string[]>([]);
  const [searchIdx, setSearchIdx] = useState(0);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [gifPickerVisible, setGifPickerVisible] = useState(false);
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null);
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
  // Proactive verification nudge: dismissible for the current view only (no
  // persistence) so it keeps reappearing on each open until the contact is
  // verified — without nagging within a single session.
  const [verifyNudgeDismissed, setVerifyNudgeDismissed] = useState(false);
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
        if (__DEV__) logger.warn('[ChatScreen] Directory sync audit failed:', e);
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
  const [showScrollFab, setShowScrollFab] = useState(false);
  // Snapshot the unread count once, before the open-chat markRead effect clears
  // it, so we can draw a "new messages" divider before the first unread message.
  const initialUnreadRef = useRef<number | null>(null);
  if (initialUnreadRef.current === null) {
    initialUnreadRef.current = useMessages.getState().unreadCounts[contact.aegisId] ?? 0;
  }
  const hasInitialScrolledRef = useRef(false);
  const sendingRef = useRef(false);

  // Reset the initial-scroll guard whenever we switch to a different chat so
  // each conversation always scrolls to its latest message on open.
  useEffect(() => {
    hasInitialScrolledRef.current = false;
  }, [contact.aegisId]);

  useEffect(() => {
    if (list.length === 0) return;
    // The FIRST landing at the bottom is owned exclusively by onContentSizeChange
    // (it snaps instantly, no animation). Bail until that has happened so we never
    // fire a competing animated scroll that produces the visible "jump" on open.
    if (!hasInitialScrolledRef.current) return;
    // New message arrived while the user is already near the bottom — follow it.
    if (isNearBottomRef.current) {
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

  // When AttachSheet picks an image, open the in-app media editor (crop/rotate,
  // draw, text, caption). The editor produces the final image + caption on send.
  useEffect(() => {
    if (!pendingMediaUri) return;
    setEditorUri(pendingMediaUri);
    setPendingMedia(null);
  }, [pendingMediaUri, setPendingMedia]);

  // A trimmed video staged by the editor → upload + send it.
  useEffect(() => {
    if (!pendingVideoUri) return;
    const uri = pendingVideoUri;
    setPendingVideo(null);
    void sendVideo(uri);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVideoUri]);

  async function handleCall(media: 'audio' | 'video') {
    if (contact.blocked) {
      themedAlert(i18nT('chat.callBlocked'), i18nT('chat.callBlockedDesc'));
      return;
    }
    if (contact.zeroTrust && mismatchKey) {
      themedAlert(i18nT('chat.callZeroTrustBlock'), i18nT('chat.callZeroTrustBlockDesc'));
      return;
    }
    if (!WEBRTC_AVAILABLE) {
      themedAlert(
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
      themedAlert(i18nT('chat.callError'), (e as Error).message);
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

  // Send an image produced by the media editor (crop/rotate/draw/text), plus an
  // optional caption delivered as part of the image message.
  async function sendEditedImage(uri: string, caption: string) {
    if (!identity) return;
    setEditorUri(null);
    try {
      const id = Crypto.randomUUID();
      await appendMsg({
        id, chatId: contact.aegisId, direction: 'out', body: caption.trim(),
        createdAt: Date.now(), type: 'image', mediaUri: uri,
      });
      const { encryptAndUploadMedia } = require('../crypto/media');
      const blobUri = await encryptAndUploadMedia(uri, 'image/jpeg');
      await setMediaUri(contact.aegisId, id, blobUri);
      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: `[image:${blobUri}]${caption.trim()}`,
        skipLocalAppend: true,
      });
      void SoundFX.msgSent();
    } catch (e) {
      themedAlert(i18nT('chat.sendError'), (e as Error).message);
    }
  }

  // Send a view-once image produced by the media editor.
  async function sendViewOnceImage(uri: string, caption: string) {
    if (!identity) return;
    setEditorUri(null);
    try {
      const id = Crypto.randomUUID();
      const bodyText = caption.trim() ? `[viewonce]\n${caption.trim()}` : '[viewonce]';
      await appendMsg({
        id, chatId: contact.aegisId, direction: 'out', body: bodyText,
        createdAt: Date.now(), type: 'image', mediaUri: uri,
      });

      const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
      const base64 = await FileSystem.readAsStringAsync(uri, {
        encoding: FileSystem.EncodingType.Base64,
      });

      const captionPart = caption.trim() ? `|${caption.trim()}` : '';
      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: `[viewonce:data:image/jpeg;base64,${base64}${captionPart}]`,
        skipLocalAppend: true,
      });
      void SoundFX.msgSent();
    } catch (e) {
      themedAlert(i18nT('chat.sendError'), (e as Error).message);
    }
  }

  // Upload + send a trimmed video (from the native video editor).
  async function sendVideo(uri: string) {
    if (!identity) return;
    try {
      const id = Crypto.randomUUID();
      await appendMsg({
        id, chatId: contact.aegisId, direction: 'out', body: '',
        createdAt: Date.now(), type: 'video', mediaUri: uri,
      });
      const { encryptAndUploadMedia } = require('../crypto/media');
      const blobUri = await encryptAndUploadMedia(uri, 'video/mp4');
      await setMediaUri(contact.aegisId, id, blobUri);
      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: `[video:${blobUri}]`,
        skipLocalAppend: true,
      });
      void SoundFX.msgSent();
    } catch (e) {
      themedAlert(i18nT('chat.sendError'), (e as Error).message);
    }
  }

  // Record + send a normal (non-ephemeral) voice note from the inline mic.
  // Mirrors sendVideo: optimistic local bubble, then encrypt-upload + send the
  // blob ref. Receiver parses "[audio:Ns:blob:…]" (see socket/client.ts).
  async function sendVoiceNote(uri: string, durationMs: number) {
    if (!identity) return;
    setShowVoiceRecorder(false);
    const durSec = Math.max(1, Math.round(durationMs / 1000));
    try {
      const id = Crypto.randomUUID();
      await appendMsg({
        id, chatId: contact.aegisId, direction: 'out',
        body: `[audio:${durSec}s]`,
        createdAt: Date.now(), type: 'audio', mediaUri: uri,
      });
      const { encryptAndUploadMedia } = require('../crypto/media');
      const blobUri = await encryptAndUploadMedia(uri, 'audio/m4a');
      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: `[audio:${durSec}s:${blobUri}]`,
        skipLocalAppend: true,
      });
      void SoundFX.msgSent();
    } catch (e) {
      themedAlert(i18nT('chat.sendError'), (e as Error).message);
    }
  }

  async function handleSend() {
    if (!identity || sendingRef.current) return;
    const hasText = draft.trim().length > 0;
    const hasImage = !!stagedImageUri;
    if (!hasText && !hasImage) return;

    sendingRef.current = true;
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
        const caption = hasText ? text : '';
        await appendMsg({
          id,
          chatId: contact.aegisId,
          direction: 'out',
          body: caption,
          createdAt: Date.now(),
          type: 'image',
          mediaUri: imageUri,
        });
        const { encryptAndUploadMedia } = require('../crypto/media');
        const blobUri = await encryptAndUploadMedia(imageUri, 'image/jpeg');
        // Swap the ephemeral picker URI for the persistent encrypted blob ref so
        // the sent image survives cache purges / restarts (resolveMedia decrypts
        // the locally-persisted ciphertext on demand). Without this the sender's
        // bubble goes gray once the picker cache is evicted.
        await setMediaUri(contact.aegisId, id, blobUri);
        await sendMessage({
          identity,
          recipientAegisId: contact.aegisId,
          recipientPublicKey: decodeBase64(contact.publicKeyB64),
          plaintext: `[image:${blobUri}]${caption}`,
          skipLocalAppend: true,
        });
      }
      // Send text message if typed and no image was staged
      if (hasText && !imageUri) {
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
      themedAlert(i18nT('chat.sendError'), (e as Error).message);
    } finally {
      sendingRef.current = false;
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
    themedAlert(i18nT('chat.deleteMessage'), i18nT('chat.deleteMessageDesc'), [
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
    themedAlert(
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

    // Privacy fix: never send the raw Giphy/Klipy URL.
    // Download the GIF locally, encrypt it like any other image attachment,
    // and send [image:...] so the receiver never contacts the GIF servers.
    const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const cacheDir = FS.cacheDirectory ?? '';
    const gifId = url.split('/').pop()?.split('?')[0] ?? Crypto.randomUUID();
    // Persistent local copy (NOT a temp we delete) so the SENDER's own bubble
    // can render the GIF locally — same pattern as sendEditedImage. Without
    // this the sender saw the raw "[image:blob:…]" text (Bug fix).
    const localPath = `${cacheDir}gif_${gifId}.gif`;

    try {
      // Enforce a 10 MB size guard by checking after download
      const downloadResult = await FS.downloadAsync(url, localPath);
      if (!downloadResult.uri) throw new Error('GIF download failed');

      const info = await FS.getInfoAsync(downloadResult.uri);
      const fileSize = (info as { size?: number }).size ?? 0;
      if (fileSize > 10 * 1024 * 1024) {
        await FS.deleteAsync(localPath, { idempotent: true }).catch(() => {});
        themedAlert(i18nT('chat.sendError'), 'GIF demasiado grande (máx. 10 MB)');
        return;
      }

      // Optimistic local echo: render the GIF on the sender's side immediately.
      const id = Crypto.randomUUID();
      await appendMsg({
        id, chatId: contact.aegisId, direction: 'out', body: '',
        createdAt: Date.now(), type: 'image', mediaUri: localPath,
      });

      const { encryptAndUploadMedia } = require('../crypto/media');
      const blobUri = await encryptAndUploadMedia(localPath, 'image/gif');
      await setMediaUri(contact.aegisId, id, blobUri);

      await sendMessage({
        identity,
        recipientAegisId: contact.aegisId,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: `[image:${blobUri}]`,
        skipLocalAppend: true,
      });
    } catch (e) {
      await FS.deleteAsync(localPath, { idempotent: true }).catch(() => {});
      themedAlert(i18nT('chat.sendError'), (e as Error).message);
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
                <Avatar t={t} name={contact.avatarImage || contact.name} color={contact.color ?? t.surface2} size={36} seed={contact.publicKeyB64 || contact.aegisId} />
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
                    themedAlert(
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

        {/* Proactive verification nudge — only when there is NO active key-mismatch
            banner and the contact has not been verified out-of-band yet. Soft,
            accent-tinted (not an alarm) and dismissible for the session. */}
        {!mismatchKey && !contact.verified && !verifyNudgeDismissed ? (
          <View
            style={{
              marginHorizontal: 12,
              marginTop: 10,
              marginBottom: 4,
              padding: 14,
              backgroundColor: `${t.accent}14`,
              borderWidth: 1,
              borderColor: `${t.accent}55`,
              borderRadius: t.radius,
              gap: 8,
            }}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <I.Lock size={13} color={t.accent} />
              <Text style={{ flex: 1, fontFamily: t.font, fontWeight: '700', fontSize: 13, color: t.text }}>
                {i18nT('chat.verifyNudgeTitle')}
              </Text>
            </View>
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: 18 }}>
              {i18nT('chat.verifyNudgeDesc')}
            </Text>
            <View style={{ flexDirection: 'row', gap: 10, marginTop: 4 }}>
              <Pressable
                onPress={onVerify ?? onContactDetail}
                style={{
                  backgroundColor: t.accent,
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: t.radiusS,
                }}
              >
                <Text style={{ color: t.accentInk, fontFamily: t.font, fontSize: 12, fontWeight: '600' }}>
                  {i18nT('chat.verifyNudgeAction')}
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setVerifyNudgeDismissed(true)}
                style={{
                  borderWidth: 1,
                  borderColor: t.borderStrong,
                  paddingHorizontal: 14,
                  paddingVertical: 7,
                  borderRadius: t.radiusS,
                }}
              >
                <Text style={{ color: t.text, fontFamily: t.font, fontSize: 12, fontWeight: '500' }}>
                  {i18nT('chat.verifyNudgeDismiss')}
                </Text>
              </Pressable>
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

        <View style={{ flex: 1 }}>
        <ChatWallpaper option={chatWallpaper} style={StyleSheet.absoluteFill} />
        <FlatList
          ref={flatlistRef}
          data={filteredList}
          keyExtractor={(m) => m.id}
          style={{ flex: 1, backgroundColor: chatWallpaper === 0 ? t.bg : 'transparent' }}
          contentContainerStyle={{ paddingHorizontal: 14, paddingBottom: 10 }}
          showsVerticalScrollIndicator={false}
          renderItem={({ item, index }) => {
            const prev = index > 0 ? filteredList[index - 1] : undefined;
            const showDate = !prev || !isSameLocalDay(item.createdAt, prev.createdAt);
            const unreadN = initialUnreadRef.current ?? 0;
            const firstUnreadIdx = filteredList.length - unreadN;
            const showUnreadDivider =
              !searchActive && unreadN > 0 && firstUnreadIdx > 0 && index === firstUnreadIdx;
            return (
            <View>
            {showUnreadDivider && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6, marginBottom: 8, paddingHorizontal: 6 }}>
                <View style={{ flex: 1, height: 1, backgroundColor: `${t.accent}44` }} />
                <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.8 }}>
                  {i18nT('chat.newMessages').toUpperCase()}
                </Text>
                <View style={{ flex: 1, height: 1, backgroundColor: `${t.accent}44` }} />
              </View>
            )}
            {showDate && (
              <View style={{ alignItems: 'center', marginTop: index === 0 ? 2 : 12, marginBottom: 8 }}>
                <View style={{ backgroundColor: t.surface2, paddingHorizontal: 12, paddingVertical: 4, borderRadius: 99 }}>
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.5 }}>
                    {dayLabel(item.createdAt, i18nT('chat.dateToday'), i18nT('chat.dateYesterday'))}
                  </Text>
                </View>
              </View>
            )}
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
                themedAlert(i18nT('chat.deleteMessage'), i18nT('chat.deleteMessageDesc'), [
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
                onImagePress={(images, index) => setViewer({ images, index })}
              />
            </SwipeableMessage>
            </View>
            </View>
            );
          }}
          ItemSeparatorComponent={() => <View style={{ height: 6 }} />}
          onContentSizeChange={() => {
            if (list.length === 0) return;
            // Authoritative scroll-to-bottom. Fires when the content has finished
            // measuring and refires as images/media load and as new messages append.
            if (!hasInitialScrolledRef.current) {
              // First layout pass for this chat: snap straight to the latest message
              // WITHOUT animation, so opening a conversation always lands at the bottom
              // cleanly — no visible scroll travelling from top to bottom.
              flatlistRef.current?.scrollToEnd({ animated: false });
              hasInitialScrolledRef.current = true;
            } else if (isNearBottomRef.current) {
              // Already anchored once; keep pinned while the user is at the bottom.
              // Once they scroll up, isNearBottomRef flips false and we leave them be.
              flatlistRef.current?.scrollToEnd({ animated: false });
            }
          }}
          onScroll={({ nativeEvent: { layoutMeasurement, contentOffset, contentSize } }) => {
            const nearBottom =
              contentOffset.y + layoutMeasurement.height >= contentSize.height - 80;
            isNearBottomRef.current = nearBottom;
            setShowScrollFab(!nearBottom);
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
        </View>

        {showScrollFab ? (
          <Pressable
            onPress={() => { flatlistRef.current?.scrollToEnd({ animated: true }); setShowScrollFab(false); }}
            accessibilityLabel="Ir al último mensaje"
            style={{
              position: 'absolute',
              right: 16,
              bottom: 90,
              width: 44,
              height: 44,
              borderRadius: 22,
              backgroundColor: t.surface2,
              borderWidth: 1,
              borderColor: t.border,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <I.ChevronD size={22} color={t.text} />
          </Pressable>
        ) : null}

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
              paddingBottom: gifPickerVisible ? 0 : insets.bottom > 0 ? insets.bottom : 14,
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
          ) : contact.pending ? (
            <View
              style={{
                flex: 1,
                paddingVertical: 12,
                paddingHorizontal: 16,
                backgroundColor: t.surface2,
                borderRadius: t.radius,
                marginHorizontal: 12,
                marginVertical: 4,
                gap: 10,
              }}
            >
              <Text style={{ fontFamily: t.font, fontSize: 12.5, color: t.textDim, textAlign: 'center', lineHeight: 18 }}>
                {i18nT('chat.requestPrompt')}
              </Text>
              <View style={{ flexDirection: 'row', gap: 8 }}>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void useContacts.getState().acceptContact(contact.aegisId)}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: t.radiusS, backgroundColor: t.accent, alignItems: 'center' }}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '700', color: t.accentInk ?? '#000' }}>
                    {i18nT('chat.requestAccept')}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={() => void useContacts.getState().setBlocked(contact.aegisId, true)}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: t.radiusS, borderWidth: 1, borderColor: t.borderStrong, alignItems: 'center' }}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>
                    {i18nT('chat.requestBlock')}
                  </Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  onPress={async () => { await useContacts.getState().removeContact(contact.aegisId); onBack(); }}
                  style={{ flex: 1, paddingVertical: 10, borderRadius: t.radiusS, borderWidth: 1, borderColor: `${t.danger}66`, alignItems: 'center' }}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.danger }}>
                    {i18nT('chat.requestDelete')}
                  </Text>
                </Pressable>
              </View>
            </View>
          ) : (
            <>
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
                    {replyTo.deleted ? i18nT('chat.deletedMessage') : replyTo.body || (replyTo.type === 'image' ? '📷 ' + i18nT('attachSheet.image') : replyTo.type === 'video' ? '📹 Video' : '…')}
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

              {/* ── GIF + mic — only visible when input is empty (disappear while typing) ── */}
              {!draft.trim() && !stagedImageUri && (
                <>
                  <Pressable
                    onPress={() => { Keyboard.dismiss(); setGifPickerVisible((v) => !v); }}
                    hitSlop={8}
                    style={{ padding: 6 }}
                    accessibilityLabel="Abrir selector de GIF"
                  >
                    <Text style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '700', color: t.textDim, letterSpacing: 0.5 }}>
                      GIF
                    </Text>
                  </Pressable>
                  <Pressable
                    onPress={() => setShowVoiceRecorder(true)}
                    hitSlop={8}
                    style={{ padding: 6 }}
                    accessibilityLabel={i18nT('chat.voiceNote', 'Grabar nota de voz')}
                  >
                    <I.Mic size={22} color={t.textDim} />
                  </Pressable>
                </>
              )}

              {/* ── Input field ────────────────────────────────────────── */}
              <TextInput
                value={draft}
                onChangeText={handleDraftChange}
                onFocus={() => setGifPickerVisible(false)}
                placeholder={online ? i18nT('chat.messagePlaceholder') : i18nT('chat.messageOfflinePlaceholder')}
                placeholderTextColor={t.textFaint}
                accessibilityLabel="Campo de mensaje"
                multiline
                returnKeyType="send"
                submitBehavior="submit"
                onSubmitEditing={() => {
                  // Soft-keyboard "send" key. submitBehavior="submit" (RN 0.81)
                  // makes the return key fire onSubmitEditing on a multiline input
                  // WITHOUT inserting a newline and WITHOUT dismissing the keyboard,
                  // so the user can keep typing the next message immediately.
                  if (draft.trim() || stagedImageUri) void handleSend();
                }}
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

        {/* GIF / sticker panel — inline, WhatsApp-style, docked below the composer. */}
        <GifPicker
          visible={gifPickerVisible}
          onClose={() => setGifPickerVisible(false)}
          onSelectGif={handleGifSelect}
          onSelectSticker={handleStickerSelect}
        />
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

      <ImageViewerModal images={viewer?.images ?? null} initialIndex={viewer?.index ?? 0} onClose={() => setViewer(null)} t={t} />

      {/* Inline voice note recorder — normal (non-ephemeral) audio */}
      <Modal
        visible={showVoiceRecorder}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowVoiceRecorder(false)}
      >
        <VoiceRecorderScreen
          onBack={() => setShowVoiceRecorder(false)}
          onSend={(uri, durationMs) => { void sendVoiceNote(uri, durationMs); }}
        />
      </Modal>

      <MediaEditorModal
        t={t}
        visible={editorUri !== null}
        imageUri={editorUri}
        captionPlaceholder={i18nT('chat.addCaption')}
        allowViewOnce={true}
        onCancel={() => setEditorUri(null)}
        onSend={({ uri, caption, isViewOnce }) => {
          if (isViewOnce) {
            void sendViewOnceImage(uri, caption);
          } else {
            void sendEditedImage(uri, caption);
          }
        }}
      />

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
            themedAlert('Error al programar', (e as Error).message);
          }
        }}
      />
    </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
}

// ─── Location message parser ─────────────────────────────────────────────────
// Defined in mobile/src/utils/parseLocationMessage.ts — imported above

// ─── View-once ephemeral audio bubble ───────────────────────────────────────
// Plays the received ephemeral voice note exactly once, then deletes the cached
// file and locks the bubble ("ya escuchado"). The generic view-once Pressable
// only handled images, so this is the dedicated playable path for audio.
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
