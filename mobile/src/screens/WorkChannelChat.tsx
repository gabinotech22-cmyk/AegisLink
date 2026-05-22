import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useWorkPresence } from '../store/workPresence';
import {
  View,
  Text,
  FlatList,
  Image,
  TextInput,
  Pressable,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  Vibration,
  Modal,
  Animated,
  Clipboard,
  ActivityIndicator,
  Linking,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as FileSystem from 'expo-file-system/legacy';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useWorkMessages } from '../store/workMessages';
import { useWork } from '../store/work';
import { useIdentity } from '../store/identity';
import { useConnection } from '../store/connection';
import { joinChannel, getSocket, emitDeleteChannelMsg } from '../socket/client';
import type { WorkChannel, WorkMember } from '../store/work';
import type { WorkMessage, WorkAttachment, PinEvent } from '../store/workMessages';
import { SERVER_URL } from '../config';
import { withPickingGuard } from '../utils/pickingGuard';
import { uploadWorkBlob } from '../utils/workUpload';
import { getPermissions, type WorkRole } from '../utils/workPermissions';

// ─── Haptic helper (mirrors useSoundFX pattern) ───────────────────────────────

function hapticMention(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Haptics = require('expo-haptics') as {
      notificationAsync: (t: unknown) => Promise<void>;
      NotificationFeedbackType: { Success: unknown };
    };
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
  } catch {
    Vibration.vibrate([0, 10, 50, 10]);
  }
}

// ─── Mention parsing helpers ──────────────────────────────────────────────────

/** Extract the active @-mention query at the given cursor position, or null. */
function parseMentionQuery(text: string, cursor: number): string | null {
  // Walk backwards from cursor to find the nearest '@'
  const before = text.slice(0, cursor);
  const atIndex = before.lastIndexOf('@');
  if (atIndex === -1) return null;

  // If there's a space between '@' and the cursor, the mention was "closed"
  const fragment = before.slice(atIndex + 1);
  if (fragment.includes(' ')) return null;

  return fragment; // may be empty string when user just typed '@'
}

/** Insert `@aegis_id ` at the active mention position, replacing the partial. */
function insertMention(text: string, cursor: number, aegisId: string): string {
  const atIndex = text.slice(0, cursor).lastIndexOf('@');
  if (atIndex === -1) return text;
  const before = text.slice(0, atIndex);
  const after = text.slice(cursor);
  return `${before}@${aegisId} ${after}`;
}

/** Cursor position after inserting a mention. */
function mentionCursorPos(text: string, cursor: number, aegisId: string): number {
  const atIndex = text.slice(0, cursor).lastIndexOf('@');
  if (atIndex === -1) return cursor;
  // '@' + aegisId + ' '
  return atIndex + aegisId.length + 2;
}

// ─── File downloading ─────────────────────────────────────────────────────────

async function downloadAndShare(blobId: string, filename: string) {
  try {
    const url = `${SERVER_URL}/files/${blobId}/download`;
    const localUri = FileSystem.cacheDirectory + filename;
    const { uri } = await FileSystem.downloadAsync(url, localUri);
    await Sharing.shareAsync(uri);
  } catch (err) {
    console.warn('Download error', err);
  }
}

// ─── Inline mention rendering ─────────────────────────────────────────────────

interface MentionTextProps {
  body: string;
  myAegisId: string;
  isOwn: boolean;
  accentColor: string;
  baseStyle: object;
}

function MentionText({ body, myAegisId, isOwn, accentColor, baseStyle }: MentionTextProps) {
  // Split on @word boundaries — capture group keeps delimiters in the result
  const parts = body.split(/(@[\w\-.]+)/g);

  return (
    <Text style={baseStyle}>
      {parts.map((part, idx) => {
        if (part.startsWith('@')) {
          const mentioned = part.slice(1);
          const isSelf = mentioned === myAegisId;
          return (
            <Text
              key={idx}
              style={[
                { fontWeight: '600' },
                isSelf
                  ? { color: accentColor }
                  : isOwn
                  ? { color: 'rgba(6,35,26,0.85)' }
                  : { color: accentColor },
              ]}
            >
              {part}
            </Text>
          );
        }
        return <Text key={idx}>{part}</Text>;
      })}
    </Text>
  );
}

// ─── Typing indicator ─────────────────────────────────────────────────────────

function TypingIndicator({ typingIds, t }: { typingIds: string[]; t: import('../theme/vault').Theme }) {
  const dot1 = useRef(new Animated.Value(0.3)).current;
  const dot2 = useRef(new Animated.Value(0.3)).current;
  const dot3 = useRef(new Animated.Value(0.3)).current;

  useEffect(() => {
    const makePulse = (val: Animated.Value, delay: number) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(delay),
          Animated.timing(val, { toValue: 1, duration: 300, useNativeDriver: true }),
          Animated.timing(val, { toValue: 0.3, duration: 300, useNativeDriver: true }),
          Animated.delay(600 - delay),
        ]),
      );

    const a1 = makePulse(dot1, 0);
    const a2 = makePulse(dot2, 150);
    const a3 = makePulse(dot3, 300);
    a1.start();
    a2.start();
    a3.start();
    return () => {
      a1.stop();
      a2.stop();
      a3.stop();
    };
  }, []);

  const label =
    typingIds.length === 1
      ? `${typingIds[0].slice(0, 8)} está escribiendo…`
      : 'Varios están escribiendo…';

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        paddingHorizontal: 16,
        paddingVertical: 6,
      }}
      accessibilityLabel={label}
    >
      <View style={{ flexDirection: 'row', gap: 3, alignItems: 'center' }}>
        {([dot1, dot2, dot3] as Animated.Value[]).map((d, i) => (
          <Animated.View
            key={i}
            style={{
              width: 5,
              height: 5,
              borderRadius: 2.5,
              backgroundColor: t.accent,
              opacity: d,
            }}
          />
        ))}
      </View>
      <Text
        style={{
          fontFamily: t.fontMono,
          fontSize: 11,
          color: t.textDim,
          letterSpacing: 0.2,
        }}
      >
        {label}
      </Text>
    </View>
  );
}

// ─── File attachment with message metadata ────────────────────────────────────

interface AttachmentRow extends WorkAttachment {
  senderId: string;
  msgCreatedAt: number;
}

// ─── File type filter ─────────────────────────────────────────────────────────

type FileFilter = 'all' | 'images' | 'documents';

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// ─── Files tab panel ──────────────────────────────────────────────────────────

