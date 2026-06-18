import { useEffect, useRef, useState, useMemo } from 'react';
import { View, Text, TextInput, Pressable, FlatList, KeyboardAvoidingView, Platform, StyleSheet, Linking, Image, Animated, ActivityIndicator, Modal } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableMessage } from '../components/SwipeableMessage';
import { FormattedText } from '../components/FormattedText';
import { MediaEditorModal } from '../components/MediaEditorModal';
import { VideoBubble } from '../components/VideoBubble';
import { AudioWaveform } from '../components/AudioWaveform';
import { LinkPreview } from '../components/LinkPreview';
import { GifPicker } from '../components/GifPicker';
import { ImageViewerModal } from '../components/ImageViewerModal';
import Svg, { Path, Defs, LinearGradient, Stop, Rect } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Crypto from 'expo-crypto';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { MessageActionsSheet } from '../components/MessageActionsSheet';
import { ForwardModal } from '../components/ForwardModal';
import { useIdentity } from '../store/identity';
import { useMessages } from '../store/messages';
import { MediaImage } from '../components/MediaImage';
import { AttachmentGrid } from '../components/AttachmentGrid';
import { useContacts } from '../store/contacts';
import { useGroups } from '../store/groups';
import { useActiveCalls } from '../store/activeCalls';
import { useGroupCall } from '../store/groupCall';
import { canScheduleGroupPost } from '../store/scheduledMessages';
import { parseGroupPostMarker } from '../utils/groupPost';
import { sendGroupMessage, sendGroupVote } from '../socket/client';
import { useConnection } from '../store/connection';
import { usePollsStore, type PollResult } from '../store/polls';
import type { StoredGroup, StoredMessage } from '../db/local';
import { parseLocationMessage } from '../utils/parseLocationMessage';
import { VoiceRecorderScreen } from './VoiceRecorder';
import { themedAlert } from '../components/AlertHost';

const EMPTY_MSGS: StoredMessage[] = [];

// Deterministic color from string
function colorFromId(id: string) {
  const palette = ['#5bf2b9','#06b6d4','#a78bfa','#f59e0b','#ec4899','#3b82f6','#10b981','#8b5cf6'];
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = id.charCodeAt(i) + ((hash << 5) - hash);
  return palette[Math.abs(hash) % palette.length];
}

interface Props {
  group: StoredGroup;
  onBack: () => void;
  onGroupDetail?: () => void;
  onPoll?: () => void;
  onAttach?: () => void;
  onGroupCall?: () => void;
  /** Owner/mods: open the scheduled-posts composer with the current draft. */
  onSchedulePost?: (draftText: string) => void;
}

