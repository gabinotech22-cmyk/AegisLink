import { useEffect, useRef, useState, useMemo } from 'react';
import {
  View, Text, TextInput, Pressable, FlatList,
  KeyboardAvoidingView, Platform, StyleSheet, Alert,
  Linking, Image, Animated, ActivityIndicator,
} from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SwipeableMessage } from '../components/SwipeableMessage';
import { FormattedText } from '../components/FormattedText';
import { AudioWaveform } from '../components/AudioWaveform';
import { LinkPreview } from '../components/LinkPreview';
import { GifPicker } from '../components/GifPicker';
import { ImageViewerModal } from '../components/ImageViewerModal';
import Svg, { Path } from 'react-native-svg';
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
import { useContacts } from '../store/contacts';
import { useGroups } from '../store/groups';
import { sendGroupMessage, sendGroupVote } from '../socket/client';
import { useConnection } from '../store/connection';
import { usePollsStore, type PollResult } from '../store/polls';
import type { StoredGroup, StoredMessage } from '../db/local';
import { parseLocationMessage } from '../utils/parseLocationMessage';

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
}

export function GroupChatScreen({ group: initialGroup, onBack, onGroupDetail, onPoll, onAttach }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity } = useIdentity();
  const contacts = useContacts((s) => s.contacts);
  const hydrate = useContacts((s) => s.hydrate);
  // Read group reactively from the store so member add/remove is reflected live
  const group = useGroups((s) => s.groups.find((g) => g.id === initialGroup.id) ?? initialGroup);
  const list = useMessages((s) => s.byChat[group.id] ?? EMPTY_MSGS);
  const loadChat = useMessages((s) => s.loadChat);
  const toggleStar = useMessages((s) => s.toggleStar);
  const softDelete = useMessages((s) => s.softDelete);
  const toggleReaction = useMessages((s) => s.toggleReaction);
  const appendMsg = useMessages((s) => s.append);
  const markRead = useMessages((s) => s.markRead);
  const pendingMediaUri = useMessages((s) => s.pendingMediaUri);
  const setPendingMedia = useMessages((s) => s.setPendingMedia);

  const [draft, setDraft] = useState('');
  const [stagedImageUri, setStagedImageUri] = useState<string | null>(null);
  const [imageProcessing, setImageProcessing] = useState(false);
  const [sending, setSending] = useState(false);
  const [replyTo, setReplyTo] = useState<StoredMessage | null>(null);
  const [actionsMsg, setActionsMsg] = useState<StoredMessage | null>(null);
  const [forwardBody, setForwardBody] = useState<string | null>(null);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [searchActive, setSearchActive] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [gifPickerVisible, setGifPickerVisible] = useState(false);
  const [viewerUri, setViewerUri] = useState<string | null>(null);
  const flatlistRef = useRef<FlatList>(null);
  const isNearBottomRef = useRef(true);
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

  useEffect(() => {
    void loadChat(group.id);
    void markRead(group.id);
  }, [group.id, loadChat, markRead]);

  useEffect(() => {
    void hydratePollsStore();
    // Same reasoning as hydrate above — run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!pendingMediaUri) return;
    const uri = pendingMediaUri;
    setPendingMedia(null);
    setImageProcessing(true);
    void (async () => {
      try {
        const { manipulateAsync, SaveFormat } = require('expo-image-manipulator') as typeof import('expo-image-manipulator');
        const compressed = await manipulateAsync(uri, [{ resize: { width: 400 } }], { compress: 0.55, format: SaveFormat.JPEG });
        setStagedImageUri(compressed.uri);
      } catch {
        setStagedImageUri(uri);
      } finally {
        setImageProcessing(false);
      }
    })();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingMediaUri]);

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
    if (list.length > 0 && isNearBottomRef.current) {
      requestAnimationFrame(() => flatlistRef.current?.scrollToEnd({ animated: true }));
    }
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
    Alert.alert(
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
    const plaintext = `[gif:${url}]`;
    try {
      const id = Crypto.randomUUID();
      await appendMsg({ id, chatId: group.id, direction: 'out', body: plaintext, createdAt: Date.now(), type: 'text' });
      await sendGroupMessage({ identity, groupId: group.id, plaintext });
    } catch (e) {
      Alert.alert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }

  function handleStickerSelect(emoji: string) {
    setGifPickerVisible(false);
    setDraft((prev) => prev + emoji);
  }

  async function handleSend() {
    if (!identity || sending) return;
    const hasText = draft.trim().length > 0;
    const hasImage = !!stagedImageUri;
    if (!hasText && !hasImage) return;

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
        await appendMsg({ id, chatId: group.id, direction: 'out', body: '', createdAt: Date.now(), type: 'image', mediaUri: imageUri });
        const { encryptAndUploadMedia } = require('../crypto/media');
        const blobUri = await encryptAndUploadMedia(imageUri, 'image/jpeg');
        await sendGroupMessage({ identity, groupId: group.id, plaintext: `[image:${blobUri}]` });
      }
      if (hasText) {
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
        await sendGroupMessage({ identity, groupId: group.id, plaintext: text });
      }
    } catch (e) {
      setDraft(text);
      if (imageUri) setStagedImageUri(imageUri);
      Alert.alert(i18nT('common.error', 'Error'), (e as Error).message);
    } finally {
      setSending(false);
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
                <Avatar t={t} name={group.avatarImage || group.name} color={group.avatarColor || t.accent} size={36} />
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 16, fontWeight: '600', color: t.text }}>
                    {group.name}
                  </Text>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 }}>
                    <I.Lock size={10} color={t.accent} />
                    <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.5 }}>
                      {i18nT('groupChat.membersCount', 'E2EE · {{count}} MEMBERS', { count: group.members.length })}
                    </Text>
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

        {/* Message List */}
        <FlatList
          ref={flatlistRef}
          data={filteredList}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: 14, paddingVertical: 12, gap: 10 }}
          onLayout={() => list.length > 0 && isNearBottomRef.current && flatlistRef.current?.scrollToEnd({ animated: false })}
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
                Alert.alert(
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
                onLongPress={() => setActionsMsg(item)}
                pollResult={pollResults[item.id]}
                onVote={(optionIndex, totalOptions) => void handleVote(item.id, optionIndex, totalOptions)}
                onImagePress={setViewerUri}
              />
            </SwipeableMessage>
          )}
          onContentSizeChange={() => isNearBottomRef.current && flatlistRef.current?.scrollToEnd({ animated: false })}
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
                <Avatar t={t} name={name} color={colorFromId(id)} size={28} />
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
          <TextInput
            placeholder={i18nT('groupChat.messagePlaceholder', 'Group message…')}
            placeholderTextColor={t.textDim}
            value={draft}
            onChangeText={handleDraftChange}
            accessibilityLabel="Campo de mensaje"
            multiline
            style={[styles.input, { color: t.text, backgroundColor: t.surface2, borderColor: t.border, fontFamily: t.font }]}
          />
          <Pressable
            onPress={() => void handleSend()}
            disabled={(!draft.trim() && !stagedImageUri) || sending || imageProcessing}
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
      <ImageViewerModal uri={viewerUri} onClose={() => setViewerUri(null)} t={t} />
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
  onLongPress: () => void;
  pollResult?: PollResult;
  onVote: (optionIndex: number, totalOptions: number) => void;
  onImagePress?: (uri: string) => void;
}

function GroupBubble({
  t,
  m,
  myAegisId,
  memberNames,
  adminId,
  moderators,
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
              height: 100,
              backgroundColor: t.dark ? '#1e282d' : '#e6e3d8',
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
    const fileName = m.body || 'file';
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
          onPress={() => onImagePress?.(m.mediaUri!)}
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
            source={{ uri: m.mediaUri }}
            style={{ width: 200, height: 150 }}
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
