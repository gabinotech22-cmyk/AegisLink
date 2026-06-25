import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { logger } from '../utils/logger';
import { useTranslation } from 'react-i18next';
import { View, Text, TextInput, Pressable, FlatList, KeyboardAvoidingView, Keyboard, Platform, StyleSheet, Linking, Image, ActivityIndicator, Modal } from 'react-native';
import { FormattedText } from '../components/FormattedText';
import { MediaEditorModal } from '../components/MediaEditorModal';
import { VoiceRecorderScreen } from './VoiceRecorder';
import { VideoBubble } from '../components/VideoBubble';
import { AudioWaveform } from '../components/AudioWaveform';
import { LinkPreview } from '../components/LinkPreview';
import { GifPicker } from '../components/GifPicker';
import { ImageViewerModal } from '../components/ImageViewerModal';
import { MediaImage } from '../components/MediaImage';
import { AttachmentGrid } from '../components/AttachmentGrid';
import { loadWallpaper, ChatWallpaper, type WallpaperOption } from '../components/WallpaperPicker';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableMessage } from '../components/SwipeableMessage';
import Svg, { Path, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
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
import { useGroups } from '../store/groups';
import { sendMessage, emitTyping, sendReadReceipts, sendDeleteForEveryone } from '../socket/client';
import { startCall } from '../socket/calls';
import { WEBRTC_AVAILABLE } from '../runtime';
import { SoundFX } from '../hooks/useSoundFX';
import type { StoredContact, StoredMessage } from '../db/local';
import { parseLocationMessage } from '../utils/parseLocationMessage';
import { themedAlert } from '../components/AlertHost';

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
  /** Navigate to the Verify screen for this contact. */
  onVerify?: () => void;
}

export function ChatScreen({ contact: initialContact, onBack, onContactDetail, onAttach, onEphemeral, onViewOnce, onVerify }: Props) {
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
          )}
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
        </View>

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
function ViewOnceAudioBubble({
  t, m, me, isReceived, durSec, queued, time, onLongPress,
}: {
  t: Theme;
  m: StoredMessage;
  me: boolean;
  isReceived: boolean;
  durSec: number;
  queued: boolean;
  time: string;
  onLongPress: () => void;
}) {
  const [played, setPlayed] = useState(false);
  const [playing, setPlaying] = useState(false);
  type AudioSound = import('expo-av').Audio.Sound;
  type AVPlaybackStatus = import('expo-av').AVPlaybackStatus;
  const soundRef = useRef<AudioSound | null>(null);

  useEffect(() => {
    return () => { void soundRef.current?.unloadAsync().catch(() => {}); };
  }, []);

  async function playOnce() {
    if (!m.mediaUri || playing || played) return;
    try {
      const { Audio } = require('expo-av');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: m.mediaUri },
        { shouldPlay: true },
        (status: AVPlaybackStatus) => {
          if (!status.isLoaded) return;
          if (status.didJustFinish) {
            setPlaying(false);
            setPlayed(true);
            void soundRef.current?.unloadAsync().catch(() => {});
            soundRef.current = null;
            // Ephemeral: destroy the cached audio after the single playback
            // (received side only — the sender keeps their local copy bubble).
            if (isReceived && m.mediaUri) {
              try {
                const FileSystem = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
                void FileSystem.deleteAsync(m.mediaUri, { idempotent: true }).catch(() => {});
              } catch { /* ignore */ }
              // Persist consumption so it doesn't reappear as playable after an
              // app reload — mirrors the view-once image which soft-deletes once
              // viewed. Without this the local `played` flag was lost on reload.
              try {
                const { useMessages } = require('../store/messages');
                void useMessages.getState().softDelete(m.chatId, m.id).catch(() => {});
              } catch { /* ignore */ }
            }
          }
        }
      );
      soundRef.current = sound;
      setPlaying(true);
    } catch {
      setPlaying(false);
    }
  }

  const canPlay = isReceived && !!m.mediaUri && !played;

  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
      <Pressable
        onLongPress={onLongPress}
        onPress={() => { if (canPlay) void playOnce(); }}
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
          opacity: pressed ? 0.85 : played ? 0.6 : 1,
          maxWidth: 240,
        })}
      >
        <I.Mic size={22} color={me ? t.bubbleOutText : t.accent} stroke={1.6} />
        <View style={{ flex: 1 }}>
          <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: me ? t.bubbleOutText : t.text }}>
            {isReceived ? 'Audio efímero' : 'Audio enviado'}
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.accent, letterSpacing: 0.5, marginTop: 2 }}>
            {played
              ? 'ya escuchado'
              : playing
                ? 'reproduciendo…'
                : isReceived
                  ? (durSec > 0 ? `${durSec}s · toca para escuchar una vez` : 'toca para escuchar una vez')
                  : (durSec > 0 ? `${durSec}s · escuchar una vez` : 'escuchar una vez')}
          </Text>
        </View>
      </Pressable>
      <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
    </View>
  );
}