export function GroupChatScreen({ group: initialGroup, onBack, onGroupDetail, onPoll, onAttach, onGroupCall, onSchedulePost }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const contacts = useContacts((s) => s.contacts);
  const hydrate = useContacts((s) => s.hydrate);
  // Read group reactively from the store so member add/remove is reflected live
  const group = useGroups((s) => s.groups.find((g) => g.id === initialGroup.id) ?? initialGroup);
  // Active voice channel for THIS group (Discord-style banner). Hidden when I'm
  // already in that call (then the in-call bar is showing instead).
  const activeCall = useActiveCalls((s) => s.calls[group.id]);
  const myCallId = useGroupCall((s) => s.callId);
  const myCallGroupId = useGroupCall((s) => s.groupId);
  const myCallStatus = useGroupCall((s) => s.status);
  const myCallMuted = useGroupCall((s) => s.muted);
  const myCallParticipants = useGroupCall((s) => s.participants);
  const myCallStartedAt = useGroupCall((s) => s.startedAt);

  const isInCallHere = (myCallStatus === 'in-call' || myCallStatus === 'connecting') && myCallGroupId === group.id;
  const showCallBanner = !!activeCall && activeCall.callId !== myCallId && !isInCallHere;

  // Tell the group call store this screen is handling the call UI (un-minimizes).
  // On unmount (navigate away) flip it back so FloatingGroupCallBar takes over.
  useEffect(() => {
    if (isInCallHere) {
      useGroupCall.getState().setMinimized(false);
    }
    return () => {
      if (useGroupCall.getState().groupId === group.id) {
        useGroupCall.getState().setMinimized(true);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isInCallHere, group.id]);
  const list = useMessages((s) => s.byChat[group.id] ?? EMPTY_MSGS);
  const loadChat = useMessages((s) => s.loadChat);
  const toggleStar = useMessages((s) => s.toggleStar);
  const softDelete = useMessages((s) => s.softDelete);
  const toggleReaction = useMessages((s) => s.toggleReaction);
  const appendMsg = useMessages((s) => s.append);
  const markRead = useMessages((s) => s.markRead);
  const pendingMediaUri = useMessages((s) => s.pendingMediaUri);
  const setPendingMedia = useMessages((s) => s.setPendingMedia);
  const pendingVideoUri = useMessages((s) => s.pendingVideoUri);
  const setPendingVideo = useMessages((s) => s.setPendingVideo);

  const [draft, setDraft] = useState('');
  // Scheduled group posts — owner/moderators only (gate shared with fire-time check)
  const canSchedulePost = canScheduleGroupPost(group, identity?.aegisId);
  const [stagedImageUri, setStagedImageUri] = useState<string | null>(null);
  const [editorUri, setEditorUri] = useState<string | null>(null);
  const [imageProcessing, setImageProcessing] = useState(false);
  const [sending, setSending] = useState(false);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  const [actionsMsg, setActionsMsg] = useState<StoredMessage | null>(null);
  const [forwardBody, setForwardBody] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [gifPickerVisible, setGifPickerVisible] = useState(false);
  const [viewer, setViewer] = useState<{ images: string[]; index: number } | null>(null);
  const flatlistRef = useRef<FlatList>(null);
  const isNearBottomRef = useRef(true);
  const hasInitialScrolledRef = useRef(false);
  const sendingRef = useRef(false);
  const online = useConnection((s) => s.online);

  // Build member name lookup — memoised so GroupBubble receives a stable reference
  const memberNames = useMemo(() => {
    const map: Record<string, string> = {};
    for (const c of contacts) {
      if (group.members.includes(c.aegisId)) map[c.aegisId] = c.name;
    }
    return map;
  }, [contacts, group.members]);

  useEffect(() => {
    void hydrate();
    // hydrate is a Zustand action — selector keeps reference stable, but we
    // intentionally run this only once on mount (not every time hydrate changes)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pollResults = usePollsStore((s) => s.results);
  const castVote = usePollsStore((s) => s.castVote);
  const hydratePollsStore = usePollsStore((s) => s.hydrate);

  // Reset initial-scroll guard when switching groups
  useEffect(() => {
    hasInitialScrolledRef.current = false;
  }, [group.id]);

  useEffect(() => {
    void loadChat(group.id);
    void markRead(group.id);
    const { setActiveChatNotificationId } = require('../notifications/push') as typeof import('../notifications/push');
    setActiveChatNotificationId(group.id);
    return () => {
      setActiveChatNotificationId(null);
    };
  }, [group.id, loadChat, markRead]);

  useEffect(() => {
    void hydratePollsStore();
    // Same reasoning as hydrate above — run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Picked image → open the in-app media editor (crop/rotate/draw/text/caption).
  useEffect(() => {
    if (!pendingMediaUri) return;
    setEditorUri(pendingMediaUri);
    setPendingMedia(null);
  }, [pendingMediaUri, setPendingMedia]);

  // Trimmed video staged by the native editor → upload + send it.
  useEffect(() => {
    if (!pendingVideoUri) return;
    const uri = pendingVideoUri;
    setPendingVideo(null);
    void sendVideo(uri);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingVideoUri]);

  async function sendVideo(uri: string) {
    if (!identity) return;
    try {
      const id = Crypto.randomUUID();
      await appendMsg({ id, chatId: group.id, direction: 'out', body: '', createdAt: Date.now(), type: 'video', mediaUri: uri });
      const { encryptAndUploadMedia } = require('../crypto/media');
      const blobUri = await encryptAndUploadMedia(uri, 'video/mp4');
      await useMessages.getState().setMediaUri(group.id, id, blobUri);
      await sendGroupMessage({ identity, groupId: group.id, plaintext: `[video:${blobUri}]`, skipLocalAppend: true });
    } catch (e) {
      themedAlert(i18nT('chat.sendError'), (e as Error).message);
    }
  }

  async function handleVote(pollMessageId: string, optionIndex: number, totalOptions: number) {
    if (!identity) return;
    // castVote returns null when the vote is toggled off or a duplicate is blocked.
    const voteCommitment = castVote(identity.aegisId, pollMessageId, optionIndex, totalOptions);
    if (!voteCommitment) return; // toggled off or already voted — no wire message
    try {
      await sendGroupVote({
        identity,
        groupId: group.id,
        pollMessageId,
        optionIndex,
        commitment: voteCommitment.commitment,
        nonceHex: voteCommitment.nonceHex,
      });
    } catch {
      // Vote queued offline or silently failed — local count already updated
    }
  }

  useEffect(() => {
    if (list.length === 0) return;
    // The FIRST landing at the bottom is owned exclusively by onContentSizeChange
    // (it snaps instantly). Bail until that has happened so we never fire a competing
    // animated scroll that produces the visible "jump" when opening the group.
    if (!hasInitialScrolledRef.current) return;
    // New message arrived while near the bottom — follow it.
    if (isNearBottomRef.current) {
      requestAnimationFrame(() => flatlistRef.current?.scrollToEnd({ animated: true }));
    }
  }, [list.length]);

  // Play received-message tone for incoming group messages
  const prevListLengthRef = useRef(list.length);
  useEffect(() => {
    const prev = prevListLengthRef.current;
    prevListLengthRef.current = list.length;
    if (list.length <= prev) return;
    const newItems = list.slice(prev);
    if (newItems.some((m) => m.direction === 'in')) {
      const { SoundFX } = require('../hooks/useSoundFX') as typeof import('../hooks/useSoundFX');
      void SoundFX.msgReceived();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [list.length]);

  // @ mention autocomplete
  const mentionMatches = mentionQuery !== null
    ? group.members
        .filter((id) => id !== identity?.aegisId)
        .map((id) => ({ id, name: memberNames[id] ?? id }))
        .filter(({ name }) => name.toLowerCase().startsWith(mentionQuery.toLowerCase()))
        .slice(0, 5)
    : [];

  function handleDraftChange(text: string) {
    setDraft(text);
    const atMatch = text.match(/@(\w*)$/);
    setMentionQuery(atMatch ? atMatch[1] : null);
  }

  function insertMention(name: string) {
    const replaced = draft.replace(/@(\w*)$/, `@${name} `);
    setDraft(replaced);
    setMentionQuery(null);
  }

  function handleStar() { if (!actionsMsg) return; void toggleStar(group.id, actionsMsg.id); }
  function handleDelete() {
    if (!actionsMsg) return;
    themedAlert(
      i18nT('groupChat.deleteMessage', 'Delete message'),
      i18nT('groupChat.deleteMessageConfirm', 'Delete this message?'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        { text: i18nT('common.delete', 'Delete'), style: 'destructive', onPress: () => void softDelete(group.id, actionsMsg.id) },
      ]
    );
  }
  function handleReact(emoji: string) {
    if (!actionsMsg || !identity) return;
    void toggleReaction(group.id, actionsMsg.id, emoji, identity.aegisId);
  }

  const filteredList = useMemo(() => {
    if (!searchQuery) return list;
    const q = searchQuery.toLowerCase();
    return list.filter((m) => !m.deleted && m.body.toLowerCase().includes(q));
  }, [list, searchQuery]);

  async function handleGifSelect(url: string) {
    setGifPickerVisible(false);
    if (!identity) return;

    // Privacy + correctness: download the GIF, encrypt it like any image, and
    // send [image:blob…] so members never contact the GIF servers and the
    // sender's own bubble renders the GIF (not raw "[gif:url]" text).
    const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const cacheDir = FS.cacheDirectory ?? '';
    const gifId = url.split('/').pop()?.split('?')[0] ?? Crypto.randomUUID();
    const localPath = `${cacheDir}gif_${gifId}.gif`;

    try {
      const downloadResult = await FS.downloadAsync(url, localPath);
      if (!downloadResult.uri) throw new Error('GIF download failed');

      const info = await FS.getInfoAsync(downloadResult.uri);
      const fileSize = (info as { size?: number }).size ?? 0;
      if (fileSize > 10 * 1024 * 1024) {
        await FS.deleteAsync(localPath, { idempotent: true }).catch(() => {});
        themedAlert(i18nT('chat.sendError', 'Error'), 'GIF demasiado grande (máx. 10 MB)');
        return;
      }

      const id = Crypto.randomUUID();
      await appendMsg({ id, chatId: group.id, direction: 'out', body: '', createdAt: Date.now(), type: 'image', mediaUri: localPath });

      const { encryptAndUploadMedia } = require('../crypto/media');
      const blobUri = await encryptAndUploadMedia(localPath, 'image/gif');
      await useMessages.getState().setMediaUri(group.id, id, blobUri);

      await sendGroupMessage({ identity, groupId: group.id, plaintext: `[image:${blobUri}]`, skipLocalAppend: true });
    } catch (e) {
      await FS.deleteAsync(localPath, { idempotent: true }).catch(() => {});
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }

  function handleStickerSelect(emoji: string) {
    setGifPickerVisible(false);
    setDraft((prev) => prev + emoji);
  }

  // Send an image produced by the media editor (crop/rotate/draw/text) + caption.
  async function sendEditedImage(uri: string, caption: string) {
    if (!identity) return;
    setEditorUri(null);
    try {
      const id = Crypto.randomUUID();
      await appendMsg({ id, chatId: group.id, direction: 'out', body: caption.trim(), createdAt: Date.now(), type: 'image', mediaUri: uri });
      const { encryptAndUploadMedia } = require('../crypto/media');
      const blobUri = await encryptAndUploadMedia(uri, 'image/jpeg');
      await useMessages.getState().setMediaUri(group.id, id, blobUri);
      await sendGroupMessage({ identity, groupId: group.id, plaintext: `[image:${blobUri}]${caption.trim()}`, skipLocalAppend: true });
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
    const text = draft.trim();
    const imageUri = stagedImageUri;
    const replying = replyTo;
    setDraft('');
    setStagedImageUri(null);
    setMentionQuery(null);
    setReplyTo(null);
    setSending(true);

    try {
      if (imageUri) {
        const id = Crypto.randomUUID();
        const caption = hasText ? text : '';
        await appendMsg({ id, chatId: group.id, direction: 'out', body: caption, createdAt: Date.now(), type: 'image', mediaUri: imageUri });
        const { encryptAndUploadMedia } = require('../crypto/media');
        const blobUri = await encryptAndUploadMedia(imageUri, 'image/jpeg');
        // Persist the blob ref so the sent image survives cache purges (decrypt-on-view).
        await useMessages.getState().setMediaUri(group.id, id, blobUri);
        await sendGroupMessage({ identity, groupId: group.id, plaintext: `[image:${blobUri}]${caption}`, skipLocalAppend: true });
      }
      if (hasText && !imageUri) {
        const id = Crypto.randomUUID();
        await appendMsg({
          id,
          chatId: group.id,
          direction: 'out',
          body: text,
          createdAt: Date.now(),
          type: 'text',
          replyToId: replying?.id,
        });
        await sendGroupMessage({ identity, groupId: group.id, plaintext: text, skipLocalAppend: true });
      }
    } catch (e) {
      setDraft(text);
      if (imageUri) setStagedImageUri(imageUri);
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  }

  async function handleVoiceSend(uri: string, durationMs: number) {
    if (!identity) return;
    setShowVoiceRecorder(false);
    const durSec = Math.round(durationMs / 1000);
    try {
      const { encryptAndUploadMedia } = require('../crypto/media');
      const blobUri = await encryptAndUploadMedia(uri, 'audio/m4a');
      const id = Crypto.randomUUID();
      const body = `[audio:${durSec}s]`;
      await appendMsg({
        id,
        chatId: group.id,
        direction: 'out',
        body: `${identity.aegisId.substring(0, 8)}: ${body}`,
        createdAt: Date.now(),
        type: 'audio',
        mediaUri: uri,
      });
      await sendGroupMessage({
        identity,
        groupId: group.id,
        plaintext: body,
        msgType: 'audio',
        mediaUri: blobUri,
        skipLocalAppend: true,
      });
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }

  async function handleGroupCall() {
    if (!identity) return;
    // Call permission gate (UI side). Defaults to 'everyone'; groups that
    // explicitly set whoCanCall:'admins' via governance still block members here.
    const { can } = require('../crypto/groupRoles') as typeof import('../crypto/groupRoles');
    if (!can(group, identity.aegisId, 'call')) {
      themedAlert(
        i18nT('groupCall.adminOnlyTitle', 'Solo admins'),
        i18nT('groupCall.adminOnlyDetail', 'Solo los administradores pueden iniciar llamadas en este grupo.'),
      );
      return;
    }
    const otherMembers = group.members.filter((id) => id !== identity.aegisId);
    if (otherMembers.length === 0) {
      themedAlert(i18nT('groupCall.noMembers', 'Sin miembros'), i18nT('groupCall.noMembersDetail', 'No hay otros miembros en este grupo.'));
      return;
    }
    if (otherMembers.length > 7) {
      themedAlert(i18nT('groupCall.tooMany', 'Demasiados participantes'), i18nT('groupCall.tooManyDetail', 'Máx. 8 participantes en llamadas grupales.'));
      return;
    }
    try {
      const { startGroupCall } = require('../socket/groupCalls') as typeof import('../socket/groupCalls');
      await startGroupCall(identity, group, otherMembers);
      // No navigation — the in-call bar appears inline below the header.
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      style={{ flex: 1, backgroundColor: t.bg }}
    >
      <View style={{ flex: 1, paddingTop: insets.top }}>
        {/* Header */}
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
                onPress={() => { setSearchActive(false); setSearchQuery(''); }}
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
                onPress={onGroupDetail}
                style={{ flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, minWidth: 0 }}
              >
                <Avatar t={t} name={group.avatarImage || group.name} color={group.avatarColor || t.accent} size={36} seed={group.id} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 16, fontWeight: '600', color: t.text }}>
                    {group.name}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <I.Lock size={10} color={t.accent} />
                    <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5 }}>
                      {`E2EE · ${group.members.length} MIEMBROS`}
                    </Text>
                  </View>
                </View>
              </Pressable>
              <Pressable
                onPress={handleGroupCall}
                hitSlop={8}
                style={{ padding: 6 }}
                accessibilityLabel={i18nT('groupCall.startCall', 'Start group call')}
              >
                <I.Phone size={20} color={t.textDim} />
              </Pressable>
              <Pressable
                onPress={() => setSearchActive(true)}
                hitSlop={8}
                style={{ padding: 6 }}
                accessibilityLabel={i18nT('chat.searchMessages', 'Search messages')}
              >
                <I.Search size={20} color={t.textDim} />
              </Pressable>
              {onPoll && (
                <Pressable onPress={onPoll} hitSlop={8} style={{ padding: 6 }}>
                  <I.Poll size={20} color={t.textDim} />
                </Pressable>
              )}
              {onGroupDetail && (
                <Pressable onPress={onGroupDetail} hitSlop={8} style={{ padding: 6 }}>
                  <I.More size={20} color={t.textDim} />
                </Pressable>
              )}
            </>
          )}
        </View>

        {/* ── In-call bar (I'm in a call for this group) ─────────────────── */}
        {isInCallHere && (
          <InCallGroupBar
            status={myCallStatus}
            participants={myCallParticipants}
            contacts={contacts}
            muted={myCallMuted}
            startedAt={myCallStartedAt}
            onMute={() => {
              const { toggleGroupCallMute } = require('../socket/groupCalls') as typeof import('../socket/groupCalls');
              toggleGroupCallMute();
            }}
            onHangup={() => {
              const { hangupGroupCall } = require('../socket/groupCalls') as typeof import('../socket/groupCalls');
              hangupGroupCall();
            }}
            onExpand={() => onGroupCall?.()}
            t={t}
          />
        )}

        {/* Active voice-channel banner — join an open call without ringing */}
        {showCallBanner && activeCall && (
          <Pressable
            onPress={() => {
              const { joinGroupCall } = require('../socket/groupCalls') as typeof import('../socket/groupCalls');
              void joinGroupCall(group.id);
            }}
            accessibilityLabel={i18nT('groupCall.joinBanner', 'Unirse a la llamada de voz')}
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: 9,
              marginHorizontal: 12,
              marginTop: 10,
              paddingVertical: 11,
              paddingHorizontal: 12,
              borderRadius: 14,
              backgroundColor: `${t.accent}14`,
              borderWidth: 1,
              borderColor: `${t.accent}4d`,
              opacity: pressed ? 0.8 : 1,
            })}
          >
            <View style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: `${t.accent}22`, alignItems: 'center', justifyContent: 'center' }}>
              <I.Mic size={16} color={t.accent} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>
                {i18nT('groupCall.channelActive', 'Canal de voz activo')}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.4, marginTop: 1 }}>
                {i18nT('groupCall.inCallCount', { count: activeCall.participants.length, defaultValue: '{{count}} en llamada' }).toUpperCase()}
              </Text>
            </View>
            <View style={{ backgroundColor: t.accent, borderRadius: 99, paddingHorizontal: 14, paddingVertical: 7 }}>
              <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.accentInk }}>
                {i18nT('groupCall.join', 'Unirse')}
              </Text>
            </View>
          </Pressable>
        )}

        {/* Message List */}
        <FlatList
          ref={flatlistRef}
          data={filteredList}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12, gap: 10 }}
          showsVerticalScrollIndicator={false}
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
          renderItem={({ item }) => (
            <SwipeableMessage
              disabled={item.deleted}
              onReply={() => setReplyTo(item)}
              onDelete={item.direction === 'out' ? () => {
                themedAlert(
                  i18nT('groupChat.deleteMessage', 'Eliminar mensaje'),
                  i18nT('groupChat.deleteMessageConfirm', '¿Eliminar este mensaje?'),
                  [
                    { text: i18nT('common.cancel', 'Cancelar'), style: 'cancel' },
                    { text: i18nT('common.delete', 'Eliminar'), style: 'destructive', onPress: () => void softDelete(group.id, item.id) },
                  ]
                );
              } : () => {}}
            >
              <GroupBubble
                t={t}
                m={item}
                myAegisId={identity?.aegisId}
                memberNames={memberNames}
                adminId={group.adminId}
                moderators={group.moderators}
                groupName={group.name}
                onLongPress={() => setActionsMsg(item)}
                pollResult={pollResults[item.id]}
                onVote={(optionIndex, totalOptions) => void handleVote(item.id, optionIndex, totalOptions)}
                onImagePress={(images, index) => setViewer({ images, index })}
              />
            </SwipeableMessage>
          )}
          onContentSizeChange={() => {
            if (list.length === 0) return;
            if (!hasInitialScrolledRef.current) {
              // First layout pass for this group: snap to the latest message WITHOUT
              // animation so opening always lands at the bottom cleanly, no jump.
              flatlistRef.current?.scrollToEnd({ animated: false });
              hasInitialScrolledRef.current = true;
            } else if (isNearBottomRef.current) {
              flatlistRef.current?.scrollToEnd({ animated: false });
            }
          }}
        />

        {/* @ mention autocomplete */}
        {mentionMatches.length > 0 && (
          <View style={{ backgroundColor: t.surface, borderTopWidth: 1, borderTopColor: t.border }}>
            {mentionMatches.map(({ id, name }) => (
              <Pressable
                key={id}
                onPress={() => insertMention(name)}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  paddingHorizontal: 16, paddingVertical: 10,
                  backgroundColor: pressed ? t.surface2 : 'transparent',
                })}
              >
                <Avatar
                  t={t}
                  name={name}
                  color={contacts.find((c) => c.aegisId === id)?.color ?? colorFromId(id)}
                  size={28}
                  photoUri={contacts.find((c) => c.aegisId === id)?.avatarImage}
                  seed={contacts.find((c) => c.aegisId === id)?.publicKeyB64 || id}
                />
                <Text style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>@{name}</Text>
              </Pressable>
            ))}
          </View>
        )}

        {/* Reply banner */}
        {replyTo ? (
          <View
            style={{
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
              {replyTo.deleted ? i18nT('chat.deletedMessage') : replyTo.body || (replyTo.type === 'image' ? '📷 Imagen' : '…')}
            </Text>
            <Pressable onPress={() => setReplyTo(null)} hitSlop={8}>
              <I.X size={16} color={t.textDim} />
            </Pressable>
          </View>
        ) : null}

        {/* Staged image preview */}
        {imageProcessing && (
          <View style={{ backgroundColor: t.surface2, paddingHorizontal: 14, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: t.divider }}>
            <ActivityIndicator size="small" color={t.accent} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.6 }}>
              {i18nT('common.processingImage', 'Procesando imagen…')}
            </Text>
          </View>
        )}
        {stagedImageUri && !imageProcessing && (
          <View style={{ backgroundColor: t.surface2, paddingHorizontal: 14, paddingVertical: 8, flexDirection: 'row', alignItems: 'center', gap: 10, borderTopWidth: 1, borderTopColor: t.divider }}>
            <Image source={{ uri: stagedImageUri }} style={{ width: 48, height: 48, borderRadius: 8, backgroundColor: t.surface3 }} />
            <Text style={{ flex: 1, fontFamily: t.font, fontSize: 13, color: t.textDim }}>
              {i18nT('chat.imageReady', 'Imagen lista para enviar')}
            </Text>
            <Pressable onPress={() => setStagedImageUri(null)} hitSlop={8} style={{ padding: 4 }}>
              <I.X size={18} color={t.textDim} />
            </Pressable>
          </View>
        )}

        {/* Input Bar */}
        <View style={[styles.inputContainer, { borderTopColor: t.divider, paddingBottom: Math.max(insets.bottom, 12) }]}>
          {onAttach && (
            <Pressable onPress={onAttach} hitSlop={6} style={{ padding: 6 }} accessibilityLabel={i18nT('chat.attach', 'Attach file')}>
              <I.Attach size={22} color={t.textDim} />
            </Pressable>
          )}
          {!draft.trim() && !stagedImageUri && (
            <>
              <Pressable
                onPress={() => setGifPickerVisible(true)}
                hitSlop={6}
                style={{ padding: 6 }}
                accessibilityLabel="Open GIF picker"
              >
                <Text style={{ fontFamily: t.fontMono, fontSize: 11, fontWeight: '700', color: t.textDim, letterSpacing: 0.5 }}>
                  GIF
                </Text>
              </Pressable>
              <Pressable
                onPress={() => setShowVoiceRecorder(true)}
                hitSlop={6}
                style={{ padding: 6 }}
                accessibilityLabel={i18nT('chat.voiceNote', 'Record voice note')}
              >
                <I.Mic size={22} color={t.textDim} />
              </Pressable>
            </>
          )}
          <TextInput
            placeholder={i18nT('groupChat.messagePlaceholder', 'Group message…')}
            placeholderTextColor={t.textDim}
            value={draft}
            onChangeText={handleDraftChange}
            accessibilityLabel="Campo de mensaje"
            multiline
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={() => {
              // Soft-keyboard "send" key. submitBehavior="submit" (RN 0.81) fires
              // onSubmitEditing on a multiline input without inserting a newline or
              // dismissing the keyboard.
              if (draft.trim() || stagedImageUri) void handleSend();
            }}
            style={[styles.input, { color: t.text, backgroundColor: t.surface2, borderColor: t.border, fontFamily: t.font }]}
          />
          <Pressable
            onPress={() => void handleSend()}
            // Owner/moderators: long-press hands the draft to the full scheduled
            // posts composer (GroupPosts screen). Members get no gesture.
            onLongPress={() => { if (canSchedulePost && draft.trim()) onSchedulePost?.(draft.trim()); }}
            disabled={(!draft.trim() && !stagedImageUri) || sending || imageProcessing}
            accessibilityLabel={canSchedulePost ? i18nT('groupChat.sendOrSchedule', 'Send — long-press to schedule post') : undefined}
            style={({ pressed }) => [
              styles.sendBtn,
              { backgroundColor: (draft.trim() || stagedImageUri) && online ? t.accent : t.surface2, opacity: pressed ? 0.8 : 1 },
            ]}
          >
            {sending ? (
              <ActivityIndicator size="small" color={t.accentInk} />
            ) : (
              <I.Send size={18} color={(draft.trim() || stagedImageUri) && online ? t.accentInk : t.textDim} />
            )}
          </Pressable>
        </View>
      </View>

      <ForwardModal visible={forwardBody !== null} body={forwardBody ?? ''} onClose={() => setForwardBody(null)} />
      <GifPicker
        visible={gifPickerVisible}
        onClose={() => setGifPickerVisible(false)}
        onSelectGif={handleGifSelect}
        onSelectSticker={handleStickerSelect}
      />
      <ImageViewerModal images={viewer?.images ?? null} initialIndex={viewer?.index ?? 0} onClose={() => setViewer(null)} t={t} />
      <MediaEditorModal
        t={t}
        visible={editorUri !== null}
        imageUri={editorUri}
        captionPlaceholder={i18nT('chat.addCaption')}
        onCancel={() => setEditorUri(null)}
        onSend={({ uri, caption }) => { void sendEditedImage(uri, caption); }}
      />
      <MessageActionsSheet
        visible={!!actionsMsg}
        body={actionsMsg?.body ?? ''}
        starred={actionsMsg?.starred ?? false}
        canDelete={actionsMsg?.direction === 'out'}
        onClose={() => setActionsMsg(null)}
        onReply={() => { if (actionsMsg) setReplyTo(actionsMsg); setActionsMsg(null); }}
        onForward={() => { setForwardBody(actionsMsg?.body ?? ''); setActionsMsg(null); }}
        onStar={handleStar}
        onDelete={handleDelete}
        onReact={handleReact}
      />
      {/* Voice recorder — full-screen modal */}
      <Modal
        visible={showVoiceRecorder}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowVoiceRecorder(false)}
      >
        <VoiceRecorderScreen
          onBack={() => setShowVoiceRecorder(false)}
          onSend={handleVoiceSend}
        />
      </Modal>

    </KeyboardAvoidingView>
    </GestureHandlerRootView>
  );
}