function FilesTab({
  attachments,
  t,
}: {
  attachments: AttachmentRow[];
  t: import('../theme/vault').Theme;
}) {
  const [filter, setFilter] = useState<FileFilter>('all');
  const s = makeFilesStyles(t);

  const filtered = useMemo(() => {
    if (filter === 'images') return attachments.filter((a) => a.mimeType.startsWith('image/'));
    if (filter === 'documents') return attachments.filter((a) => !a.mimeType.startsWith('image/'));
    return attachments;
  }, [attachments, filter]);

  function handleOpenFile(att: AttachmentRow) {
    void downloadAndShare(att.blobId, att.filename);
  }

  const filters: { key: FileFilter; label: string }[] = [
    { key: 'all', label: 'Todos' },
    { key: 'images', label: 'Imágenes' },
    { key: 'documents', label: 'Documentos' },
  ];

  return (
    <View style={{ flex: 1 }}>
      {/* Filter chips */}
      <View style={s.filterRow}>
        {filters.map((f) => (
          <Pressable
            key={f.key}
            style={[s.filterChip, filter === f.key && s.filterChipActive]}
            onPress={() => setFilter(f.key)}
            accessibilityLabel={`Filtrar por ${f.label}`}
            accessibilityRole="button"
          >
            <Text style={[s.filterChipText, filter === f.key && s.filterChipTextActive]}>
              {f.label}
            </Text>
          </Pressable>
        ))}
      </View>

      {filtered.length === 0 ? (
        <View style={s.emptyState}>
          <I.Attach size={32} color={t.textFaint} />
          <Text style={s.emptyText}>Sin archivos en este canal</Text>
        </View>
      ) : (
        <FlatList
          data={filtered}
          keyExtractor={(a) => a.id}
          contentContainerStyle={{ paddingVertical: 4 }}
          removeClippedSubviews
          maxToRenderPerBatch={20}
          windowSize={10}
          renderItem={({ item }) => {
            const isImage = item.mimeType.startsWith('image/');
            return (
              <Pressable
                style={s.fileRow}
                onPress={() => handleOpenFile(item)}
                accessibilityLabel={`Abrir archivo ${item.filename}`}
                accessibilityRole="button"
              >
                <View style={s.fileIconWrap}>
                  {isImage ? (
                    <I.Image size={22} color={t.accent} />
                  ) : item.mimeType.startsWith('audio/') ? (
                    <I.Mic size={22} color={t.accent} />
                  ) : (
                    <I.Attach size={22} color={t.accent} />
                  )}
                </View>
                <View style={s.fileMeta}>
                  <Text style={s.fileName} numberOfLines={1}>{item.filename}</Text>
                  <Text style={s.fileDetail}>
                    {formatBytes(item.sizeBytes)} · {item.senderId.slice(0, 8)} · {formatDate(item.msgCreatedAt)}
                  </Text>
                </View>
                <I.Chevron size={14} color={t.textFaint} />
              </Pressable>
            );
          }}
          ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.border, marginLeft: 56 }} />}
        />
      )}
    </View>
  );
}

function makeFilesStyles(t: import('../theme/vault').Theme) {
  return StyleSheet.create({
    filterRow: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    filterChip: {
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 99,
      borderWidth: 1,
      borderColor: t.border,
    },
    filterChipActive: {
      backgroundColor: t.accent,
      borderColor: t.accent,
    },
    filterChipText: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textDim,
      letterSpacing: 0.3,
    },
    filterChipTextActive: {
      color: t.bg,
      fontWeight: '700',
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 12,
      paddingHorizontal: 32,
    },
    emptyText: {
      fontFamily: t.font,
      fontSize: 14,
      color: t.textFaint,
      textAlign: 'center',
    },
    fileRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    fileIconWrap: {
      width: 40,
      height: 40,
      borderRadius: 10,
      backgroundColor: t.accentDeep,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
    },
    fileMeta: {
      flex: 1,
      minWidth: 0,
      gap: 3,
    },
    fileName: {
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
    },
    fileDetail: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      letterSpacing: 0.2,
    },
  });
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  channel: WorkChannel;
  onBack: () => void;
  isAdmin: boolean;
}

// ─── Thread Panel component ───────────────────────────────────────────────────

interface ThreadPanelProps {
  visible: boolean;
  parentMessage: WorkMessage | null;
  myAegisId: string;
  channel: WorkChannel;
  isReadOnly: boolean;
  readOnlyReason: string;
  onClose: () => void;
}

