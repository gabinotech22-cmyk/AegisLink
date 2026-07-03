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

import { useCallback, useEffect, useRef, useState } from 'react';
import { View, Text, Pressable, FlatList, TextInput, KeyboardAvoidingView, Platform, ScrollView, Image, Modal, AppState, type AppStateStatus } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as Crypto from 'expo-crypto';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { withPickingGuard } from '../utils/pickingGuard';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { MediaImage } from '../components/MediaImage';
import { ChannelAudioBubble } from '../components/ChannelAudioBubble';
import { GifPicker } from '../components/GifPicker';
import { VaultSticker } from '../components/stickers/VaultPack';
import { themedAlert } from '../components/AlertHost';
import { SchedulePicker } from '../components/SchedulePicker';
import { VoiceRecorderScreen } from './VoiceRecorder';
import { useChannelAvatar } from '../channels/useChannelAvatar';
import { encryptAndUploadMedia } from '../crypto/media';
import { useChannels, type FeedPost } from '../store/channels';
import type { PostMedia } from '../channels/channelService';
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

// ─── Image staging (mirrors GroupPosts: re-encode strips EXIF/GPS) ───────────

/** Best-effort unlink of a staged file. Cleanup only — never throws. */
async function deleteStagedFile(path: string): Promise<void> {
  try {
    const FS = await import('expo-file-system/legacy');
    await FS.deleteAsync(path, { idempotent: true });
  } catch { /* best-effort */ }
}