// ─── Group Bubble ─────────────────────────────────────────────────────────────

function parsePollBody(body: string): { question: string; options: string[] } | null {
  if (!body.startsWith('[poll:') || !body.endsWith(']')) return null;
  const inner = body.slice(6, -1); // strip '[poll:' and ']'
  const parts = inner.split('|');
  if (parts.length < 3) return null;
  const question = parts[0].trim();
  const options = parts.slice(1).map((o) => o.trim());
  return { question, options };
}

interface GroupBubbleProps {
  t: Theme;
  m: StoredMessage;
  myAegisId?: string;
  memberNames: Record<string, string>;
  adminId?: string;
  moderators?: string[];
  /** For announcement posts published "as the group" (post marker 'g'). */
  groupName?: string;
  onLongPress: () => void;
  pollResult?: PollResult;
  onVote: (optionIndex: number, totalOptions: number) => void;
  onImagePress?: (images: string[], index: number) => void;
}

function GroupBubble({
  t,
  m,
  myAegisId,
  memberNames,
  adminId,
  moderators,
  groupName,
  onLongPress,
  pollResult,
  onVote,
  onImagePress,
}: GroupBubbleProps) {
  const { t: i18nT } = useTranslation();
  const me = m.direction === 'out';
  const time = new Date(m.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const reactions = m.reactions ? Object.entries(m.reactions).filter(([, ids]) => ids.length > 0) : [];

  // Parse "SenderName: text" format for incoming group messages.
  // senderId is only considered verified when it resolves to a known memberNames
  // aegisId — if the name is not found in the map the id is unverifiable
  // (spoofable by body content) and badges are suppressed.
  // TODO: usar senderAegisId del sobre cifrado cuando el protocolo lo exponga.
  let sender = '';
  let body = m.body;
  let senderId = '';
  let senderVerified = false;
  if (!me && body.includes(': ')) {
    const colonIdx = body.indexOf(': ');
    sender = body.substring(0, colonIdx);
    body = body.substring(colonIdx + 2);
    const found = Object.entries(memberNames).find(([, n]) => n === sender);
    if (found) {
      senderId = found[0];
      senderVerified = true;
    } else {
      senderId = sender;
      senderVerified = false;
    }
  }

  const senderColor = senderId ? colorFromId(senderId) : t.accent;
  // Only show ADMIN/MOD badges when senderId is resolved from the authenticated
  // member map — prevents display-name spoofing attacks.
  const senderIsAdmin = senderVerified && senderId && adminId ? senderId === adminId : false;
  const senderIsMod = senderVerified && senderId && moderators ? moderators.includes(senderId) : false;

  // Scheduled-post marker: strip it from the display body up-front so every
  // downstream branch (text, image caption, etc.) renders clean text. Text
  // posts get the dedicated announcement card below. Only honour announcement
  // styling from verified admins/mods — a regular member crafting the marker
  // gets it stripped but NO announcement framing (anti-spoofing).
  const postParsed = parseGroupPostMarker(body);
  if (postParsed.isPost) body = postParsed.text;
  const isAnnouncement = postParsed.isPost && (me || senderIsAdmin || senderIsMod);

  if (m.deleted) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        <View style={{ backgroundColor: t.surface2, paddingHorizontal: 13, paddingVertical: 8, borderRadius: t.radius, flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <I.Trash size={13} color={t.textFaint} />
          <Text style={{ color: t.textFaint, fontFamily: t.font, fontSize: 13, fontStyle: 'italic' }}>
            {i18nT('groupChat.deletedMessage', 'Deleted message')}
          </Text>
        </View>
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginTop: 3, paddingHorizontal: 4 }}>{time}</Text>
      </View>
    );
  }

  const poll = parsePollBody(body);
  if (poll) {
    const totalVotes = pollResult ? pollResult.counts.reduce((a: number, b: number) => a + b, 0) : 0;
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
            {senderIsAdmin && (
              <View style={{ backgroundColor: `${t.accent}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</Text>
              </View>
            )}
            {senderIsMod && (
              <View style={{ backgroundColor: `${t.warn}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>{i18nT('groupChat.modBadge', 'MOD')}</Text>
              </View>
            )}
          </View>
        ) : null}
        <View style={{
          width: 260,
          backgroundColor: me ? t.bubbleOut : t.bubbleIn,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          padding: 12,
        }}>
          <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '600', color: me ? t.bubbleOutText : t.text, marginBottom: 10 }}>
            {poll.question}
          </Text>
          <View style={{ gap: 8 }}>
            {poll.options.map((opt, idx) => {
              const votes = pollResult?.counts[idx] ?? 0;
              const pct = totalVotes > 0 ? votes / totalVotes : 0;
              const selected = pollResult?.myVote === idx;
              return (
                <Pressable
                  key={idx}
                  onPress={() => onVote(idx, poll.options.length)}
                  style={({ pressed }) => ({
                    height: 38,
                    borderRadius: 6,
                    borderWidth: 1,
                    borderColor: selected ? t.accent : t.border,
                    flexDirection: 'row',
                    alignItems: 'center',
                    paddingHorizontal: 12,
                    position: 'relative',
                    overflow: 'hidden',
                    opacity: pressed ? 0.8 : 1,
                  })}
                >
                  <AnimatedPollBar pct={pct} selected={selected} accent={t.accent} text={t.text} />
                  <View style={{ flex: 1, flexDirection: 'row', justifyContent: 'space-between', zIndex: 1 }}>
                    <Text style={{ fontFamily: t.font, fontSize: 13, color: me ? t.bubbleOutText : t.text, fontWeight: selected ? '600' : '400' }}>
                      {opt}
                    </Text>
                    <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: me ? t.bubbleOutText : t.textDim }}>
                      {votes}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </View>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: 10, paddingTop: 8, borderTopWidth: 1, borderTopColor: me ? 'rgba(255,255,255,0.15)' : t.divider }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, color: me ? t.bubbleOutText : t.textDim }}>
              {i18nT('groupChat.anonymousVotes', 'Anonymous Poll · {{count}} votes', { count: totalVotes })}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, color: me ? t.bubbleOutText : t.textDim }}>
              {time}
            </Text>
          </View>
        </View>
        <ReactionPills t={t} reactions={reactions} me={me} />
      </View>
    );
  }

  // ── Scheduled announcement card (text posts) ──────────────────────────────
  // Accent-framed card with ANUNCIO chip; "as group" posts show the group name
  // as author, otherwise the sender chip row renders as usual above the card.
  if (isAnnouncement && (m.type === 'text' || !m.type)) {
    const showGroupAuthor = postParsed.asGroup;
    // In the Vault palettes `accent` and `bubbleOut` are the SAME colour, so
    // accent-coloured framing (border, icon, chips) is invisible on our own
    // outgoing bubble. Frame with the bubble's text colour on `me` instead.
    const frame = me ? t.bubbleOutText : t.accent;
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {!showGroupAuthor && sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
            {senderIsAdmin && (
              <View style={{ backgroundColor: `${t.accent}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</Text>
              </View>
            )}
            {senderIsMod && (
              <View style={{ backgroundColor: `${t.warn}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>{i18nT('groupChat.modBadge', 'MOD')}</Text>
              </View>
            )}
          </View>
        ) : null}
        <Pressable
          onLongPress={onLongPress}
          style={{
            maxWidth: 290,
            backgroundColor: me ? t.bubbleOut : t.bubbleIn,
            borderWidth: 1,
            borderColor: `${frame}55`,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            padding: 12,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 8 }}>
            <I.Users size={13} color={frame} />
            {showGroupAuthor && groupName ? (
              <Text numberOfLines={1} style={{ flexShrink: 1, fontFamily: t.font, fontSize: 12, fontWeight: '600', color: me ? t.bubbleOutText : t.text }}>
                {groupName}
              </Text>
            ) : null}
            <View style={{ borderWidth: 1, borderColor: `${frame}55`, borderRadius: 99, paddingHorizontal: 6, paddingVertical: 1 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 8.5, color: frame, letterSpacing: 0.5 }}>
                {i18nT('groupPosts.announceChip', 'ANUNCIO')}
              </Text>
            </View>
            {postParsed.pinned && (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 3, borderWidth: 1, borderColor: `${frame}55`, borderRadius: 99, paddingHorizontal: 6, paddingVertical: 1 }}>
                <I.Shield size={9} color={frame} />
                <Text style={{ fontFamily: t.fontMono, fontSize: 8.5, color: frame, letterSpacing: 0.5 }}>
                  {i18nT('groupPosts.pinnedChip', 'FIJADO')}
                </Text>
              </View>
            )}
          </View>
          <FormattedText
            body={body}
            t={t}
            onAccent={me}
            style={{ color: me ? t.bubbleOutText : t.text, fontFamily: t.font, fontSize: 14.5, lineHeight: 21 }}
          />
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 8, paddingTop: 7, borderTopWidth: 1, borderTopColor: me ? 'rgba(255,255,255,0.15)' : t.divider }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: me ? t.bubbleOutText : t.textDim, letterSpacing: 0.5 }}>
              {postParsed.repliesOff ? i18nT('groupPosts.readOnlyTag', 'SOLO LECTURA') : ''}
            </Text>
            <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, color: me ? t.bubbleOutText : t.textDim }}>
              {time}
            </Text>
          </View>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
      </View>
    );
  }

  const loc = parseLocationMessage(body);
  if (loc) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
            {senderIsAdmin && (
              <View style={{ backgroundColor: `${t.accent}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</Text>
              </View>
            )}
            {senderIsMod && (
              <View style={{ backgroundColor: `${t.warn}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>{i18nT('groupChat.modBadge', 'MOD')}</Text>
              </View>
            )}
          </View>
        ) : null}
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
            opacity: pressed ? 0.9 : 1,
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
                <LinearGradient id="grpLocMapBg" x1="0" y1="0" x2="1" y2="1">
                  {(t.dark ? ['#1a2326', '#243033'] : ['#e8e5dc', '#d8d4c6']).map((c, i) => (
                    <Stop key={i} offset={i} stopColor={c} />
                  ))}
                </LinearGradient>
              </Defs>
              <Rect x="0" y="0" width="250" height="110" fill="url(#grpLocMapBg)" />
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
              📍 {i18nT('groupChat.locationShared', 'Shared location')} {loc.precision} · {loc.duration}
            </Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6, paddingTop: 6, borderTopWidth: 1, borderTopColor: t.divider }}>
              <I.Globe size={11} color={t.accent} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 9.5, fontWeight: '600', color: t.accent, letterSpacing: 0.3 }}>
                {i18nT('groupChat.openMaps', 'OPEN IN MAPS')}
              </Text>
            </View>
          </View>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingHorizontal: 4 }}>
          {time}
        </Text>
      </View>
    );
  }

  // Multi-attachment bubble
  if (m.attachments && m.attachments.length > 0) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender && (
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor, marginBottom: 2 }}>
            {sender}
          </Text>
        )}
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
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingHorizontal: 4 }}>
          {time}
        </Text>
      </View>
    );
  }

  // Video bubble
  if (m.type === 'video') {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
            {senderIsAdmin && (
              <View style={{ backgroundColor: `${t.accent}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</Text>
              </View>
            )}
            {senderIsMod && (
              <View style={{ backgroundColor: `${t.warn}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>{i18nT('groupChat.modBadge', 'MOD')}</Text>
              </View>
            )}
          </View>
        ) : null}
        <VideoBubble t={t} m={m} me={me} time={time} onLongPress={onLongPress} caption={body ?? undefined} />
        <ReactionPills t={t} reactions={reactions} me={me} />
      </View>
    );
  }

  // Audio bubble
  if (m.type === 'audio' && m.mediaUri) {
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
            {senderIsAdmin && (
              <View style={{ backgroundColor: `${t.accent}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</Text>
              </View>
            )}
            {senderIsMod && (
              <View style={{ backgroundColor: `${t.warn}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>{i18nT('groupChat.modBadge', 'MOD')}</Text>
              </View>
            )}
          </View>
        ) : null}
        <GroupAudioBubble t={t} m={m} me={me} body={body} onLongPress={onLongPress} />
        <ReactionPills t={t} reactions={reactions} me={me} />
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingHorizontal: 4 }}>
          {time}
        </Text>
      </View>
    );
  }

  // File bubble
  if (m.type === 'file') {
    // `body` is the local variable with the sender prefix already stripped
    // (e.g. "document.pdf", not "Alice: document.pdf")
    const fileName = body || m.body || 'file';
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
            {senderIsAdmin && (
              <View style={{ backgroundColor: `${t.accent}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</Text>
              </View>
            )}
            {senderIsMod && (
              <View style={{ backgroundColor: `${t.warn}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>{i18nT('groupChat.modBadge', 'MOD')}</Text>
              </View>
            )}
          </View>
        ) : null}
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
            opacity: pressed ? 0.9 : 1,
          })}
        >
          <I.Attach size={20} color={me ? t.bubbleOutText : t.bubbleInText} />
          <Text numberOfLines={2} style={{ flex: 1, color: me ? t.bubbleOutText : t.bubbleInText, fontFamily: t.font, fontSize: 14 }}>
            {fileName}
          </Text>
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingHorizontal: 4 }}>
          {time}
        </Text>
      </View>
    );
  }

  // Image bubble
  if (m.type === 'image' && m.mediaUri) {
    const bubbleBg = me ? t.bubbleOut : t.bubbleIn;
    const textColor = me ? t.bubbleOutText : t.bubbleInText;
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
            {senderIsAdmin && (
              <View style={{ backgroundColor: `${t.accent}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</Text>
              </View>
            )}
            {senderIsMod && (
              <View style={{ backgroundColor: `${t.warn}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>{i18nT('groupChat.modBadge', 'MOD')}</Text>
              </View>
            )}
          </View>
        ) : null}
        <Pressable
          onPress={() => onImagePress?.([m.mediaUri!], 0)}
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            width: 200,
            backgroundColor: bubbleBg,
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            overflow: 'hidden',
            opacity: pressed ? 0.9 : 1,
          })}
        >
          <MediaImage
            uri={m.mediaUri}
            accent={t.accent}
            style={{ width: 200, height: 150, backgroundColor: t.surface2 }}
          />
          {body ? (
            <View style={{ paddingHorizontal: 10, paddingTop: 8, paddingBottom: 6 }}>
              <FormattedText
                body={body}
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
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingHorizontal: 4 }}>
          {time}
        </Text>
      </View>
    );
  }

  // Vault sticker bubble — [sticker:vault_<key>]
  const stickerMatch = body.match(/^\[sticker:(vault_\w+)\]$/);
  if (stickerMatch) {
    const { VaultSticker } = require('../components/stickers/VaultPack') as typeof import('../components/stickers/VaultPack');
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
          </View>
        ) : null}
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
            opacity: pressed ? 0.85 : 1,
          })}
        >
          <VaultSticker stickerKey={stickerMatch[1]} size={120} />
        </Pressable>
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginTop: 3 }}>{time}</Text>
      </View>
    );
  }

  // GIF bubble
  const gifMatch = body.match(/^\[gif:(.+)\]$/);
  if (gifMatch) {
    const gifUrl = gifMatch[1];
    return (
      <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
        {sender ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
          </View>
        ) : null}
        <Pressable
          onLongPress={onLongPress}
          style={({ pressed }) => ({
            borderRadius: t.radius,
            borderTopRightRadius: me ? t.radiusS : t.radius,
            borderTopLeftRadius: me ? t.radius : t.radiusS,
            overflow: 'hidden',
            opacity: pressed ? 0.9 : 1,
          })}
        >
          <Image
            source={{ uri: gifUrl }}
            style={{ width: 200, height: 150, backgroundColor: t.surface2 }}
            resizeMode="cover"
          />
        </Pressable>
        <ReactionPills t={t} reactions={reactions} me={me} />
        <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingHorizontal: 4 }}>
          {time}
        </Text>
      </View>
    );
  }

  // Text bubble
  return (
    <View style={{ alignItems: me ? 'flex-end' : 'flex-start' }}>
      {sender ? (
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 2 }}>
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: senderColor }}>{sender}</Text>
          {senderIsAdmin && (
            <View style={{ backgroundColor: `${t.accent}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent }}>ADMIN</Text>
            </View>
          )}
          {senderIsMod && (
            <View style={{ backgroundColor: `${t.warn}22`, paddingHorizontal: 4, paddingVertical: 1, borderRadius: 3 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.warn }}>{i18nT('groupChat.modBadge', 'MOD')}</Text>
            </View>
          )}
        </View>
      ) : null}
      <Pressable
        onLongPress={onLongPress}
        style={({ pressed }) => ({
          backgroundColor: me ? t.bubbleOut : t.bubbleIn,
          paddingHorizontal: 13,
          paddingVertical: 10,
          borderRadius: t.radius,
          borderTopRightRadius: me ? t.radiusS : t.radius,
          borderTopLeftRadius: me ? t.radius : t.radiusS,
          opacity: pressed ? 0.9 : 1,
        })}
      >
        <FormattedText
          body={body}
          t={t}
          onAccent={me}
          style={{ fontFamily: t.font, fontSize: 15, lineHeight: 21, color: me ? t.bubbleOutText : t.text }}
        />
        {/* Open Graph link preview card */}
        {(() => {
          const match = /\bhttps?:\/\/[^\s<>"')\]]+/.exec(body ?? '');
          return match ? <LinkPreview url={match[0]} t={t} /> : null;
        })()}
      </Pressable>
      <ReactionPills t={t} reactions={reactions} me={me} />
      <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, alignSelf: me ? 'flex-end' : 'flex-start', marginTop: 3, paddingHorizontal: 4 }}>
        {time}
      </Text>
    </View>
  );
}





function ReactionPills({ t, reactions, me }: { t: Theme; reactions: [string, string[]][]; me: boolean }) {
  if (reactions.length === 0) return null;
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 4, marginTop: 4, justifyContent: me ? 'flex-end' : 'flex-start' }}>
      {reactions.map(([emoji, ids]) => (
        <View
          key={emoji}
          style={{
            flexDirection: 'row', alignItems: 'center', gap: 3,
            backgroundColor: t.surface2, borderRadius: 99,
            paddingHorizontal: 8, paddingVertical: 3,
            borderWidth: 1, borderColor: t.border,
          }}
        >
          <Text style={{ fontSize: 13 }}>{emoji}</Text>
          {ids.length > 1 ? <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim }}>{ids.length}</Text> : null}
        </View>
      ))}
    </View>
  );
}

const GROUP_PLAYBACK_RATES: number[] = [1.0, 1.5, 2.0, 0.5];

function GroupAudioBubble({ t, m, me, body, onLongPress }: { t: Theme; m: StoredMessage; me: boolean; body: string; onLongPress: () => void }) {
  const [playing, setPlaying] = useState(false);
  const [posMs, setPosMs] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  type AudioSound = import('expo-av').Audio.Sound;
  type AVPlaybackStatus = import('expo-av').AVPlaybackStatus;
  const soundRef = useRef<AudioSound | null>(null);
  const durSec = parseInt(body.match(/\[audio:(\d+)s/)?.[1] ?? '0', 10);

  useEffect(() => {
    return () => {
      void soundRef.current?.unloadAsync().catch(() => {});
    };
  }, []);

  async function togglePlay() {
    if (!m.mediaUri) return;
    if (playing) {
      await soundRef.current?.stopAsync().catch(() => {});
      await soundRef.current?.unloadAsync().catch(() => {});
      soundRef.current = null;
      setPosMs(0); setPlaying(false);
      return;
    }
    try {
      const { Audio } = require('expo-av');
      await Audio.setAudioModeAsync({ allowsRecordingIOS: false, playsInSilentModeIOS: true });
      const { sound } = await Audio.Sound.createAsync(
        { uri: m.mediaUri }, { shouldPlay: true, rate: playbackRate, shouldCorrectPitch: true },
        (s: AVPlaybackStatus) => {
          if (!s.isLoaded) return;
          setPosMs(s.positionMillis ?? 0);
          if (s.didJustFinish) { setPlaying(false); setPosMs(0); soundRef.current = null; }
        }
      );
      soundRef.current = sound;
      setPlaying(true);
    } catch { setPlaying(false); }
  }

  async function cycleRate() {
    const currentIndex = GROUP_PLAYBACK_RATES.indexOf(playbackRate);
    const nextRate = GROUP_PLAYBACK_RATES[(currentIndex + 1) % GROUP_PLAYBACK_RATES.length];
    setPlaybackRate(nextRate);
    if (soundRef.current) {
      try { await soundRef.current.setRateAsync(nextRate, true); } catch { /* ignore */ }
    }
  }

  const durMs = durSec * 1000;
  const elapsed = Math.floor(posMs / 1000);
  const display = playing
    ? `${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`
    : `${String(Math.floor(durSec / 60)).padStart(2, '0')}:${String(durSec % 60).padStart(2, '0')}`;

  async function handleSeek(seekMs: number) {
    if (!soundRef.current) return;
    try {
      await soundRef.current.setPositionAsync(seekMs);
      setPosMs(seekMs);
    } catch { /* ignore */ }
  }

  const rateLabel = playbackRate === 1.0 ? '1×' : `${playbackRate}×`;

  return (
    <Pressable
      onLongPress={onLongPress}
      style={({ pressed }) => ({
        flexDirection: 'row', alignItems: 'center', gap: 10, width: 230,
        backgroundColor: me ? t.bubbleOut : t.bubbleIn,
        paddingHorizontal: 12, paddingVertical: 10, borderRadius: t.radius,
        opacity: pressed ? 0.9 : 1,
      })}
    >
      <Pressable onPress={togglePlay} style={{
        width: 34, height: 34, borderRadius: 17,
        backgroundColor: me ? 'rgba(255,255,255,0.2)' : t.surface3,
        alignItems: 'center', justifyContent: 'center',
      }}>
        {playing
          ? <I.Pause size={15} color={me ? t.bubbleOutText : t.bubbleInText} />
          : <I.Play size={15} color={me ? t.bubbleOutText : t.bubbleInText} />}
      </Pressable>
      <View style={{ flex: 1, gap: 4 }}>
        <AudioWaveform
          durMs={durMs}
          posMs={posMs}
          width={142}
          maxBarHeight={22}
          onSeek={handleSeek}
          t={t}
          isMe={me}
        />
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.textDim }}>{display}</Text>
      </View>
      <Pressable
        onPress={cycleRate}
        accessibilityLabel={`Playback speed ${rateLabel}`}
        hitSlop={8}
        style={{
          paddingHorizontal: 4,
          paddingVertical: 3,
          borderRadius: 4,
          backgroundColor: me ? 'rgba(255,255,255,0.15)' : t.surface3,
          alignItems: 'center',
          justifyContent: 'center',
          minWidth: 26,
        }}
      >
        <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: me ? t.bubbleOutText : t.textDim, fontWeight: '700' }}>
          {rateLabel}
        </Text>
      </Pressable>
      <I.Mic size={13} color={me ? t.bubbleOutText : t.textDim} />
    </Pressable>
  );
}

// ---------------------------------------------------------------------------
// In-call bar — shown inline in GroupChatScreen while the user is in a call
// ---------------------------------------------------------------------------

interface InCallGroupBarProps {
  status: import('../store/groupCall').GroupCallStatus;
  participants: import('../store/groupCall').GroupCallParticipant[];
  contacts: import('../db/local').StoredContact[];
  muted: boolean;
  startedAt: number | null;
  onMute: () => void;
  onHangup: () => void;
  onExpand: () => void;
  t: Theme;
}

function InCallGroupBar({ status, participants, contacts, muted, startedAt, onMute, onHangup, onExpand, t }: InCallGroupBarProps) {
  const { t: i18nT } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (status !== 'in-call' || !startedAt) return;
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [status, startedAt]);

  function nameForId(aegisId: string): string {
    return contacts.find((c) => c.aegisId === aegisId)?.name ?? aegisId.substring(0, 6);
  }

  const visible = participants.filter((p) => p.connected);
  const avatarsToShow = visible.slice(0, 4);
  const overflow = visible.length - avatarsToShow.length;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 8,
        marginHorizontal: 12,
        marginTop: 8,
        marginBottom: 4,
        paddingVertical: 10,
        paddingHorizontal: 12,
        borderRadius: 14,
        backgroundColor: `${t.accent}12`,
        borderWidth: 1,
        borderColor: `${t.accent}40`,
      }}
    >
      {/* Pulsing status dot */}
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: status === 'in-call' ? t.accent : t.warn }} />

      {/* Status + timer */}
      <View style={{ flex: 1, minWidth: 0 }}>
        {status === 'connecting' ? (
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.warn, letterSpacing: 0.5 }}>
            {i18nT('groupCall.connecting', 'CONECTANDO…').toUpperCase()}
          </Text>
        ) : (
          <>
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5 }}>
              {'E2EE · '}
              {`${String(Math.floor(elapsed / 60)).padStart(2, '0')}:${String(elapsed % 60).padStart(2, '0')}`}
            </Text>
            {/* Participant mini-avatars */}
            {avatarsToShow.length > 0 && (
              <View style={{ flexDirection: 'row', alignItems: 'center', marginTop: 3, gap: -4 }}>
                {avatarsToShow.map((p) => {
                  const name = nameForId(p.aegisId);
                  const initial = name.trim()[0]?.toUpperCase() ?? '?';
                  return (
                    <View
                      key={p.aegisId}
                      style={{
                        width: 18, height: 18, borderRadius: 9,
                        backgroundColor: t.accent,
                        alignItems: 'center', justifyContent: 'center',
                        borderWidth: 1, borderColor: t.bg,
                      }}
                    >
                      <Text style={{ fontFamily: t.font, fontSize: 9, color: '#fff', fontWeight: '700' }}>
                        {initial}
                      </Text>
                    </View>
                  );
                })}
                {overflow > 0 && (
                  <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginLeft: 6 }}>
                    {`+${overflow}`}
                  </Text>
                )}
                {visible.length === 0 && (
                  <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim }}>
                    {i18nT('groupCall.alone', 'Solo en el canal')}
                  </Text>
                )}
              </View>
            )}
            {avatarsToShow.length === 0 && (
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginTop: 2 }}>
                {i18nT('groupCall.alone', 'Solo en el canal — esperando participantes')}
              </Text>
            )}
          </>
        )}
      </View>

      {/* Mute */}
      <Pressable
        onPress={onMute}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={muted ? i18nT('call.unmute', 'Reanudar mic') : i18nT('call.mute', 'Silenciar mic')}
        style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: muted ? `${t.warn}22` : t.surface2,
          borderWidth: 1, borderColor: muted ? t.warn : t.border,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        {muted ? <I.MicOff size={14} color={t.warn} /> : <I.Mic size={14} color={t.textDim} />}
      </Pressable>

      {/* Expand to full call screen */}
      <Pressable
        onPress={onExpand}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={i18nT('groupCall.expandCall', 'Ver pantalla completa')}
        style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: t.surface2,
          borderWidth: 1, borderColor: t.border,
          alignItems: 'center', justifyContent: 'center',
        }}
      >
        <I.Users size={14} color={t.textDim} />
      </Pressable>

      {/* Hangup */}
      <Pressable
        onPress={onHangup}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={i18nT('call.hangup', 'Colgar')}
        style={{
          width: 32, height: 32, borderRadius: 16,
          backgroundColor: t.danger,
          alignItems: 'center', justifyContent: 'center',
          transform: [{ rotate: '135deg' }],
        }}
      >
        <I.Phone size={14} color="#fff" />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    height: 56, flexDirection: 'row', alignItems: 'center',
    paddingHorizontal: 12, borderBottomWidth: 1, gap: 8,
  },
  inputContainer: {
    flexDirection: 'row', alignItems: 'flex-end',
    paddingHorizontal: 12, paddingTop: 8, borderTopWidth: 1, gap: 8,
  },
  input: {
    flex: 1, borderWidth: 1, borderRadius: 22,
    paddingHorizontal: 16, paddingTop: 8, paddingBottom: 8,
    maxHeight: 100, fontSize: 15,
  },
  sendBtn: {
    width: 38, height: 38, borderRadius: 19,
    alignItems: 'center', justifyContent: 'center', marginBottom: 1,
  },
});

function AnimatedPollBar({ pct, selected, accent, text }: { pct: number; selected: boolean; accent: string; text: string }) {
  const widthAnim = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    Animated.timing(widthAnim, { toValue: pct * 100, duration: 600, useNativeDriver: false }).start();
  }, [pct, widthAnim]);
  return (
    <Animated.View
      style={{
        position: 'absolute',
        top: 0, left: 0, bottom: 0,
        width: widthAnim.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
        backgroundColor: selected ? `${accent}28` : `${text}0d`,
        borderRadius: 6,
      }}
    />
  );
}
