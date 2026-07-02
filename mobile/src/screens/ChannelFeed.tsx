/**
 * ChannelFeed — sealed channel broadcast view (Phase 2d-2)
 *
 * Renders the chain-verified post feed for one channel and (for open/owned
 * channels) a compose bar. All posts shown were authenticated + chain-verified by
 * useChannels before reaching state; the relay never saw who posted. This screen
 * does no crypto. Design ref: prototype/screens-channels.jsx (ScreenChannelFeed).
 *
 * Scheduled channel posts: mirrors the GroupChat compositor pattern — long-press
 * the send button opens SchedulePicker, posts are queued in scheduledMessages
 * store with channelId and fired by processDue.
 */

import { useCallback, useEffect, useState } from 'react';
import { View, Text, Pressable, FlatList, TextInput, KeyboardAvoidingView, Platform, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { themedAlert } from '../components/AlertHost';
import { SchedulePicker } from '../components/SchedulePicker';
import { useChannelAvatar } from '../channels/useChannelAvatar';
import { useChannels, type FeedPost } from '../store/channels';
import { useIdentity } from '../store/identity';
import {
  useScheduledMessages,
  canScheduleChannelPost,
  type ScheduledMessage,
} from '../store/scheduledMessages';

interface Props {
  channelId: string;
  onBack: () => void;
  onOpenInfo?: () => void;
}

// ─── Time helpers (mirrored from GroupPosts) ─────────────────────────────────

function pad(n: number): string { return String(n).padStart(2, '0'); }

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'NOW';
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} MIN`;
  const h = Math.floor(min / 60);
  if (h < 48) {
    const remM = min % 60;
    return remM > 0 ? `${h}H ${remM}M` : `${h}H`;
  }
  return `${Math.round(h / 24)}D`;
}

function formatQueueWhen(ts: number): string {
  const d = new Date(ts);
  const days = ['DOM', 'LUN', 'MAR', 'MIE', 'JUE', 'VIE', 'SAB'];
  const months = ['ENE', 'FEB', 'MAR', 'ABR', 'MAY', 'JUN', 'JUL', 'AGO', 'SEP', 'OCT', 'NOV', 'DIC'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]} · ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ChannelFeedScreen({ channelId, onBack, onOpenInfo }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const myDisplayName = useIdentity((s) => s.displayName);

  const summary = useChannels((s) => s.subscribed.find((c) => c.channelId === channelId));
  const posts = useChannels((s) => s.feeds[channelId]);
  const loadFeed = useChannels((s) => s.loadFeed);
  const sendPost = useChannels((s) => s.sendPost);
  const attachLive = useChannels((s) => s.attachLive);
  const deletePost = useChannels((s) => s.deletePost);

  const channelAvatarUri = useChannelAvatar(channelId, summary?.avatarHash ?? null);

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [showQueue, setShowQueue] = useState(false);

  // Scheduled posts store
  const scheduled = useScheduledMessages((s) => s.scheduled);
  const { scheduleChannelPost, cancelScheduled, loadPending } = useScheduledMessages();

  useEffect(() => { void loadPending(); }, [loadPending]);

  useEffect(() => {
    if (!identity) return;
    void loadFeed(channelId, identity);
    const off = attachLive(identity);
    return off;
  }, [channelId, identity, loadFeed, attachLive]);

  // While this feed is focused, suppress local notifications for its own posts
  // (same activeChatId guard Chat/GroupChat use). Reset on unmount.
  useEffect(() => {
    const { setActiveChatNotificationId } = require('../notifications/push') as typeof import('../notifications/push');
    setActiveChatNotificationId(channelId);
    return () => {
      setActiveChatNotificationId(null);
    };
  }, [channelId]);

  const canPost = !!identity && (summary?.channelType === 'open' || summary?.owned === true);
  const canSchedule = canScheduleChannelPost(summary, !!identity);

  const channelQueue = scheduled.filter(
    (m) => m.channelId === channelId && (m.status === 'pending' || m.status === 'draft'),
  );

  const handleSend = async () => {
    if (!identity || !draft.trim() || sending) return;
    setSending(true);
    try {
      const res = await sendPost(channelId, draft.trim(), identity, myDisplayName);
      if (res.ok) setDraft('');
      else themedAlert(i18nT('channels.postFailed'), res.error ?? i18nT('channels.unknownError'));
    } finally {
      setSending(false);
    }
  };

  const handleScheduleConfirm = useCallback(async (sendAt: number) => {
    const trimmed = draft.trim();
    if (!trimmed) return;
    try {
      await scheduleChannelPost({ channelId, body: trimmed, sendAt });
      setDraft('');
      themedAlert(
        i18nT('channels.postScheduledTitle', 'Post scheduled'),
        i18nT('channels.postScheduledDesc', 'It will be posted to the channel automatically at the chosen time.'),
      );
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }, [draft, channelId, scheduleChannelPost, i18nT]);

  const handleDeleteScheduled = useCallback((m: ScheduledMessage) => {
    themedAlert(
      i18nT('channels.deleteScheduledTitle', 'Delete scheduled post'),
      i18nT('channels.deleteScheduledDesc', 'Delete this scheduled post? This cannot be undone.'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        { text: i18nT('common.delete', 'Delete'), style: 'destructive', onPress: () => void cancelScheduled(m.id) },
      ],
    );
  }, [cancelScheduled, i18nT]);

  // Decrypt queue bodies for display
  const [decryptedQueue, setDecryptedQueue] = useState<Record<string, string>>({});
  useEffect(() => {
    let alive = true;
    void (async () => {
      const { decryptBody } = await import('../db/local');
      const out: Record<string, string> = {};
      for (const m of channelQueue) {
        const txt = await decryptBody(m.encryptedPayload);
        out[m.id] = txt === '[DECRYPTION_ERROR]' ? '' : txt;
      }
      if (alive) setDecryptedQueue(out);
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scheduled, channelId]);

  // Owner moderation: long-press a post → signed pubchannel:delete, the relay
  // fans it out so every subscriber drops the post (Phase 4).
  const handleDeletePost = useCallback((post: FeedPost) => {
    themedAlert(
      i18nT('channels.deletePostTitle', 'Delete post'),
      i18nT('channels.deletePostDesc', 'Delete this post for everyone in the channel? This cannot be undone.'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: i18nT('common.delete', 'Delete'),
          style: 'destructive',
          onPress: () => {
            void deletePost(channelId, post.seqNum).then((res) => {
              if (!res.ok) themedAlert(i18nT('common.error', 'Error'), res.error ?? i18nT('channels.unknownError'));
            });
          },
        },
      ],
    );
  }, [channelId, deletePost, i18nT]);

  const isOwner = summary?.owned === true;

  const renderPost = ({ item }: { item: FeedPost }) => {
    const mine = item.from === identity?.aegisId;
    // Prefer the sender's profile name carried inside the encrypted post body
    // (issue #204 — never render the raw aegisId to other members). Falls back
    // to the aegisId only for legacy posts sealed before this fix existed.
    const senderLabel = mine
      ? i18nT('channels.you')
      : (item.senderName ?? item.from);
    return (
      <Pressable
        onLongPress={isOwner ? () => handleDeletePost(item) : undefined}
        delayLongPress={350}
        accessibilityLabel={isOwner ? i18nT('channels.deletePostHint', 'Long-press to delete post') : undefined}
        style={{ paddingVertical: 12, paddingHorizontal: 15, borderBottomWidth: 1, borderBottomColor: t.divider }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginBottom: 7 }}>
          <Avatar t={t} name={mine ? (summary?.name ?? '?') : senderLabel} seed={item.from} size={24} />
          <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.text }}>{senderLabel}</Text>
          <Text style={{ marginLeft: 'auto', fontFamily: t.fontMono, fontSize: 9, color: t.textFaint }}>#{item.seqNum}</Text>
        </View>
        <Text style={{ fontFamily: t.font, fontSize: 13, lineHeight: 20, color: t.text }}>{item.body}</Text>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <TopBar
        t={t}
        title={summary?.name ?? i18nT('channels.title')}
        left={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <Pressable onPress={onBack} hitSlop={8} accessibilityLabel={i18nT('common.back', 'Back')}><I.ChevronL size={22} color={t.text} /></Pressable>
            <Avatar t={t} name={summary?.name ?? '?'} seed={channelId} size={28} photoUri={channelAvatarUri} />
          </View>
        }
        right={
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
            {canSchedule && channelQueue.length > 0 && (
              <Pressable
                onPress={() => setShowQueue((v) => !v)}
                hitSlop={8}
                accessibilityLabel={i18nT('channels.scheduledQueue', 'Scheduled posts')}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <I.Timer size={14} color={t.accent} />
                  <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, fontWeight: '600' }}>
                    {channelQueue.length}
                  </Text>
                </View>
              </Pressable>
            )}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <I.Lock size={11} color={t.accent} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, textTransform: 'uppercase' }}>{i18nT('channels.sealed')}</Text>
            </View>
            {onOpenInfo && (
              <Pressable onPress={onOpenInfo} hitSlop={8} accessibilityLabel={i18nT('channelInfo.title', 'Channel info')}>
                <I.More size={20} color={t.text} />
              </Pressable>
            )}
          </View>
        }
      />

      {/* ── Scheduled queue panel (toggle) ──────────────────────────────── */}
      {showQueue && channelQueue.length > 0 && (
        <View style={{ borderBottomWidth: 1, borderBottomColor: t.divider, backgroundColor: t.surface, maxHeight: 240 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 14, paddingVertical: 8 }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1 }}>
              {i18nT('channels.scheduledQueueTitle', 'SCHEDULED POSTS')} · {channelQueue.length}
            </Text>
            <Pressable onPress={() => setShowQueue(false)} hitSlop={8} accessibilityLabel={i18nT('common.close', 'Close')}>
              <I.X size={14} color={t.textDim} />
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: 200 }}>
            {channelQueue.map((q) => {
              const bodyText = decryptedQueue[q.id] ?? '...';
              const isDraft = q.status === 'draft';
              return (
                <View
                  key={q.id}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingHorizontal: 14, paddingVertical: 9,
                    borderTopWidth: 1, borderTopColor: t.divider,
                  }}
                >
                  <I.Timer size={13} color={t.textDim} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>
                      {bodyText}
                    </Text>
                    <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: isDraft ? t.textFaint : t.accent, letterSpacing: 0.5, marginTop: 2 }}>
                      {isDraft
                        ? i18nT('channels.draftChip', 'DRAFT')
                        : `${formatQueueWhen(q.sendAt)} · ${formatCountdown(q.sendAt - Date.now())}`}
                    </Text>
                  </View>
                  <Pressable
                    onPress={() => handleDeleteScheduled(q)}
                    hitSlop={6}
                    style={{ padding: 5 }}
                    accessibilityLabel={i18nT('channels.deleteScheduledTitle', 'Delete scheduled post')}
                  >
                    <I.Trash size={14} color={t.danger} />
                  </Pressable>
                </View>
              );
            })}
          </ScrollView>
        </View>
      )}

      <FlatList
        data={posts ?? []}
        keyExtractor={(p) => p.id}
        renderItem={renderPost}
        contentContainerStyle={{ paddingBottom: 12 }}
        ListEmptyComponent={
          <Text style={{ textAlign: 'center', marginTop: 40, fontFamily: t.font, fontSize: 13, color: t.textDim }}>
            {i18nT('channels.feedEmpty')}
          </Text>
        }
      />

      {canPost && (
        <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 8, padding: 10, paddingBottom: insets.bottom + 10, borderTopWidth: 1, borderTopColor: t.divider, backgroundColor: t.surface }}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={i18nT('channels.composePlaceholder')}
            placeholderTextColor={t.textFaint}
            multiline
            style={{ flex: 1, maxHeight: 120, backgroundColor: t.surface2, borderRadius: t.radius, paddingHorizontal: 14, paddingVertical: 10, color: t.text, fontFamily: t.font, fontSize: 15 }}
          />
          <Pressable
            onPress={() => void handleSend()}
            onLongPress={() => { if (canSchedule && draft.trim()) setShowPicker(true); }}
            disabled={!draft.trim() || sending}
            accessibilityLabel={canSchedule ? i18nT('channels.sendOrSchedule', 'Send — long-press to schedule') : i18nT('channels.composePlaceholder')}
            style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: draft.trim() ? t.accent : t.surface2, alignItems: 'center', justifyContent: 'center' }}
          >
            <I.Send size={18} color={draft.trim() ? t.accentInk : t.textFaint} />
          </Pressable>
        </View>
      )}

      <SchedulePicker
        visible={showPicker}
        onClose={() => setShowPicker(false)}
        onConfirm={(ts) => { void handleScheduleConfirm(ts); }}
      />
    </KeyboardAvoidingView>
  );
}