function ThreadPanel({
  visible,
  parentMessage,
  myAegisId,
  channel,
  isReadOnly,
  readOnlyReason,
  onClose,
}: ThreadPanelProps) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { threadMessages, loadThread, sendMessage, appendThreadReply } = useWorkMessages();
  const slideAnim = useRef(new Animated.Value(0)).current;
  const [threadText, setThreadText] = useState('');
  const threadListRef = useRef<FlatList<WorkMessage>>(null);
  const s = makeStyles(t);

  const replies: WorkMessage[] = parentMessage ? (threadMessages[parentMessage.id] ?? []) : [];

  useEffect(() => {
    if (visible) {
      Animated.spring(slideAnim, { toValue: 1, useNativeDriver: true, bounciness: 0 }).start();
    } else {
      Animated.timing(slideAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start();
      setThreadText('');
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || !parentMessage) return;
    void loadThread(channel.orgId, channel.channelId, parentMessage.id);

    const sock = getSocket();
    if (!sock) return;

    const onMsg = (msg: WorkMessage) => {
      if (msg.parent_id === parentMessage.id) {
        appendThreadReply(msg);
      }
    };
    sock.on('channel:msg', onMsg);
    return () => {
      sock.off('channel:msg', onMsg);
    };
  }, [visible, parentMessage?.id]);

  function handleThreadSend() {
    const trimmed = threadText.trim();
    if (!trimmed || !parentMessage) return;
    sendMessage(channel.channelId, channel.orgId, trimmed, parentMessage.id);
    setThreadText('');
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderReply({ item }: { item: WorkMessage }) {
    const isOwn = item.senderId === myAegisId;
    const senderShort = item.senderId.slice(0, 8);
    return (
      <View style={[s.bubble, isOwn ? s.bubbleOut : s.bubbleIn]}>
        {!isOwn && <Text style={s.senderLabel}>{senderShort}</Text>}
        <MentionText
          body={item.body}
          myAegisId={myAegisId}
          isOwn={isOwn}
          accentColor={t.accent}
          baseStyle={[s.bubbleText, isOwn && s.bubbleTextOut]}
        />
        <Text style={[s.timeLabel, isOwn && s.timeLabelOut]}>{formatTime(item.createdAt)}</Text>
      </View>
    );
  }

  if (!visible && !parentMessage) return null;

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable style={s.modalBackdrop} onPress={onClose} accessibilityLabel="Cerrar hilo">
        <Animated.View
          style={[
            s.threadSheet,
            {
              transform: [
                {
                  translateY: slideAnim.interpolate({
                    inputRange: [0, 1],
                    outputRange: [700, 0],
                  }),
                },
              ],
            },
          ]}
        >
          <Pressable>
            {/* Handle */}
            <View style={s.pinnedSheetHandle} />

            {/* Header */}
            <View style={s.pinnedSheetHeader}>
              <I.Reply size={16} color={t.accent} />
              <Text style={s.pinnedSheetTitle}>Hilo</Text>
              <Pressable onPress={onClose} hitSlop={8} accessibilityLabel="Cerrar hilo">
                <I.X size={18} color={t.textDim} />
              </Pressable>
            </View>

            {/* Parent message preview */}
            {parentMessage && (
              <View style={s.threadParentPreview}>
                <Text style={s.threadParentSender}>{parentMessage.senderId.slice(0, 8)}</Text>
                <Text style={s.threadParentBody} numberOfLines={2}>
                  {parentMessage.body.slice(0, 60)}
                  {parentMessage.body.length > 60 ? '...' : ''}
                </Text>
              </View>
            )}

            {/* Replies list */}
            {replies.length === 0 ? (
              <View style={s.threadEmptyState}>
                <Text style={s.threadEmptyText}>No hay respuestas aún. Sé el primero.</Text>
              </View>
            ) : (
              <FlatList
                ref={threadListRef}
                data={replies}
                keyExtractor={(m) => m.id}
                renderItem={renderReply}
                contentContainerStyle={s.listContent}
                removeClippedSubviews
                maxToRenderPerBatch={20}
                windowSize={10}
                style={{ maxHeight: 340 }}
                onContentSizeChange={() =>
                  threadListRef.current?.scrollToEnd({ animated: false })
                }
              />
            )}

            {/* Thread input */}
            <KeyboardAvoidingView
              behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
            >
              <View style={[s.inputBar, { paddingBottom: insets.bottom + 8 }]}>
                {isReadOnly ? (
                  <View style={s.readOnlyNotice}>
                    <I.Lock size={14} color={t.textFaint} />
                    <Text style={s.readOnlyText}>{readOnlyReason}</Text>
                  </View>
                ) : (
                  <>
                    <TextInput
                      style={s.input}
                      value={threadText}
                      onChangeText={setThreadText}
                      placeholder="Responder en hilo..."
                      placeholderTextColor={t.textDim}
                      multiline
                      maxLength={4000}
                      returnKeyType="default"
                      accessibilityLabel="Campo de respuesta en hilo"
                    />
                    <Pressable
                      onPress={handleThreadSend}
                      disabled={!threadText.trim()}
                      hitSlop={8}
                      accessibilityLabel="Enviar respuesta en hilo"
                      style={[s.sendBtn, !threadText.trim() && s.sendBtnDisabled]}
                    >
                      <I.Send size={18} color={threadText.trim() ? t.bg : t.textFaint} />
                    </Pressable>
                  </>
                )}
              </View>
            </KeyboardAvoidingView>
          </Pressable>
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export function WorkChannelChat({ channel, onBack, isAdmin }: Props) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const myAegisId = identity?.aegisId ?? '';
  const online = useConnection((s) => s.online);
  const {
    byChannel,
    loadMessages,
    sendMessage,
    pinnedMessages,
    loadPinned,
    handlePinEvent,
    markDeleted,
    appendThreadReply,
    updateReplyCount,
  } = useWorkMessages();
  const members: WorkMember[] = useWork((s) => s.members);
  const messages: WorkMessage[] = byChannel[channel.channelId] ?? [];

  const [activeTab, setActiveTab] = useState<'messages' | 'files'>('messages');
  const [text, setText] = useState('');
  /** Cursor selection — we track only the end position which equals cursor for non-selection. */
  const [cursorPos, setCursorPos] = useState(0);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);

  const [pendingAttachments, setPendingAttachments] = useState<{ uri: string; name: string; mimeType: string; size: number }[]>([]);
  const [isUploading, setIsUploading] = useState(false);

  // Derive attachments from messages already loaded in memory
  const attachments = useMemo((): AttachmentRow[] => {
    const msgs = byChannel[channel.channelId] ?? [];
    return msgs
      .flatMap((m) =>
        (m.attachments ?? []).map((a) => ({
          ...a,
          senderId: m.senderId,
          msgCreatedAt: m.createdAt,
        })),
      )
      .sort((a, b) => b.msgCreatedAt - a.msgCreatedAt);
  }, [byChannel, channel.channelId]);

  // Pinned messages sheet
  const [pinnedSheetVisible, setPinnedSheetVisible] = useState(false);
  const pinnedSheetAnim = useRef(new Animated.Value(0)).current;

  // Long-press action sheet
  const [actionTarget, setActionTarget] = useState<WorkMessage | null>(null);
  const actionSheetAnim = useRef(new Animated.Value(0)).current;

  // Thread panel
  const [threadParent, setThreadParent] = useState<WorkMessage | null>(null);
  const [threadVisible, setThreadVisible] = useState(false);

  const listRef = useRef<FlatList<WorkMessage>>(null);
  const inputRef = useRef<TextInput>(null);
  const prevMsgCount = useRef(messages.length);

  // Presence / typing
  const typingIds = useWorkPresence((s) => s.typingByChannel[channel.channelId] ?? []);
  const typingDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Current user's role in this org (three-tier)
  const myRole = useMemo((): WorkRole => {
    const org = useWork.getState().org;
    if (org && myAegisId === org.adminId) return 'owner';
    const me = members.find((m) => m.aegis_id === myAegisId);
    return (me?.role as WorkRole | undefined) ?? 'member';
  }, [members, myAegisId]);

  const myPerms = useMemo(() => getPermissions(myRole), [myRole]);

  // Channel-level permissions fetched from server
  const channelPermissions = useWork((s) => s.channelPermissions[channel.channelId]);
  const myChannelPerms = useMemo(() => {
    if (!channelPermissions) return null;
    return channelPermissions.find((p) => p.role === myRole) ?? null;
  }, [channelPermissions, myRole]);

  const fetchChannelPermissions = useWork((s) => s.fetchChannelPermissions);

  const canPin = myPerms.canPinMessages;
  const canAttach = myChannelPerms ? myChannelPerms.canUpload : true;

  const s = makeStyles(t);

  // isReadOnly: use channel-level canSend if available, else fall back to legacy logic
  const isReadOnly = myChannelPerms
    ? !myChannelPerms.canSend
    : channel.isAnnouncements && !isAdmin;

  // Human-readable reason shown in the read-only banner
  const readOnlyReason = myChannelPerms
    ? 'Solo admins pueden escribir aquí'
    : 'Solo admins pueden escribir en este canal';

  // ── Effects ────────────────────────────────────────────────────────────────

  useEffect(() => {
    joinChannel(channel.channelId, channel.orgId);
    void loadMessages(channel.channelId, channel.orgId);
    void loadPinned(channel.orgId, channel.channelId);
    void fetchChannelPermissions(channel.orgId, channel.channelId);

    const sock = getSocket();
    if (sock) {
      const onPinEvent = (ev: PinEvent) => {
        if (ev.channelId === channel.channelId) {
          handlePinEvent(ev);
        }
      };

      const onChannelMsg = (msg: WorkMessage) => {
        if (msg.parent_id) {
          appendThreadReply(msg);
        }
      };

      const onThreadUpdate = (ev: { parentId: string; replyCount: number }) => {
        updateReplyCount(ev.parentId, ev.replyCount);
      };

      // Presence listeners
      const onPresenceSync = (data: { onlineIds: string[] }) => {
        useWorkPresence.getState().setOnline(data.onlineIds);
      };
      const onPresenceJoin = (data: { aegisId: string }) => {
        useWorkPresence.getState().addOnline(data.aegisId);
      };
      const onPresenceLeave = (data: { aegisId: string }) => {
        useWorkPresence.getState().removeOnline(data.aegisId);
      };
      const onTyping = (data: { channelId: string; from: string; isTyping: boolean }) => {
        useWorkPresence.getState().setTyping(data.channelId, data.from, data.isTyping);
      };

      const onMsgDeleted = (ev: { channelId: string; messageId: string }) => {
        if (ev.channelId === channel.channelId) {
          markDeleted(ev.channelId, ev.messageId);
        }
      };

      sock.on('channel:pin', onPinEvent);
      sock.on('channel:msg', onChannelMsg);
      sock.on('channel:thread_update', onThreadUpdate);
      sock.on('work:presence_sync', onPresenceSync);
      sock.on('work:presence_join', onPresenceJoin);
      sock.on('work:presence_leave', onPresenceLeave);
      sock.on('typing', onTyping);
      sock.on('channel:msg_deleted', onMsgDeleted);

      return () => {
        sock.off('channel:pin', onPinEvent);
        sock.off('channel:msg', onChannelMsg);
        sock.off('channel:thread_update', onThreadUpdate);
        sock.off('work:presence_sync', onPresenceSync);
        sock.off('work:presence_join', onPresenceJoin);
        sock.off('work:presence_leave', onPresenceLeave);
        sock.off('typing', onTyping);
        sock.off('channel:msg_deleted', onMsgDeleted);
      };
    }
    return undefined;
  }, [channel.channelId, channel.orgId]);

  // Haptic on self-mention in new incoming messages
  useEffect(() => {
    if (!myAegisId || messages.length <= prevMsgCount.current) {
      prevMsgCount.current = messages.length;
      return;
    }
    const newMsgs = messages.slice(prevMsgCount.current);
    prevMsgCount.current = messages.length;

    const selfMentionPattern = new RegExp(`@${myAegisId}(?:\\s|$)`);
    const hasMention = newMsgs.some(
      (m) => m.senderId !== myAegisId && selfMentionPattern.test(m.body),
    );
    if (hasMention) hapticMention();
  }, [messages, myAegisId]);

  // ── Autocomplete suggestions ───────────────────────────────────────────────

  const suggestions: WorkMember[] = useMemo(() => {
    if (mentionQuery === null) return [];
    const q = mentionQuery.toLowerCase();
    return members
      .filter((m) => m.aegis_id !== myAegisId && m.aegis_id.toLowerCase().startsWith(q))
      .slice(0, 5);
  }, [mentionQuery, members, myAegisId]);

  // ── Handlers ───────────────────────────────────────────────────────────────

  function emitTyping(isTyping: boolean) {
    const sock = getSocket();
    if (!sock) return;
    sock.emit('typing', {
      to: null,
      orgId: channel.orgId,
      channelId: channel.channelId,
      isTyping,
    });
  }

  function handleChangeText(value: string) {
    setText(value);
    // cursor position will be updated by onSelectionChange; derive synchronously
    // using value.length as fallback when selection hasn't fired yet
    const pos = value.length;
    const query = parseMentionQuery(value, pos);
    setMentionQuery(query);

    // Typing indicator — debounced emit
    if (value.length === 0) {
      if (typingDebounceRef.current !== null) {
        clearTimeout(typingDebounceRef.current);
        typingDebounceRef.current = null;
      }
      emitTyping(false);
    } else {
      if (typingDebounceRef.current !== null) {
        clearTimeout(typingDebounceRef.current);
      }
      typingDebounceRef.current = setTimeout(() => {
        emitTyping(true);
        typingDebounceRef.current = null;
      }, 400);
    }
  }

  function handleInputBlur() {
    if (typingDebounceRef.current !== null) {
      clearTimeout(typingDebounceRef.current);
      typingDebounceRef.current = null;
    }
    emitTyping(false);
  }

  function handleSelectionChange(event: { nativeEvent: { selection: { start: number; end: number } } }) {
    const pos = event.nativeEvent.selection.end;
    setCursorPos(pos);
    const query = parseMentionQuery(text, pos);
    setMentionQuery(query);
  }

  const handlePickMember = useCallback(
    (member: WorkMember) => {
      const newText = insertMention(text, cursorPos, member.aegis_id);
      const newCursor = mentionCursorPos(text, cursorPos, member.aegis_id);
      setText(newText);
      setCursorPos(newCursor);
      setMentionQuery(null);
      // Re-focus input and restore cursor after state flush
      setTimeout(() => {
        inputRef.current?.focus();
        inputRef.current?.setNativeProps({ selection: { start: newCursor, end: newCursor } });
      }, 0);
    },
    [text, cursorPos],
  );

  async function pickImage() {
    if (isReadOnly) return;
    const res = await ImagePicker.launchImageLibraryAsync({ mediaTypes: 'images', quality: 0.8 });
    if (!res.canceled && res.assets && res.assets.length > 0) {
      const asset = res.assets[0];
      setPendingAttachments((prev) => [
        ...prev,
        {
          uri: asset.uri,
          name: asset.fileName ?? 'image.jpg',
          mimeType: asset.mimeType ?? 'image/jpeg',
          size: asset.fileSize ?? 0,
        },
      ]);
    }
  }

  async function pickDocument() {
    if (isReadOnly) return;
    const res = await DocumentPicker.getDocumentAsync({});
    if (!res.canceled && res.assets && res.assets.length > 0) {
      const asset = res.assets[0];
      setPendingAttachments((prev) => [
        ...prev,
        {
          uri: asset.uri,
          name: asset.name,
          mimeType: asset.mimeType ?? 'application/octet-stream',
          size: asset.size ?? 0,
        },
      ]);
    }
  }

  async function handleSend() {
    const trimmed = text.trim();
    if ((!trimmed && pendingAttachments.length === 0) || isReadOnly || isUploading) return;
    
    setIsUploading(true);
    try {
      const uploaded: WorkAttachment[] = [];
      for (const att of pendingAttachments) {
        const { blobId, sizeBytes } = await uploadWorkBlob(att.uri, att.name, att.mimeType);
        uploaded.push({
          id: Math.random().toString(36).slice(2),
          messageId: '',
          blobId,
          filename: att.name,
          mimeType: att.mimeType,
          sizeBytes,
          uploadedBy: myAegisId,
          createdAt: new Date().toISOString(),
        });
      }
      
      sendMessage(channel.channelId, channel.orgId, trimmed, undefined, uploaded.length > 0 ? uploaded : undefined);
      setText('');
      setMentionQuery(null);
      setCursorPos(0);
      setPendingAttachments([]);
    } catch (err) {
      console.warn('Upload failed', err);
    } finally {
      setIsUploading(false);
    }
  }

  // ── Pinned sheet ───────────────────────────────────────────────────────────

  function openPinnedSheet() {
    setPinnedSheetVisible(true);
    Animated.spring(pinnedSheetAnim, { toValue: 1, useNativeDriver: true, bounciness: 0 }).start();
  }

  function closePinnedSheet() {
    Animated.timing(pinnedSheetAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(
      () => setPinnedSheetVisible(false),
    );
  }

  // ── Long-press action sheet ────────────────────────────────────────────────

  function openActionSheet(msg: WorkMessage) {
    setActionTarget(msg);
    Animated.spring(actionSheetAnim, { toValue: 1, useNativeDriver: true, bounciness: 0 }).start();
  }

  function closeActionSheet() {
    Animated.timing(actionSheetAnim, { toValue: 0, duration: 200, useNativeDriver: true }).start(
      () => setActionTarget(null),
    );
  }

  // ── Thread panel ───────────────────────────────────────────────────────────

  function openThread(msg: WorkMessage) {
    setThreadParent(msg);
    setThreadVisible(true);
  }

  function closeThread() {
    setThreadVisible(false);
    // Keep threadParent mounted during close animation, clear after
    setTimeout(() => setThreadParent(null), 250);
  }

  function handleReplyInThread(msg: WorkMessage) {
    closeActionSheet();
    openThread(msg);
  }

  async function handleTogglePin(msg: WorkMessage) {
    closeActionSheet();
    const aegisId = myAegisId;
    if (!aegisId) return;

    const { useIdentity: useId } = require('../store/identity') as {
      useIdentity: { getState: () => { identity: { signingSecretKeyB64: string } | null } };
    };
    const nacl = require('tweetnacl') as typeof import('tweetnacl');
    const { encodeBase64, decodeBase64 } = require('tweetnacl-util') as typeof import('tweetnacl-util');

    const skB64 = useId.getState().identity?.signingSecretKeyB64;
    const ts = Date.now();
    const timeBucket = Math.floor(ts / 30_000);
    const msgBytes = new TextEncoder().encode(`${channel.orgId}:pin_message:${timeBucket}`);
    const sigBytes = skB64
      ? nacl.sign.detached(msgBytes, decodeBase64(skB64))
      : new Uint8Array(0);
    const sig = skB64 ? encodeBase64(sigBytes) : '';

    try {
      await fetch(
        `${SERVER_URL}/work/org/${channel.orgId}/channels/${channel.channelId}/messages/${msg.id}/pin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin: !msg.is_pinned, aegisId, sig, ts }),
        },
      );
    } catch {
      // Offline — server will reconcile on reconnect
    }
  }

  function handleDeleteMsg(msg: WorkMessage) {
    closeActionSheet();
    // Optimistic local update immediately
    markDeleted(channel.channelId, msg.id);
    // Emit to relay — server verifies permission and broadcasts to channel room
    emitDeleteChannelMsg({
      channelId: channel.channelId,
      orgId: channel.orgId,
      messageId: msg.id,
    });
  }

  function handleCopyText(msg: WorkMessage) {
    closeActionSheet();
    Clipboard.setString(msg.body);
  }

  // ── Sub-renderers ──────────────────────────────────────────────────────────

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function renderMessage({ item }: { item: WorkMessage }) {
    const isOwn = item.senderId === myAegisId;
    const senderShort = item.senderId.slice(0, 8);

    // Highlight entire bubble row if message mentions the current user
    const selfMentionPattern = new RegExp(`@${myAegisId}(?:\\s|$)`);
    const mentionsMe = !isOwn && myAegisId !== '' && selfMentionPattern.test(item.body);
    const replyCount = item.reply_count ?? 0;

    return (
      <Pressable
        onLongPress={() => openActionSheet(item)}
        delayLongPress={350}
        accessibilityLabel="Mantén pulsado para opciones del mensaje"
      >
        <View style={mentionsMe ? s.mentionRow : undefined}>
          <View style={[s.bubble, isOwn ? s.bubbleOut : s.bubbleIn]}>
            {!isOwn && (
              <Text style={s.senderLabel}>{senderShort}</Text>
            )}
            {item.is_pinned && (
              <View style={s.pinnedBadge}>
                <I.Pin size={10} color={t.accent} />
              </View>
            )}
            <MentionText
              body={item.body}
              myAegisId={myAegisId}
              isOwn={isOwn}
              accentColor={t.accent}
              baseStyle={[s.bubbleText, isOwn && s.bubbleTextOut]}
            />
            {item.attachments && item.attachments.length > 0 && (
              <View style={{ marginTop: 8, gap: 4 }}>
                {item.attachments.map((att) => (
                  <Pressable 
                    key={att.id} 
                    style={{ borderRadius: 8, overflow: 'hidden', backgroundColor: isOwn ? 'rgba(255,255,255,0.2)' : t.surface2 }}
                    onPress={() => void downloadAndShare(att.blobId, att.filename)}
                  >
                    {att.mimeType.startsWith('image/') ? (
                      <Image source={{ uri: `${SERVER_URL}/files/${att.blobId}/download` }} style={{ width: 200, height: 150 }} resizeMode="cover" />
                    ) : (
                      <View style={{ flexDirection: 'row', alignItems: 'center', padding: 8, gap: 8 }}>
                        <I.Attach size={20} color={isOwn ? '#fff' : t.accent} />
                        <Text style={{ flex: 1, color: isOwn ? '#fff' : t.text, fontFamily: t.font }} numberOfLines={1}>{att.filename}</Text>
                      </View>
                    )}
                  </Pressable>
                ))}
              </View>
            )}
            <Text style={[s.timeLabel, isOwn && s.timeLabelOut]}>{formatTime(item.createdAt)}</Text>
          </View>
          {replyCount > 0 && (
            <Pressable
              style={s.threadIndicator}
              onPress={() => openThread(item)}
              accessibilityLabel={`${replyCount} respuesta${replyCount > 1 ? 's' : ''} en hilo. Toca para ver`}
              accessibilityRole="button"
            >
              <I.Reply size={13} color={t.accent} />
              <Text style={s.threadIndicatorText}>
                {replyCount} respuesta{replyCount > 1 ? 's' : ''}
              </Text>
            </Pressable>
          )}
        </View>
      </Pressable>
    );
  }

  const renderSuggestion = useCallback(
    ({ item }: { item: WorkMember }) => (
      <Pressable
        style={s.suggestionRow}
        onPress={() => handlePickMember(item)}
        accessibilityLabel={`Mencionar a ${item.aegis_id}`}
        accessibilityRole="button"
      >
        <I.Shield size={14} color={t.accent} />
        <Text style={s.suggestionText} numberOfLines={1}>
          @{item.aegis_id.slice(0, 10)}
        </Text>
      </Pressable>
    ),
    [handlePickMember, t.accent],
  );

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Pressable
          onPress={onBack}
          hitSlop={8}
          accessibilityLabel="Volver a canales"
          style={s.backBtn}
        >
          <I.ChevronL size={20} color={t.textDim} />
        </Pressable>
        <Text style={s.channelHash}>#</Text>
        <Text style={s.channelName} numberOfLines={1}>{channel.name}</Text>
        {channel.isAnnouncements && (
          <Text style={s.announceBadge}>ANUNCIOS</Text>
        )}
      </View>

      {/* Tab switcher */}
      <View style={s.tabBar}>
        <Pressable
          style={[s.tabItem, activeTab === 'messages' && s.tabItemActive]}
          onPress={() => setActiveTab('messages')}
          accessibilityLabel="Ver mensajes"
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'messages' }}
        >
          <Text style={[s.tabText, activeTab === 'messages' && s.tabTextActive]}>Mensajes</Text>
        </Pressable>
        <Pressable
          style={[s.tabItem, activeTab === 'files' && s.tabItemActive]}
          onPress={() => setActiveTab('files')}
          accessibilityLabel="Ver archivos"
          accessibilityRole="tab"
          accessibilityState={{ selected: activeTab === 'files' }}
        >
          <Text style={[s.tabText, activeTab === 'files' && s.tabTextActive]}>Archivos</Text>
          {attachments.length > 0 && (
            <View style={s.tabBadge}>
              <Text style={s.tabBadgeText}>{attachments.length > 99 ? '99+' : attachments.length}</Text>
            </View>
          )}
        </Pressable>
      </View>

      {/* Pinned messages banner */}
      {pinnedMessages.length > 0 && (
        <Pressable
          style={s.pinnedBanner}
          onPress={openPinnedSheet}
          accessibilityLabel={`${pinnedMessages.length} mensaje${pinnedMessages.length > 1 ? 's' : ''} fijado${pinnedMessages.length > 1 ? 's' : ''}. Toca para ver`}
          accessibilityRole="button"
        >
          <I.Pin size={14} color={t.accent} />
          <Text style={s.pinnedBannerText}>
            {pinnedMessages.length} mensaje{pinnedMessages.length > 1 ? 's' : ''} fijado{pinnedMessages.length > 1 ? 's' : ''}
          </Text>
          <I.Chevron size={14} color={t.textDim} />
        </Pressable>
      )}

      {/* Offline banner */}
      {!online && (
        <View testID="offline-banner" style={s.offlineBanner}>
          <Text style={s.offlineText}>SIN CONEXIÓN — los mensajes se enviarán al reconectar</Text>
        </View>
      )}

      {/* Files tab */}
      {activeTab === 'files' && (
        <FilesTab attachments={attachments} t={t} />
      )}

      {/* Messages + input */}
      {activeTab === 'messages' && (
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        style={{ flex: 1 }}
        keyboardVerticalOffset={insets.top}
      >
        {messages.length === 0 ? (
          <View style={s.emptyState}>
            <Text style={s.emptyHash}>#</Text>
            <Text style={s.emptyTitle}>{channel.name}</Text>
            <Text style={s.emptySubtitle}>
              {isReadOnly
                ? readOnlyReason
                : 'Este es el inicio del canal. Escribe el primer mensaje.'}
            </Text>
          </View>
        ) : (
          <FlatList
            ref={listRef}
            data={messages}
            keyExtractor={(m) => m.id}
            renderItem={renderMessage}
            contentContainerStyle={s.listContent}
            removeClippedSubviews
            maxToRenderPerBatch={20}
            windowSize={10}
            onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          />
        )}

        {/* Typing indicator */}
        {typingIds.length > 0 && !isReadOnly && (
          <TypingIndicator typingIds={typingIds} t={t} />
        )}

        {/* Autocomplete list — rendered above the input bar */}
        {suggestions.length > 0 && !isReadOnly && (
          <View style={s.suggestionList} pointerEvents="box-none">
            <FlatList
              data={suggestions}
              keyExtractor={(m) => m.aegis_id}
              renderItem={renderSuggestion}
              keyboardShouldPersistTaps="always"
              scrollEnabled={false}
            />
          </View>
        )}

        {/* Pending attachments preview */}
        {pendingAttachments.length > 0 && (
          <View style={{ flexDirection: 'row', paddingHorizontal: 12, paddingBottom: 8, gap: 8 }}>
            {pendingAttachments.map((att, idx) => (
              <View key={idx} style={{ width: 60, height: 60, borderRadius: 8, backgroundColor: t.surface2, overflow: 'hidden' }}>
                {att.mimeType.startsWith('image/') ? (
                  <Image source={{ uri: att.uri }} style={{ width: '100%', height: '100%' }} />
                ) : (
                  <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                    <I.Attach size={24} color={t.accent} />
                  </View>
                )}
                <Pressable
                  style={{ position: 'absolute', top: 2, right: 2, backgroundColor: 'rgba(0,0,0,0.5)', borderRadius: 10, padding: 2 }}
                  onPress={() => setPendingAttachments((p) => p.filter((_, i) => i !== idx))}
                >
                  <I.X size={12} color="#fff" />
                </Pressable>
              </View>
            ))}
          </View>
        )}

        {/* Input bar */}
        <View style={[s.inputBar, { paddingBottom: insets.bottom + 8 }]}>
          {isReadOnly ? (
            <View style={s.readOnlyNotice}>
              <I.Lock size={14} color={t.textFaint} />
              <Text style={s.readOnlyText}>Solo admins pueden escribir</Text>
            </View>
          ) : (
            <>
              {canAttach && (
                <Pressable onPress={pickImage} style={s.attachBtn} hitSlop={8} accessibilityLabel="Adjuntar imagen">
                  <I.Image size={20} color={t.textDim} />
                </Pressable>
              )}
              {canAttach && (
                <Pressable onPress={pickDocument} style={s.attachBtn} hitSlop={8} accessibilityLabel="Adjuntar archivo">
                  <I.Attach size={20} color={t.textDim} />
                </Pressable>
              )}
              <TextInput
                ref={inputRef}
                style={s.input}
                value={text}
                onChangeText={handleChangeText}
                onSelectionChange={handleSelectionChange}
                onBlur={handleInputBlur}
                placeholder={`Mensaje en #${channel.name}`}
                placeholderTextColor={t.textDim}
                multiline
                maxLength={4000}
                returnKeyType="default"
                accessibilityLabel="Campo de texto del mensaje"
              />
              <Pressable
                testID="send-button"
                onPress={handleSend}
                disabled={(!text.trim() && pendingAttachments.length === 0) || isUploading}
                hitSlop={8}
                accessibilityLabel="Enviar mensaje"
                style={[s.sendBtn, (!text.trim() && pendingAttachments.length === 0) && s.sendBtnDisabled]}
              >
                {isUploading ? (
                  <ActivityIndicator size="small" color={t.bg} />
                ) : (
                  <I.Send size={18} color={(text.trim() || pendingAttachments.length > 0) ? t.bg : t.textFaint} />
                )}
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
      )}

      {/* Pinned messages bottom sheet */}
      <Modal
        visible={pinnedSheetVisible}
        transparent
        animationType="none"
        onRequestClose={closePinnedSheet}
        statusBarTranslucent
      >
        <Pressable style={s.modalBackdrop} onPress={closePinnedSheet} accessibilityLabel="Cerrar">
          <Animated.View
            style={[
              s.pinnedSheet,
              {
                transform: [
                  {
                    translateY: pinnedSheetAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [400, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <Pressable>
              {/* Inner Pressable prevents backdrop close when tapping inside sheet */}
              <View style={s.pinnedSheetHandle} />
              <View style={s.pinnedSheetHeader}>
                <I.Pin size={16} color={t.accent} />
                <Text style={s.pinnedSheetTitle}>Mensajes fijados</Text>
                <Pressable onPress={closePinnedSheet} hitSlop={8} accessibilityLabel="Cerrar">
                  <I.X size={18} color={t.textDim} />
                </Pressable>
              </View>
              <FlatList
                data={pinnedMessages}
                keyExtractor={(m) => m.id}
                renderItem={({ item }) => (
                  <View style={s.pinnedItem}>
                    <Text style={s.pinnedItemSender}>{item.senderId.slice(0, 8)}</Text>
                    <Text style={s.pinnedItemBody} numberOfLines={3}>{item.body}</Text>
                    <Text style={s.pinnedItemTime}>{formatTime(item.createdAt)}</Text>
                  </View>
                )}
                ItemSeparatorComponent={() => <View style={s.pinnedDivider} />}
                style={{ maxHeight: 360 }}
                scrollEnabled
              />
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>

      {/* Long-press action sheet */}
      <Modal
        visible={actionTarget !== null}
        transparent
        animationType="none"
        onRequestClose={closeActionSheet}
        statusBarTranslucent
      >
        <Pressable style={s.modalBackdrop} onPress={closeActionSheet} accessibilityLabel="Cerrar">
          <Animated.View
            style={[
              s.actionSheet,
              {
                transform: [
                  {
                    translateY: actionSheetAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [300, 0],
                    }),
                  },
                ],
              },
            ]}
          >
            <Pressable>
              <View style={s.pinnedSheetHandle} />
              {/* Reply in thread — first action */}
              {actionTarget !== null && (
                <Pressable
                  style={s.actionRow}
                  onPress={() => { handleReplyInThread(actionTarget); }}
                  accessibilityLabel="Responder en hilo"
                  accessibilityRole="button"
                >
                  <I.Reply size={18} color={t.accent} />
                  <Text style={s.actionRowText}>Responder en hilo</Text>
                </Pressable>
              )}
              {canPin && actionTarget !== null && (
                <Pressable
                  style={s.actionRow}
                  onPress={() => { void handleTogglePin(actionTarget); }}
                  accessibilityLabel={actionTarget.is_pinned ? 'Desfijar mensaje' : 'Fijar mensaje'}
                  accessibilityRole="button"
                >
                  <I.Pin size={18} color={t.accent} />
                  <Text style={s.actionRowText}>
                    {actionTarget.is_pinned ? 'Desfijar mensaje' : 'Fijar mensaje'}
                  </Text>
                </Pressable>
              )}
              {actionTarget !== null && (
                <Pressable
                  style={s.actionRow}
                  onPress={() => handleCopyText(actionTarget)}
                  accessibilityLabel="Copiar texto"
                  accessibilityRole="button"
                >
                  <I.Copy size={18} color={t.textDim} />
                  <Text style={s.actionRowText}>Copiar texto</Text>
                </Pressable>
              )}
              {/* Delete: own message always; any message if admin */}
              {actionTarget !== null && (actionTarget.senderId === myAegisId || canPin) && (
                <Pressable
                  style={s.actionRow}
                  onPress={() => handleDeleteMsg(actionTarget)}
                  accessibilityLabel="Eliminar mensaje"
                  accessibilityRole="button"
                >
                  <I.Trash size={18} color={t.danger ?? '#e53e3e'} />
                  <Text style={[s.actionRowText, { color: t.danger ?? '#e53e3e' }]}>
                    Eliminar mensaje
                  </Text>
                </Pressable>
              )}
              <Pressable
                style={[s.actionRow, s.actionRowLast]}
                onPress={closeActionSheet}
                accessibilityLabel="Cerrar"
                accessibilityRole="button"
              >
                <I.X size={18} color={t.textFaint} />
                <Text style={[s.actionRowText, { color: t.textFaint }]}>Cerrar</Text>
              </Pressable>
            </Pressable>
          </Animated.View>
        </Pressable>
      </Modal>

      {/* Thread panel */}
      <ThreadPanel
        visible={threadVisible}
        parentMessage={threadParent}
        myAegisId={myAegisId}
        channel={channel}
        isReadOnly={isReadOnly}
        readOnlyReason={readOnlyReason}
        onClose={closeThread}
      />
    </View>
  );
}

// ─── Styles ───────────────────────────────────────────────────────────────────

function makeStyles(t: import('../theme/vault').Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.bg },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 12,
      borderBottomWidth: 1,
      borderBottomColor: t.border,
      backgroundColor: t.surface,
    },
    backBtn: { padding: 4 },
    channelHash: {
      fontFamily: t.fontMono,
      fontSize: 16,
      color: t.textDim,
    },
    channelName: {
      fontFamily: t.fontDisplay,
      fontSize: 16,
      fontWeight: '700',
      color: t.text,
      flex: 1,
    },
    announceBadge: {
      fontFamily: t.fontMono,
      fontSize: 9,
      color: t.textFaint,
      letterSpacing: 0.8,
      flexShrink: 0,
    },
    tabBar: {
      flexDirection: 'row',
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
      backgroundColor: t.surface,
    },
    tabItem: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 6,
      paddingVertical: 10,
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    tabItemActive: {
      borderBottomColor: t.accent,
    },
    tabText: {
      fontFamily: t.fontMono,
      fontSize: 12,
      color: t.textDim,
      letterSpacing: 0.5,
    },
    tabTextActive: {
      color: t.accent,
      fontWeight: '700',
    },
    tabBadge: {
      backgroundColor: t.accent,
      borderRadius: 99,
      paddingHorizontal: 5,
      paddingVertical: 1,
      minWidth: 16,
      alignItems: 'center',
    },
    tabBadgeText: {
      fontFamily: t.fontMono,
      fontSize: 9,
      color: t.bg,
      fontWeight: '700',
    },
    offlineBanner: {
      backgroundColor: '#3a2600',
      paddingVertical: 6,
      paddingHorizontal: 16,
      alignItems: 'center',
    },
    offlineText: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: '#f5a623',
      letterSpacing: 0.5,
    },
    listContent: {
      padding: 12,
      gap: 6,
    },
    // Tinted row background for messages that mention the current user
    mentionRow: {
      backgroundColor: `${t.accentDeep}26`, // ~15% opacity tint
      marginHorizontal: -12,
      paddingHorizontal: 12,
      borderLeftWidth: 2,
      borderLeftColor: t.accent,
    },
    bubble: {
      maxWidth: '80%',
      borderRadius: 12,
      padding: 10,
      marginBottom: 6,
    },
    bubbleIn: {
      backgroundColor: t.surface,
      alignSelf: 'flex-start',
      borderBottomLeftRadius: 4,
    },
    bubbleOut: {
      backgroundColor: t.accent,
      alignSelf: 'flex-end',
      borderBottomRightRadius: 4,
    },
    senderLabel: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.accent,
      marginBottom: 3,
      letterSpacing: 0.3,
    },
    bubbleText: {
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
      lineHeight: 20,
    },
    bubbleTextOut: {
      color: t.bg,
    },
    timeLabel: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      alignSelf: 'flex-end',
      marginTop: 4,
    },
    timeLabelOut: {
      color: `${t.bg}aa`,
    },
    // Thread indicator below bubble
    threadIndicator: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      paddingVertical: 4,
      paddingHorizontal: 4,
      marginBottom: 2,
      alignSelf: 'flex-start',
    },
    threadIndicatorText: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.accent,
      letterSpacing: 0.2,
    },
    emptyState: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      paddingHorizontal: 32,
    },
    emptyHash: {
      fontFamily: t.fontMono,
      fontSize: 40,
      color: t.textFaint,
    },
    emptyTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 22,
      fontWeight: '700',
      color: t.text,
    },
    emptySubtitle: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textDim,
      textAlign: 'center',
      lineHeight: 20,
    },
    // Autocomplete popup
    suggestionList: {
      position: 'absolute',
      bottom: 60, // sits just above the input bar; adjusted dynamically via paddingBottom if needed
      left: 12,
      right: 12,
      backgroundColor: t.surface2,
      borderRadius: t.radiusS,
      borderWidth: 1,
      borderColor: t.border,
      overflow: 'hidden',
      // Shadow for legibility over message list
      shadowColor: '#000',
      shadowOffset: { width: 0, height: -2 },
      shadowOpacity: 0.18,
      shadowRadius: 6,
      elevation: 8,
    },
    suggestionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 14,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    suggestionText: {
      fontFamily: t.fontMono,
      fontSize: 13,
      color: t.text,
      flex: 1,
    },
    inputBar: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      gap: 8,
      paddingHorizontal: 12,
      paddingTop: 8,
      borderTopWidth: 1,
      borderTopColor: t.border,
      backgroundColor: t.surface,
    },
    input: {
      flex: 1,
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
      backgroundColor: t.bg,
      borderWidth: 1,
      borderColor: t.border,
      borderRadius: 20,
      paddingHorizontal: 14,
      paddingTop: 10,
      paddingBottom: 10,
      maxHeight: 120,
    },
    sendBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: t.accent,
      alignItems: 'center',
      justifyContent: 'center',
      flexShrink: 0,
      marginBottom: 1,
    },
    sendBtnDisabled: {
      backgroundColor: t.surface2,
    },
    attachBtn: {
      paddingBottom: 10,
      paddingHorizontal: 4,
    },
    readOnlyNotice: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      paddingVertical: 10,
      justifyContent: 'center',
    },
    readOnlyText: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.textFaint,
      letterSpacing: 0.5,
    },
    // Pinned banner
    pinnedBanner: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
      backgroundColor: `${t.accentDeep}22`,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    pinnedBannerText: {
      fontFamily: t.fontMono,
      fontSize: 11,
      color: t.accent,
      flex: 1,
      letterSpacing: 0.3,
    },
    // Pin badge on bubble
    pinnedBadge: {
      alignSelf: 'flex-start',
      marginBottom: 2,
    },
    // Modal backdrop
    modalBackdrop: {
      flex: 1,
      backgroundColor: 'rgba(0,0,0,0.55)',
      justifyContent: 'flex-end',
    },
    // Pinned sheet
    pinnedSheet: {
      backgroundColor: t.surface,
      borderTopLeftRadius: t.radiusL,
      borderTopRightRadius: t.radiusL,
      paddingBottom: 32,
      overflow: 'hidden',
    },
    pinnedSheetHandle: {
      width: 36,
      height: 4,
      borderRadius: 2,
      backgroundColor: t.border,
      alignSelf: 'center',
      marginTop: 10,
      marginBottom: 4,
    },
    pinnedSheetHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    pinnedSheetTitle: {
      fontFamily: t.fontDisplay,
      fontSize: 15,
      fontWeight: '700',
      color: t.text,
      flex: 1,
    },
    pinnedItem: {
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    pinnedItemSender: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.accent,
      marginBottom: 3,
    },
    pinnedItemBody: {
      fontFamily: t.font,
      fontSize: 14,
      color: t.text,
      lineHeight: 20,
    },
    pinnedItemTime: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.textFaint,
      marginTop: 4,
    },
    pinnedDivider: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: t.border,
      marginHorizontal: 16,
    },
    // Action sheet
    actionSheet: {
      backgroundColor: t.surface,
      borderTopLeftRadius: t.radiusL,
      borderTopRightRadius: t.radiusL,
      paddingBottom: 32,
      overflow: 'hidden',
    },
    actionRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      paddingHorizontal: 20,
      paddingVertical: 16,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: t.border,
    },
    actionRowLast: {
      borderBottomWidth: 0,
    },
    actionRowText: {
      fontFamily: t.font,
      fontSize: 15,
      color: t.text,
    },
    // Thread sheet
    threadSheet: {
      backgroundColor: t.surface,
      borderTopLeftRadius: t.radiusL,
      borderTopRightRadius: t.radiusL,
      paddingBottom: 16,
      overflow: 'hidden',
      maxHeight: '90%',
    },
    // Thread parent preview
    threadParentPreview: {
      paddingHorizontal: 16,
      paddingVertical: 10,
      backgroundColor: t.surface2,
      borderLeftWidth: 3,
      borderLeftColor: t.accent,
      marginHorizontal: 16,
      marginVertical: 8,
      borderRadius: t.radiusS,
    },
    threadParentSender: {
      fontFamily: t.fontMono,
      fontSize: 10,
      color: t.accent,
      marginBottom: 2,
    },
    threadParentBody: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textDim,
      lineHeight: 18,
    },
    // Thread empty state
    threadEmptyState: {
      paddingVertical: 32,
      alignItems: 'center',
      justifyContent: 'center',
    },
    threadEmptyText: {
      fontFamily: t.font,
      fontSize: 13,
      color: t.textFaint,
      textAlign: 'center',
    },
  });
}