// ─── Bubble ──────────────────────────────────────────────────────────────────

// ── Group join-request card ───────────────────────────────────────────────────
// Wire format: [join_request:<groupId>:<groupName>], sent 1:1 to the group
// admin by GroupJoinScreen when someone opens an invite link. The requester is
// the chat peer (m.chatId). Accepting adds them to the group and broadcasts
// the re-signed membership, which creates the group on the requester's device
// through the authenticated group_msg metadata path.
function JoinRequestBubble({ t, m, me, time }: { t: Theme; m: StoredMessage; me: boolean; time: string }) {
  const { t: i18nT } = useTranslation();
  const groups = useGroups((s) => s.groups);
  const addMember = useGroups((s) => s.addMember);
  const contacts = useContacts((s) => s.contacts);
  const identity = useIdentity((s) => s.identity);
  const [busy, setBusy] = useState(false);

  // [join_request:<groupId>:<groupName>] — groupName is display-only.
  const inner = m.body.slice('[join_request:'.length, -1);
  const sep = inner.indexOf(':');
  const groupId = sep >= 0 ? inner.slice(0, sep) : inner;
  const wireGroupName = sep >= 0 ? inner.slice(sep + 1) : '';

  const group = groups.find((g) => g.id === groupId);
  // Prefer the locally-trusted name; the wire name is attacker-controlled.
  const groupName = group?.name ?? wireGroupName;
  const requesterId = m.chatId;
  const requesterName = contacts.find((c) => c.aegisId === requesterId)?.name ?? requesterId;
  const isAdmin = !!group && !!identity && group.adminId === identity.aegisId;
  const alreadyMember = !!group && group.members.includes(requesterId);

  async function handleAccept() {
    if (!group || !identity || busy) return;
    setBusy(true);
    try {
      await addMember(group.id, requesterId);
      // Push the re-signed member list to everyone NOW — this is what makes
      // the group appear on the requester's device.
      const client = require('../socket/client') as typeof import('../socket/client');
      await client.broadcastGroupMetadata(identity, group.id);
    } catch {
      themedAlert(
        i18nT('chat.joinRequestErrorTitle', 'Could not add member'),
        i18nT('chat.joinRequestErrorDesc', 'Check your connection and try again.'),
      );
    } finally {
      setBusy(false);
    }
  }

  if (me) {
    // Requester side: confirmation that the request went out.
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
            borderColor: t.border,
          }}
        >
          <I.Users size={14} color={t.accent} />
          <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>
            {i18nT('chat.joinRequestSentCard', 'Join request sent · {{group}}', { group: groupName })}
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint }}>{time}</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ alignItems: 'flex-start' }}>
      <View
        style={{
          width: 260,
          backgroundColor: t.bubbleIn,
          borderRadius: t.radius,
          borderTopLeftRadius: t.radiusS,
          borderWidth: 1,
          borderColor: `${t.accent}33`,
          overflow: 'hidden',
        }}
      >
        <View style={{ padding: 12, gap: 8 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: t.radiusS,
                backgroundColor: `${t.accent}22`,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <I.Users size={17} color={t.accent} />
            </View>
            <Text
              style={{
                flex: 1,
                fontFamily: t.fontMono,
                fontSize: 10,
                color: t.textDim,
                letterSpacing: 0.6,
              }}
            >
              {i18nT('chat.joinRequestLabel', 'GROUP JOIN REQUEST').toUpperCase()}
            </Text>
          </View>
          <Text style={{ fontFamily: t.font, fontSize: 14, color: t.bubbleInText, lineHeight: 20 }}>
            {i18nT('chat.joinRequestIncoming', '{{name}} wants to join "{{group}}"', {
              name: requesterName,
              group: groupName,
            })}
          </Text>

          {alreadyMember ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingTop: 2 }}>
              <I.Check size={15} color={t.accent} />
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.accent }}>
                {i18nT('chat.joinRequestAdded', 'Added to the group')}
              </Text>
            </View>
          ) : isAdmin ? (
            <Pressable
              onPress={() => void handleAccept()}
              disabled={busy}
              style={({ pressed }) => ({
                backgroundColor: t.accent,
                borderRadius: t.radiusS,
                paddingVertical: 10,
                alignItems: 'center',
                opacity: pressed || busy ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.accentInk }}>
                {busy
                  ? i18nT('chat.joinRequestAdding', 'Adding…')
                  : i18nT('chat.joinRequestAdd', 'Add to group')}
              </Text>
            </Pressable>
          ) : (
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim }}>
              {group
                ? i18nT('chat.joinRequestNotAdmin', 'Only the group admin can approve this request')
                : i18nT('chat.joinRequestUnknownGroup', 'Group not available on this device')}
            </Text>
          )}
        </View>
      </View>
      <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginTop: 3, paddingHorizontal: 4 }}>
        {time}
      </Text>
    </View>
  );
}