/** Copy a picked asset into the staging dir so it survives cache eviction. */
async function stageChannelImage(fromUri: string): Promise<string> {
  const FS = await import('expo-file-system/legacy');
  const Crypto = await import('expo-crypto');
  const dir = `${FS.documentDirectory}channelposts/`;
  await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
  const dest = `${dir}post_${Crypto.randomUUID()}.jpg`;
  await FS.copyAsync({ from: fromUri, to: dest });
  return dest;
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
  const hydrated = useChannels((s) => s.hydrated);
  const hydrateSubscribed = useChannels((s) => s.hydrateSubscribed);
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
  // Staged, EXIF-stripped image awaiting send (local documentDirectory path).
  const [attachedImage, setAttachedImage] = useState<{ path: string; w?: number; h?: number } | null>(null);
  const [showVoiceRecorder, setShowVoiceRecorder] = useState(false);
  const [showGifPicker, setShowGifPicker] = useState(false);
  // Local staged paths picked this session but not yet uploaded — unlink on unmount.
  const freshStagedPaths = useRef<Set<string>>(new Set());

  // Scheduled posts store
  const scheduled = useScheduledMessages((s) => s.scheduled);
  const { scheduleChannelPost, cancelScheduled, loadPending } = useScheduledMessages();

  useEffect(() => { void loadPending(); }, [loadPending]);

  // Defense in depth: the app-level rehydrate (App.tsx) normally hydrates
  // `subscribed` from SecureStore-persisted channel secrets before any screen
  // can be reached, but a screen opened via a fast deep link/notification tap
  // could still land here before that effect resolves. Self-hydrate (once,
  // idempotent) rather than render a degraded header/compose bar off a
  // possibly-still-empty `subscribed`.
  useEffect(() => {
    if (hydrated || summary) return;
    void hydrateSubscribed().catch(() => {});
  }, [hydrated, summary, hydrateSubscribed]);

  useEffect(() => {
    if (!identity) return;
    void loadFeed(channelId, identity);
    const off = attachLive(identity);
    return off;
  }, [channelId, identity, loadFeed, attachLive]);

  // Pull-on-foreground: if the user backgrounds the app while this screen is
  // mounted (e.g. a scheduled post fired while backgrounded, or the socket
  // dropped and attachLive's fan-out was missed), re-pull the delta on return
  // to foreground rather than waiting for the next unrelated re-mount/navigation.
  useEffect(() => {
    if (!identity) return;
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      if (s === 'active') void loadFeed(channelId, identity);
    });
    return () => sub.remove();
  }, [channelId, identity, loadFeed]);

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

  // Unlink any staged image still pending on unmount (never sent).
  useEffect(() => {
    const fresh = freshStagedPaths.current;
    return () => { for (const p of fresh) void deleteStagedFile(p); };
  }, []);

  const handlePickImage = useCallback(async () => {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      themedAlert(
        i18nT('groups.permissionDeniedTitle', 'Permission denied'),
        i18nT('groups.permissionDeniedGallery', 'Gallery access is required.'),
      );
      return;
    }
    const result = await withPickingGuard(() =>
      ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'] as ImagePicker.MediaType[], quality: 0.85 }),
    );
    if (!result || result.canceled || !result.assets?.[0]) return;
    try {
      // Re-encode → strips ALL EXIF/GPS metadata before it ever leaves the device.
      const compressed = await manipulateAsync(
        result.assets[0].uri,
        [{ resize: { width: 1280 } }],
        { compress: 0.75, format: SaveFormat.JPEG },
      );
      const dest = await stageChannelImage(compressed.uri);
      freshStagedPaths.current.add(dest);
      setAttachedImage((prev) => {
        if (prev && freshStagedPaths.current.delete(prev.path)) void deleteStagedFile(prev.path);
        return { path: dest, w: compressed.width, h: compressed.height };
      });
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }, [i18nT]);

  const handleRemoveImage = useCallback(() => {
    setAttachedImage((prev) => {
      if (prev && freshStagedPaths.current.delete(prev.path)) void deleteStagedFile(prev.path);
      return null;
    });
  }, []);

  // ── Voice note: record → E2EE blob → post as audio media ──
  const handleSendVoice = useCallback(async (uri: string, durationMs: number) => {
    setShowVoiceRecorder(false);
    if (!identity) return;
    try {
      const blobUri = await encryptAndUploadMedia(uri, 'audio/m4a');
      const media: PostMedia = { kind: 'audio', uri: blobUri, mime: 'audio/m4a', durationMs };
      const res = await sendPost(channelId, '', identity, myDisplayName, media);
      if (!res.ok) themedAlert(i18nT('channels.postFailed'), res.error ?? i18nT('channels.unknownError'));
    } catch (e) {
      themedAlert(i18nT('channels.postFailed'), (e as Error).message);
    }
  }, [identity, channelId, sendPost, myDisplayName, i18nT]);

  // ── GIF: download the remote GIF, encrypt it, and post as an image blob so the
  //    channel never leaks a fetch to the GIF provider (mirrors Chat). ──
  const handleGifSelect = useCallback(async (url: string) => {
    setShowGifPicker(false);
    if (!identity) return;
    const FS = await import('expo-file-system/legacy');
    const localPath = `${FS.cacheDirectory ?? ''}chgif_${Crypto.randomUUID()}.gif`;
    try {
      const dl = await FS.downloadAsync(url, localPath);
      if (!dl.uri) throw new Error('gif_download_failed');
      const info = await FS.getInfoAsync(dl.uri);
      if (((info as { size?: number }).size ?? 0) > 10 * 1024 * 1024) {
        await FS.deleteAsync(localPath, { idempotent: true }).catch(() => {});
        themedAlert(i18nT('channels.postFailed'), i18nT('channels.gifTooBig', 'GIF too large (max 10 MB)'));
        return;
      }
      const blobUri = await encryptAndUploadMedia(localPath, 'image/gif');
      await FS.deleteAsync(localPath, { idempotent: true }).catch(() => {});
      const media: PostMedia = { kind: 'image', uri: blobUri, mime: 'image/gif' };
      const res = await sendPost(channelId, '', identity, myDisplayName, media);
      if (!res.ok) themedAlert(i18nT('channels.postFailed'), res.error ?? i18nT('channels.unknownError'));
    } catch (e) {
      await FS.deleteAsync(localPath, { idempotent: true }).catch(() => {});
      themedAlert(i18nT('channels.postFailed'), (e as Error).message);
    }
  }, [identity, channelId, sendPost, myDisplayName, i18nT]);

  // Stickers post as a standalone `[sticker:vault_<key>]` marker (same wire form
  // chats use), rendered as the bundled asset by the feed below.
  const handleStickerSelect = useCallback(async (marker: string) => {
    setShowGifPicker(false);
    if (!identity) return;
    const res = await sendPost(channelId, marker, identity, myDisplayName);
    if (!res.ok) themedAlert(i18nT('channels.postFailed'), res.error ?? i18nT('channels.unknownError'));
  }, [identity, channelId, sendPost, myDisplayName, i18nT]);

  const handleSend = async () => {
    if (!identity || sending) return;
    const text = draft.trim();
    if (!text && !attachedImage) return;
    setSending(true);
    try {
      let media: PostMedia | null = null;
      if (attachedImage) {
        // Encrypt + upload as an E2EE blob; the key rides inside the sealed body.
        const blobUri = await encryptAndUploadMedia(attachedImage.path, 'image/jpeg');
        media = { kind: 'image', uri: blobUri, mime: 'image/jpeg', w: attachedImage.w, h: attachedImage.h };
      }
      const res = await sendPost(channelId, text, identity, myDisplayName, media);
      if (res.ok) {
        setDraft('');
        // Uploaded (blob persisted) — the staged plaintext is no longer needed.
        if (attachedImage) {
          freshStagedPaths.current.delete(attachedImage.path);
          void deleteStagedFile(attachedImage.path);
        }
        setAttachedImage(null);
      } else {
        themedAlert(i18nT('channels.postFailed'), res.error ?? i18nT('channels.unknownError'));
      }
    } catch (e) {
      themedAlert(i18nT('channels.postFailed'), (e as Error).message);
    } finally {
      setSending(false);
    }
  };

  const handleScheduleConfirm = useCallback(async (sendAt: number) => {
    const trimmed = draft.trim();
    if (!trimmed && !attachedImage) return;
    try {
      await scheduleChannelPost({
        channelId,
        body: trimmed,
        sendAt,
        options: attachedImage
          ? { media: { kind: 'image', path: attachedImage.path, mime: 'image/jpeg', w: attachedImage.w, h: attachedImage.h } }
          : undefined,
      });
      // The staged image is now owned by the store (uploaded at fire time), so
      // hand off ownership: drop it from the unmount-cleanup set.
      if (attachedImage) freshStagedPaths.current.delete(attachedImage.path);
      setDraft('');
      setAttachedImage(null);
      themedAlert(
        i18nT('channels.postScheduledTitle', 'Post scheduled'),
        i18nT('channels.postScheduledDesc', 'It will be posted to the channel automatically at the chosen time.'),
      );
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }, [draft, attachedImage, channelId, scheduleChannelPost, i18nT]);

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
    const stickerKey = item.body?.match(/^\[sticker:(vault_\w+)\]$/)?.[1];
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
        {item.media?.kind === 'image' && (
          <View style={{ borderRadius: t.radius, overflow: 'hidden', backgroundColor: t.surface2, marginBottom: item.body ? 7 : 0, maxWidth: 280 }}>
            <MediaImage
              uri={item.media.uri}
              ext={item.media.mime === 'image/gif' ? 'gif' : 'jpg'}
              accent={t.accent}
              resizeMode="cover"
              style={{ width: 280, aspectRatio: item.media.w && item.media.h ? item.media.w / item.media.h : 4 / 3 }}
            />
          </View>
        )}
        {item.media?.kind === 'audio' && (
          <View style={{ marginBottom: item.body ? 7 : 0 }}>
            <ChannelAudioBubble t={t} uri={item.media.uri} durationMs={item.media.durationMs} />
          </View>
        )}
        {stickerKey ? (
          <View style={{ width: 120, height: 120, borderRadius: t.radius, overflow: 'hidden', backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}>
            <VaultSticker stickerKey={stickerKey} size={112} />
          </View>
        ) : (
          !!item.body && <Text style={{ fontFamily: t.font, fontSize: 13, lineHeight: 20, color: t.text }}>{item.body}</Text>
        )}
      </Pressable>
    );
  };

  const hasContent = !!(draft.trim() || attachedImage);

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
        <View style={{ paddingBottom: insets.bottom + 10, borderTopWidth: 1, borderTopColor: t.divider, backgroundColor: t.surface }}>
          {attachedImage && (
            <View style={{ paddingHorizontal: 10, paddingTop: 10 }}>
              <View style={{ alignSelf: 'flex-start', borderRadius: t.radius, overflow: 'hidden', borderWidth: 1, borderColor: `${t.accent}44` }}>
                <Image source={{ uri: attachedImage.path }} style={{ width: 120, height: 120, backgroundColor: t.surface2 }} resizeMode="cover" />
                <Pressable
                  onPress={handleRemoveImage}
                  accessibilityLabel={i18nT('channels.removeImage', 'Remove image')}
                  style={{ position: 'absolute', top: 6, right: 6, width: 24, height: 24, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' }}
                >
                  <I.X size={14} color="#fff" />
                </Pressable>
                <View style={{ position: 'absolute', left: 6, bottom: 6, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 6, paddingVertical: 2, backgroundColor: 'rgba(0,0,0,0.55)', borderRadius: 99 }}>
                  <I.Check size={9} color={t.accent} />
                  <Text style={{ fontFamily: t.fontMono, fontSize: 8, color: t.accent, letterSpacing: 0.5 }}>
                    {i18nT('groupPosts.exifStripped', 'EXIF STRIPPED')}
                  </Text>
                </View>
              </View>
            </View>
          )}
          <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: 4, padding: 10 }}>
            {/* Attach stays put; GIF + mic collapse while typing (chat pattern) so
                the bar never crowds on a narrow screen. */}
            <Pressable
              onPress={() => void handlePickImage()}
              disabled={sending}
              hitSlop={8}
              accessibilityLabel={i18nT('channels.attachImage', 'Attach image')}
              style={{ padding: 7, opacity: sending ? 0.5 : 1 }}
            >
              <I.Attach size={22} color={t.accent} />
            </Pressable>
            {!draft.trim() && !attachedImage && (
              <>
                <Pressable
                  onPress={() => { setShowGifPicker((v) => !v); }}
                  disabled={sending}
                  hitSlop={8}
                  accessibilityLabel={i18nT('channels.attachGif', 'GIF / sticker')}
                  style={{ padding: 7, opacity: sending ? 0.5 : 1 }}
                >
                  <Text style={{ fontFamily: t.fontMono, fontSize: 12, fontWeight: '700', color: t.accent, letterSpacing: 0.5 }}>GIF</Text>
                </Pressable>
                <Pressable
                  onPress={() => setShowVoiceRecorder(true)}
                  disabled={sending}
                  hitSlop={8}
                  accessibilityLabel={i18nT('channels.voiceNote', 'Record voice note')}
                  style={{ padding: 7, opacity: sending ? 0.5 : 1 }}
                >
                  <I.Mic size={22} color={t.accent} />
                </Pressable>
              </>
            )}
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={i18nT('channels.composePlaceholder')}
              placeholderTextColor={t.textFaint}
              multiline
              style={{ flex: 1, maxHeight: 120, backgroundColor: t.surface2, borderRadius: t.radius, paddingHorizontal: 14, paddingVertical: 10, color: t.text, fontFamily: t.font, fontSize: 15 }}
            />
            {/* Schedule surfaces only once there's something to schedule. */}
            {canSchedule && hasContent && (
              <Pressable
                onPress={() => setShowPicker(true)}
                hitSlop={6}
                accessibilityLabel={i18nT('channels.schedulePost', 'Schedule post')}
                style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: t.surface2, alignItems: 'center', justifyContent: 'center' }}
              >
                <I.Timer size={18} color={t.accent} />
              </Pressable>
            )}
            <Pressable
              onPress={() => void handleSend()}
              onLongPress={() => { if (canSchedule && hasContent) setShowPicker(true); }}
              disabled={!hasContent || sending}
              accessibilityLabel={canSchedule ? i18nT('channels.sendOrSchedule', 'Send — long-press to schedule') : i18nT('channels.composePlaceholder')}
              style={{ width: 44, height: 44, borderRadius: 22, backgroundColor: hasContent ? t.accent : t.surface2, alignItems: 'center', justifyContent: 'center', opacity: sending ? 0.6 : 1 }}
            >
              <I.Send size={18} color={hasContent ? t.accentInk : t.textFaint} />
            </Pressable>
          </View>
        </View>
      )}

      <SchedulePicker
        visible={showPicker}
        onClose={() => setShowPicker(false)}
        onConfirm={(ts) => { void handleScheduleConfirm(ts); }}
      />

      {/* GIF / sticker panel — docked inline like the chat composer. */}
      <GifPicker
        visible={showGifPicker}
        onClose={() => setShowGifPicker(false)}
        onSelectGif={(url) => { void handleGifSelect(url); }}
        onSelectSticker={handleStickerSelect}
      />

      {/* Voice note recorder (full-screen modal, same as chats/groups). */}
      <Modal
        visible={showVoiceRecorder}
        animationType="slide"
        presentationStyle="fullScreen"
        onRequestClose={() => setShowVoiceRecorder(false)}
      >
        <VoiceRecorderScreen
          onBack={() => setShowVoiceRecorder(false)}
          onSend={(uri, durationMs) => { void handleSendVoice(uri, durationMs); }}
        />
      </Modal>
    </KeyboardAvoidingView>
  );
}