interface BubbleProps {
  t: Theme;
  m: StoredMessage;
  online: boolean;
  quotedMsg?: StoredMessage;
  onLongPress: () => void;
  onViewOnce?: (mediaUri: string, messageId: string) => void;
  onImagePress?: (images: string[], index: number) => void;
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
              height: 110,
              alignItems: 'center',
              justifyContent: 'center',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            {/* Map mock mirrors ScreenLocation (screens-phase2.jsx): gradient
                base, 32px grid, faint roads and the accent pin with the Shield
                mark — kept faithful to the original prototype. */}
            <Svg viewBox="0 0 250 110" width="100%" height="100%" style={{ position: 'absolute' }}>
              <Defs>
                <LinearGradient id="locMapBg" x1="0" y1="0" x2="1" y2="1">
                  {(t.dark ? ['#1a2326', '#243033'] : ['#e8e5dc', '#d8d4c6']).map((c, i) => (
                    <Stop key={i} offset={i} stopColor={c} />
                  ))}
                </LinearGradient>
              </Defs>
              <Rect x="0" y="0" width="250" height="110" fill="url(#locMapBg)" />
              {[28, 56, 84, 112, 140, 168, 196, 224].map((x) => (
                <Path key={`v${x}`} d={`M${x} 0 L${x} 110`} stroke={t.borderStrong} strokeWidth={1} opacity={0.25} />
              ))}
              {[28, 56, 84].map((y) => (
                <Path key={`h${y}`} d={`M0 ${y} L250 ${y}`} stroke={t.borderStrong} strokeWidth={1} opacity={0.25} />
              ))}
              <Path d="M0 44 Q125 33 250 55" stroke={t.borderStrong} strokeWidth={4} fill="none" opacity={0.5} />
              <Path d="M107 0 L143 110" stroke={t.borderStrong} strokeWidth={4} fill="none" opacity={0.5} />
              <Path d="M0 83 L250 77" stroke={t.borderStrong} strokeWidth={2} fill="none" opacity={0.4} />
            </Svg>
            {/* accent halo behind the pin (the prototype's pulse, static here) */}
            <View style={{ position: 'absolute', width: 64, height: 64, borderRadius: 32, backgroundColor: `${t.accent}22` }} />
            <View
              style={{
                width: 34,
                height: 34,
                borderRadius: 17,
                backgroundColor: t.accent,
                borderWidth: 3,
                borderColor: t.bg,
                alignItems: 'center',
                justifyContent: 'center',
                shadowColor: t.accent,
                shadowOffset: { width: 0, height: 3 },
                shadowOpacity: 0.4,
                shadowRadius: 6,
                elevation: 3,
              }}
            >
              <I.Shield size={16} color={t.accentInk} />
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

  // Multi-attachment bubble
  if (m.attachments && m.attachments.length > 0) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start', opacity: queued ? 0.55 : 1 }}>
        <Pressable onLongPress={onLongPress} accessibilityLabel="Attachment message">
          <AttachmentGrid
            attachments={m.attachments}
            isMe={me}
            caption={m.body || undefined}
            onImagePress={(uri, index) => {
              const imageUris = (m.attachments ?? [])
                .filter((a) => a.type === 'image' || a.type === 'video')
                .map((a) => a.uri);
              onImagePress?.(imageUris, index);
            }}
            onFilePress={(att) => {
              if (att.uri) void Linking.openURL(att.uri).catch(() => {});
            }}
          />
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <TimestampRow t={t} queued={queued} time={time} starred={m.starred} deliveryStatus={me ? m.deliveryStatus : undefined} />
      </View>
    );
  }

  // Video bubble
  if (m.type === 'video') {
    return <VideoBubble t={t} m={m} me={me} queued={queued} time={time} onLongPress={onLongPress} caption={m.body ?? undefined} />;
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

    // Ephemeral audio gets its own playable bubble — the generic view-once
    // Pressable below only opens the image viewer and had no audio handler,
    // which left received ephemeral audio impossible to play.
    if (isAudio) {
      return (
        <ViewOnceAudioBubble
          t={t}
          m={m}
          me={me}
          isReceived={isReceived}
          durSec={audioDurSec}
          queued={queued}
          time={time}
          onLongPress={onLongPress}
        />
      );
    }

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
          {isAudio
            ? <I.Mic size={22} color={me ? t.bubbleOutText : t.accent} stroke={1.6} />
            : <I.EyeOff size={22} color={me ? t.bubbleOutText : t.accent} stroke={1.6} />}
          <View style={{ flex: 1 }}>
            <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: me ? t.bubbleOutText : t.text }}>
              {isAudio
                ? (isReceived ? 'Audio efímero' : 'Audio enviado')
                : (isReceived ? i18nT('chat.viewOnceReceived') : i18nT('chat.viewOnceSent'))}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.accent, letterSpacing: 0.5, marginTop: 2 }}>
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
    const bubbleBg = me ? t.bubbleOut : t.bubbleIn;
    const textColor = me ? t.bubbleOutText : t.bubbleInText;
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onPress={() => onImagePress?.([m.mediaUri!], 0)}
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            width: 220,
            backgroundColor: bubbleBg,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            overflow: 'hidden',
            opacity: queued ? 0.55 : pressed ? 0.9 : 1,
          })}
        >
          <MediaImage
            uri={m.mediaUri}
            accent={t.accent}
            style={{ width: 220, height: 180, backgroundColor: t.surface2 }}
          />
          {m.body ? (
            <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 }}>
              <FormattedText
                body={m.body}
                t={t}
                onAccent={me}
                style={{
                  color: textColor,
                  fontFamily: t.font,
                  fontSize: 14,
                  lineHeight: 18,
                }}
              />
            </View>
          ) : null}
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
    const wasOutgoing = m.direction === 'out';

    // Direction-aware label: differentiate "you called" vs "they called"
    // so outgoing unanswered calls show "Sin respuesta" instead of "Llamada perdida".
    const statusLabel = (() => {
      if (wasOutgoing) {
        if (callStatus === 'missed') return i18nT('chat.callNoAnswer', 'Sin respuesta');
        if (callStatus === 'declined') return i18nT('chat.callDeclinedByThem', 'Llamada rechazada');
        return callMedia === 'video' ? i18nT('chat.videoCallMade', 'Videollamada') : i18nT('chat.voiceCallMade', 'Llamada de voz');
      } else {
        if (callStatus === 'missed') return i18nT('chat.missedCall', 'Llamada perdida');
        if (callStatus === 'declined') return i18nT('chat.declinedCall', 'Llamada rechazada');
        return callMedia === 'video' ? i18nT('chat.videoCall', 'Videollamada') : i18nT('chat.voiceCall', 'Llamada de voz');
      }
    })();

    // Only highlight in warn color for incoming missed calls — those are the
    // most actionable (you missed something). Outgoing unanswered calls use
    // a dimmer treatment since you were the initiator.
    const showAsAlert = isMissed && !wasOutgoing;

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
            borderColor: showAsAlert ? `${t.warn}55` : t.border,
          }}
        >
          <CallIcon size={14} color={showAsAlert ? t.warn : (wasOutgoing ? t.textDim : t.accent)} />
          <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: showAsAlert ? t.warn : t.text }}>
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

  // Group join-request card — [join_request:<groupId>:<groupName>]
  if (m.body?.startsWith('[join_request:') && m.body.endsWith(']')) {
    return <JoinRequestBubble t={t} m={m} me={me} time={time} />;
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
                  themedAlert(i18nT('chat.contactAdded', 'Contacto añadido'), cardName);
                } catch {
                  // Fallback: copy ID to clipboard
                  const Clipboard = require('expo-clipboard');
                  await Clipboard.setStringAsync(cardAegisId).catch(() => {});
                  themedAlert(i18nT('chat.contactAddFailed', 'No se pudo añadir'), i18nT('chat.idCopied', 'ID copiado al portapapeles'));
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

  // Vault sticker bubble — [sticker:vault_<key>]
  const stickerMatch = m.body?.match(/^\[sticker:(vault_\w+)\]$/);
  if (stickerMatch) {
    const { VaultSticker } = require('../components/stickers/VaultPack') as typeof import('../components/stickers/VaultPack');
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            width: 130,
            height: 130,
            borderRadius: t.radius,
            overflow: 'hidden',
            backgroundColor: '#0d1311',
            borderWidth: 1,
            borderColor: pressed ? 'rgba(91,242,185,0.35)' : t.border,
            alignItems: 'center',
            justifyContent: 'center',
            opacity: queued ? 0.55 : 1,
          })}
        >
          <VaultSticker stickerKey={stickerMatch[1]} size={120} />
        </Pressable>
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
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
      <Pressable
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          maxWidth: '80%',
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
          onAccent={me}
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
