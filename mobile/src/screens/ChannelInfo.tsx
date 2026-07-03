/**
 * ChannelInfo -- info/admin screen for a sealed public channel.
 *
 * Mirrors the layout of GroupAdmin.tsx (header with touchable avatar, Section
 * rows, danger zone) adapted to the channel vocabulary.
 *
 * Owner actions (replace/remove avatar, delete channel) require the Ed25519
 * signing secret persisted in SecureStore at channel creation.
 * Subscriber actions: share invite link, leave channel.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import { View, Text, Pressable, ScrollView, Image, Modal, TextInput, ActivityIndicator, Switch } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as Clipboard from 'expo-clipboard';
import { withPickingGuard } from '../utils/pickingGuard';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { AvatarCropModal } from '../components/AvatarCropModal';
import { ShareLinkSheet } from '../components/ShareLinkSheet';
import { TopBar } from '../components/TopBar';
import { Section } from '../components/Section';
import { themedAlert } from '../components/AlertHost';
import { useChannelAvatar } from '../channels/useChannelAvatar';
import { useChannels, type ChannelSummary } from '../store/channels';
import { useIdentity } from '../store/identity';
import { useContacts } from '../store/contacts';
import { usePreferences } from '../store/preferences';
import { setChannelMuted } from '../notifications/channelNotifications';
import { buildInviteLink } from '../channels/inviteLink';
import {
  getChannelSigningKey,
  getChannelCapability,
} from '../crypto/publicChannelStore';
import {
  signAvatarSet,
  signAvatarDelete,
  signTombstone,
} from '../crypto/publicChannelKey';
import {
  setChannelAvatar,
  deleteChannelAvatar,
} from '../api/publicChannels';
import {
  uploadAvatarBlob,
  hashLocalFile,
  evictChannelAvatar,
  cacheLocalAvatar,
} from '../channels/channelAvatarCache';
import { pubchannelTombstone } from '../socket/publicChannels';
import { logger } from '../utils/logger';
import type { PublicChannelType } from '../api/publicChannels';

// Channel type display labels (i18n keys)
const TYPE_LABELS: Record<string, string> = {
  open: 'channels.typeOpen',
  readonly: 'channels.typeReadonly',
  moderated: 'channels.typeModerated',
  approval: 'channels.typeApproval',
};

// Same 4 types + copy as ChannelCreate.tsx — kept in sync with that screen.
const TYPE_IDS: Array<{ id: PublicChannelType; labelKey: string; descKey: string }> = [
  { id: 'open', labelKey: 'channels.typeOpen', descKey: 'channels.typeOpenDesc' },
  { id: 'readonly', labelKey: 'channels.typeReadonly', descKey: 'channels.typeReadonlyDesc' },
  { id: 'moderated', labelKey: 'channels.typeModerated', descKey: 'channels.typeModeratedDesc' },
  { id: 'approval', labelKey: 'channels.typeApproval', descKey: 'channels.typeApprovalDesc' },
];

interface Props {
  channelId: string;
  onBack: () => void;
}

export function ChannelInfoScreen({ channelId, onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);

  // Live summary from store
  const summary = useChannels((s) => s.subscribed.find((c) => c.channelId === channelId));
  const removeChannel = useChannels((s) => s.removeChannel);
  const updateChannelInfo = useChannels((s) => s.updateChannelInfo);
  const listPendingJoins = useChannels((s) => s.listPendingJoins);
  const answerJoinRequest = useChannels((s) => s.answerJoinRequest);
  const banMember = useChannels((s) => s.banMember);
  const feed = useChannels((s) => s.feeds[channelId]);
  const bannedList = useChannels((s) => s.banned[channelId]);
  const contacts = useContacts((s) => s.contacts);

  const channelAvatarUri = useChannelAvatar(channelId, summary?.avatarHash ?? null);

  const [cropSource, setCropSource] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [showShareLink, setShowShareLink] = useState(false);
  const [signingKey, setSigningKey] = useState<Uint8Array | null>(null);
  const [capability, setCapability] = useState<Uint8Array | null>(null);

  // Phase 4: owner edit + approval-gated join queue
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editType, setEditType] = useState<PublicChannelType>('open');
  const [savingEdit, setSavingEdit] = useState(false);
  const [pendingJoins, setPendingJoins] = useState<Array<{ joinEpk: string; createdAt: number }>>([]);
  const [loadingJoins, setLoadingJoins] = useState(false);
  const [answeringEpk, setAnsweringEpk] = useState<string | null>(null);

  const isOwner = summary?.owned === true;
  const isApprovalChannel = summary?.channelType === 'approval';
  const [banningId, setBanningId] = useState<string | null>(null);

  // Member view (docs §10.5 — client-side roster only). Derived from data the
  // owner already possesses: authors seen in the decrypted feed. The relay
  // never stores or serves a member list.
  const members = useMemo(() => {
    const banned = new Set(bannedList ?? []);
    const byId = new Map(contacts.map((c) => [c.aegisId, c.name] as const));
    const seen = new Set<string>();
    const out: Array<{ aegisId: string; name: string; isSelf: boolean }> = [];
    for (const post of feed ?? []) {
      if (seen.has(post.from) || banned.has(post.from)) continue;
      seen.add(post.from);
      out.push({
        aegisId: post.from,
        name: byId.get(post.from) ?? post.from,
        isSelf: post.from === identity?.aegisId,
      });
    }
    // Self first, then by name for a stable list.
    return out.sort((a, b) => (a.isSelf === b.isSelf ? a.name.localeCompare(b.name) : a.isSelf ? -1 : 1));
  }, [feed, bannedList, contacts, identity?.aegisId]);

  // Per-channel notification toggle — DEVICE-LOCAL preference (encrypted
  // SecureStore blob); the mute state never travels to the relay (#206).
  const mutedChannels = usePreferences((s) => s.mutedChannels);
  const notificationsEnabled = !mutedChannels.includes(channelId);
  const handleToggleNotifications = useCallback((enabled: boolean) => {
    void setChannelMuted(channelId, !enabled);
  }, [channelId]);

  // Load signing key + capability on mount (async SecureStore)
  useEffect(() => {
    void (async () => {
      const sk = await getChannelSigningKey(channelId);
      setSigningKey(sk);
      const cap = await getChannelCapability(channelId);
      setCapability(cap);
    })();
  }, [channelId]);

  // Owner of an approval-gated channel: load the pending join queue.
  const refreshPendingJoins = useCallback(async () => {
    setLoadingJoins(true);
    try {
      const res = await listPendingJoins(channelId);
      if (res.ok) setPendingJoins(res.pending ?? []);
    } finally {
      setLoadingJoins(false);
    }
  }, [channelId, listPendingJoins]);

  useEffect(() => {
    if (isOwner && isApprovalChannel && signingKey) void refreshPendingJoins();
  }, [isOwner, isApprovalChannel, signingKey, refreshPendingJoins]);

  // ── Avatar pick (owner only) ───────────────────────────────────────────────

  // Tapping the header avatar (owner only) is the single entry point for avatar
  // edits — mirrors the group-info flow. When a photo already exists it offers
  // Replace/Remove; otherwise it picks straight away. (The old duplicate
  // "AVATAR" section below was removed.)
  function handleAvatarPress() {
    if (!isOwner || !signingKey) return;
    if (channelAvatarUri) {
      themedAlert(
        i18nT('channelInfo.avatarActionsTitle', 'Channel photo'),
        i18nT('channelInfo.avatarActionsDesc', 'Replace or remove the channel photo.'),
        [
          { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
          { text: i18nT('channelInfo.removePhoto', 'Remove photo'), style: 'destructive', onPress: () => void handleRemoveAvatar() },
          { text: i18nT('channelInfo.replacePhoto', 'Replace photo'), onPress: () => void handlePickAvatar() },
        ],
      );
    } else {
      void handlePickAvatar();
    }
  }

  async function handlePickAvatar() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      themedAlert(
        i18nT('groups.permissionDeniedTitle', 'Permission denied'),
        i18nT('groups.permissionDeniedGallery', 'Gallery access is required.'),
      );
      return;
    }
    const result = await withPickingGuard(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as ImagePicker.MediaType[],
        quality: 0.8,
      }),
    );
    if (!result.canceled && result.assets && result.assets.length > 0) {
      const asset = result.assets[0];
      setCropSource({ uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 });
    }
  }

  async function handleConfirmAvatar(uri: string) {
    setCropSource(null);
    if (!signingKey) return;
    try {
      const compressed = await manipulateAsync(
        uri,
        [{ resize: { width: 256 } }],
        { compress: 0.7, format: SaveFormat.JPEG },
      );
      // Upload + sign + associate
      const blobId = await uploadAvatarBlob(compressed.uri);
      const sig = signAvatarSet(channelId, blobId, signingKey);
      await setChannelAvatar(channelId, blobId, encodeBase64(sig));
      // Update local cache
      await evictChannelAvatar(channelId);
      await cacheLocalAvatar(channelId, compressed.uri);
      // Compute new hash for the summary
      const newHash = await hashLocalFile(compressed.uri);
      // Update store summary with new avatarHash
      useChannels.setState((s) => ({
        subscribed: s.subscribed.map((c) =>
          c.channelId === channelId ? { ...c, avatarHash: newHash } : c,
        ),
      }));
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }

  // ── Remove avatar (owner only) ─────────────────────────────────────────────

  async function handleRemoveAvatar() {
    if (!signingKey) return;
    themedAlert(
      i18nT('channelInfo.removePhotoTitle', 'Remove photo'),
      i18nT('channelInfo.removePhotoDesc', 'Remove the channel avatar?'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: i18nT('common.delete', 'Delete'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                const sig = signAvatarDelete(channelId, signingKey);
                await deleteChannelAvatar(channelId, encodeBase64(sig));
                await evictChannelAvatar(channelId);
                useChannels.setState((s) => ({
                  subscribed: s.subscribed.map((c) =>
                    c.channelId === channelId ? { ...c, avatarHash: null } : c,
                  ),
                }));
              } catch (e) {
                themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
              }
            })();
          },
        },
      ],
    );
  }

  // ── Delete channel (owner only — tombstone) ────────────────────────────────

  function handleDeleteChannel() {
    if (!signingKey) return;
    themedAlert(
      i18nT('channelInfo.deleteChannelTitle', 'Delete channel'),
      i18nT('channelInfo.deleteChannelDesc', 'This permanently destroys the channel for everyone. This cannot be undone.'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: i18nT('channelInfo.deleteConfirm', 'Delete forever'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              try {
                const ts = Date.now();
                const sig = signTombstone(channelId, ts, signingKey);
                await pubchannelTombstone(channelId, ts, encodeBase64(sig));
                await removeChannel(channelId);
                onBack();
              } catch (e) {
                logger.warn(`[ChannelInfo] tombstone failed: ${(e as Error).message}`);
                themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
              }
            })();
          },
        },
      ],
    );
  }

  // ── Leave channel (subscriber) ─────────────────────────────────────────────

  function handleLeaveChannel() {
    themedAlert(
      i18nT('channelInfo.leaveTitle', 'Leave channel'),
      i18nT('channelInfo.leaveDesc', 'You will stop receiving posts and your keys will be deleted.'),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: i18nT('channelInfo.leaveConfirm', 'Leave'),
          style: 'destructive',
          onPress: () => {
            void (async () => {
              await removeChannel(channelId);
              onBack();
            })();
          },
        },
      ],
    );
  }

  // ── Edit name / description (owner — re-signs the manifest, Phase 4) ──────

  function openEdit() {
    if (!summary) return;
    setEditName(summary.name);
    setEditDesc(summary.description);
    setEditType(summary.channelType);
    setEditOpen(true);
  }

  function applyEdit() {
    setSavingEdit(true);
    void (async () => {
      try {
        const res = await updateChannelInfo(channelId, {
          name: editName,
          description: editDesc,
          channelType: editType,
        });
        if (res.ok) {
          setEditOpen(false);
        } else {
          themedAlert(i18nT('common.error', 'Error'), res.error ?? i18nT('channels.unknownError'));
        }
      } finally {
        setSavingEdit(false);
      }
    })();
  }

  function handleSaveEdit() {
    if (savingEdit || !editName.trim() || !summary) return;
    // private → (open|readonly|moderated) makes the channel visible/joinable
    // under the new type's rules — warn before re-signing. The reverse
    // (anything → private/approval) needs no special warning.
    const wasPrivate = summary.channelType === 'approval';
    const becomingPublic = editType !== 'approval';
    if (wasPrivate && becomingPublic && editType !== summary.channelType) {
      themedAlert(
        i18nT('channelInfo.typeChangeConfirmTitle', 'Change channel type'),
        i18nT('channelInfo.typeChangeConfirmDesc', {
          type: i18nT(TYPE_LABELS[editType] ?? 'channels.typeOpen'),
          defaultValue:
            "Changing from private to {{type}} will make this channel visible or joinable to others per the new type's rules. Continue?",
        }),
        [
          { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
          { text: i18nT('common.confirm', 'Confirm'), onPress: applyEdit },
        ],
      );
      return;
    }
    applyEdit();
  }

  // ── Approve / reject a join request (owner, approval channels) ────────────

  function handleAnswerJoin(joinEpk: string, approve: boolean) {
    if (answeringEpk) return;
    setAnsweringEpk(joinEpk);
    void (async () => {
      try {
        const res = await answerJoinRequest(channelId, joinEpk, approve);
        if (res.ok) {
          setPendingJoins((prev) => prev.filter((p) => p.joinEpk !== joinEpk));
        } else {
          themedAlert(i18nT('common.error', 'Error'), res.error ?? i18nT('channels.unknownError'));
        }
      } finally {
        setAnsweringEpk(null);
      }
    })();
  }

  // ── Ban a member (owner — signed ban record, docs §10.4) ──────────────────

  function handleBanMember(memberAegisId: string, displayName: string) {
    if (banningId) return;
    themedAlert(
      i18nT('channelInfo.banTitle', 'Ban member'),
      i18nT('channelInfo.banDesc', { name: displayName }),
      [
        { text: i18nT('common.cancel', 'Cancel'), style: 'cancel' },
        {
          text: i18nT('channelInfo.banConfirm', 'Ban'),
          style: 'destructive',
          onPress: () => {
            setBanningId(memberAegisId);
            void (async () => {
              try {
                const res = await banMember(channelId, memberAegisId);
                if (!res.ok) {
                  themedAlert(i18nT('common.error', 'Error'), res.error ?? i18nT('channels.unknownError'));
                }
              } finally {
                setBanningId(null);
              }
            })();
          },
        },
      ],
    );
  }

  // ── Build invite link ──────────────────────────────────────────────────────

  function getInviteLink(): string {
    if (!capability || !summary) return '';
    // The link needs the channel's Ed25519 pubkey: owners derive it from the
    // signing secret (bytes 32..64); subscribers use the copy persisted in the
    // summary from the verified manifest at join/hydrate time.
    let pub: Uint8Array | null = null;
    if (signingKey) {
      pub = signingKey.subarray(32);
    } else if (summary.channelEd25519PubB64) {
      try {
        pub = decodeBase64(summary.channelEd25519PubB64);
      } catch {
        pub = null;
      }
    }
    if (!pub) return ''; // legacy subscription without a stored pubkey
    return buildInviteLink({
      channelId,
      channelEd25519Pub: pub,
      capability: summary.channelType === 'approval' ? null : capability,
      approvalGated: summary.channelType === 'approval',
    });
  }

  if (!summary) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
        <TopBar
          t={t}
          title={i18nT('channelInfo.title', 'Channel info')}
          left={
            <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
              <I.ChevronL size={22} color={t.textDim} />
            </Pressable>
          }
        />
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', padding: 32 }}>
          <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, textAlign: 'center' }}>
            {i18nT('channelInfo.notFound', 'Channel not found or you are no longer subscribed.')}
          </Text>
        </View>
      </View>
    );
  }

  const inviteLink = getInviteLink();
  const typeLabelKey = TYPE_LABELS[summary.channelType] ?? 'channels.typeOpen';

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('channelInfo.title', 'Channel info')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        {/* Header */}
        <View style={{ alignItems: 'center', paddingHorizontal: 22, paddingTop: 14, paddingBottom: 18 }}>
          <Pressable
            onPress={isOwner && signingKey ? handleAvatarPress : undefined}
            disabled={!isOwner || !signingKey}
            accessibilityLabel={i18nT('channelInfo.changeAvatar', 'Change channel photo')}
          >
            {channelAvatarUri ? (
              <Image
                source={{ uri: channelAvatarUri }}
                style={{ width: 76, height: 76, borderRadius: t.radiusL }}
                resizeMode="cover"
              />
            ) : (
              <Avatar
                t={t}
                name={summary.name}
                color={t.accent}
                size={76}
                seed={channelId}
              />
            )}
            {isOwner && signingKey && (
              <View
                style={{
                  position: 'absolute',
                  right: -2,
                  bottom: -2,
                  width: 26,
                  height: 26,
                  borderRadius: 13,
                  backgroundColor: t.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderWidth: 2,
                  borderColor: t.bg,
                }}
              >
                <I.Image size={13} color={t.accentInk} />
              </View>
            )}
          </Pressable>

          {/* Channel name */}
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text, marginTop: 12, textAlign: 'center' }}>
            {summary.name}
          </Text>

          {/* Sealed badge + type */}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <I.Lock size={11} color={t.accent} />
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, textTransform: 'uppercase' }}>
                {i18nT('channels.sealed')}
              </Text>
            </View>
            <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 99, borderWidth: 1, borderColor: `${t.textDim}44` }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 0.5 }}>
                {i18nT(typeLabelKey)}
              </Text>
            </View>
            {isOwner && (
              <View style={{ paddingHorizontal: 6, paddingVertical: 2, borderRadius: 99, borderWidth: 1, borderColor: `${t.accent}66` }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 0.8 }}>
                  {i18nT('channelInfo.ownerBadge', 'OWNER')}
                </Text>
              </View>
            )}
          </View>

          {/* Description (from the signature-verified manifest) */}
          {summary.description.length > 0 && (
            <Text style={{ fontFamily: t.font, fontSize: 13, lineHeight: 19, color: t.textDim, marginTop: 10, textAlign: 'center', paddingHorizontal: 8 }}>
              {summary.description}
            </Text>
          )}
        </View>

        {/* Details */}
        <Section t={t} label={i18nT('channelInfo.detailsSection', 'DETAILS').toUpperCase()}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 }}>
            <I.Users size={18} color={t.textDim} />
            <Text style={{ flex: 1, fontFamily: t.font, fontSize: 15, color: t.text }}>
              {i18nT('channelInfo.typeLabel', 'Channel type')}
            </Text>
            <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim }}>
              {i18nT(typeLabelKey)}
            </Text>
          </View>
          <Pressable
            onPress={() => {
              void Clipboard.setStringAsync(channelId).then(() => {
                themedAlert(
                  i18nT('channelInfo.idCopiedTitle', 'Copied'),
                  i18nT('channelInfo.idCopiedDesc', 'Channel ID copied to clipboard.'),
                );
              });
            }}
            accessibilityLabel={i18nT('channelInfo.copyId', 'Copy channel ID')}
            style={({ pressed }) => ({
              flexDirection: 'row', alignItems: 'center', gap: 14,
              paddingHorizontal: 16, paddingVertical: 14,
              opacity: pressed ? 0.7 : 1,
              borderTopWidth: 1, borderTopColor: t.divider,
            })}
          >
            <I.Key size={18} color={t.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.font, fontSize: 15, color: t.text }}>
                {i18nT('channelInfo.channelId', 'Channel ID')}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2 }} numberOfLines={1}>
                {channelId}
              </Text>
            </View>
          </Pressable>
        </Section>

        {/* Notifications (per-channel mute, device-local) */}
        <Section t={t} label={i18nT('channelInfo.notificationsSection', 'Notifications').toUpperCase()}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, paddingHorizontal: 16, paddingVertical: 14 }}>
            <I.Bell size={18} color={notificationsEnabled ? t.accent : t.textDim} />
            <View style={{ flex: 1 }}>
              <Text style={{ fontFamily: t.font, fontSize: 15, color: t.text }}>
                {i18nT('channelInfo.notificationsToggle', 'New post notifications')}
              </Text>
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                {i18nT('channelInfo.notificationsToggleSub', 'Only on this device — never shared with the server')}
              </Text>
            </View>
            <Switch
              value={notificationsEnabled}
              onValueChange={handleToggleNotifications}
              trackColor={{ false: t.surface2, true: t.accent }}
              thumbColor={t.bg}
              accessibilityLabel={i18nT('channelInfo.notificationsToggle', 'New post notifications')}
            />
          </View>
        </Section>

        {/* Owner: edit name / description (re-signed manifest) */}
        {isOwner && signingKey && (
          <Section t={t} label={i18nT('channelInfo.editSection', 'EDIT').toUpperCase()}>
            <Pressable
              onPress={openEdit}
              accessibilityLabel={i18nT('channelInfo.editChannel', 'Edit name & description')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 14,
                paddingHorizontal: 16, paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <I.Type size={18} color={t.accent} />
              <Text style={{ flex: 1, fontFamily: t.font, fontSize: 15, color: t.accent, fontWeight: '500' }}>
                {i18nT('channelInfo.editChannel', 'Edit name & description')}
              </Text>
            </Pressable>
          </Section>
        )}

        {/* Owner of an approval channel: pending join requests queue */}
        {isOwner && signingKey && isApprovalChannel && (
          <Section t={t} label={`${i18nT('channelInfo.joinRequestsSection', 'JOIN REQUESTS').toUpperCase()}${pendingJoins.length > 0 ? ` · ${pendingJoins.length}` : ''}`}>
            {loadingJoins && pendingJoins.length === 0 ? (
              <View style={{ padding: 16, alignItems: 'center' }}>
                <ActivityIndicator color={t.accent} />
              </View>
            ) : pendingJoins.length === 0 ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
                <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>
                  {i18nT('channelInfo.noJoinRequests', 'No pending requests.')}
                </Text>
              </View>
            ) : (
              pendingJoins.map((p, idx) => (
                <View
                  key={p.joinEpk}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingHorizontal: 16, paddingVertical: 12,
                    borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: t.divider,
                  }}
                >
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 11, color: t.text }}>
                      {p.joinEpk.slice(0, 16)}…
                    </Text>
                    <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 2 }}>
                      {new Date(p.createdAt).toLocaleString()}
                    </Text>
                  </View>
                  {answeringEpk === p.joinEpk ? (
                    <ActivityIndicator color={t.accent} />
                  ) : (
                    <>
                      <Pressable
                        onPress={() => handleAnswerJoin(p.joinEpk, false)}
                        accessibilityLabel={i18nT('channelInfo.rejectRequest', 'Reject request')}
                        hitSlop={6}
                        style={({ pressed }) => ({
                          paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99,
                          borderWidth: 1, borderColor: `${t.danger}66`,
                          opacity: pressed ? 0.7 : 1,
                        })}
                      >
                        <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.danger }}>
                          {i18nT('channelInfo.reject', 'Reject')}
                        </Text>
                      </Pressable>
                      <Pressable
                        onPress={() => handleAnswerJoin(p.joinEpk, true)}
                        accessibilityLabel={i18nT('channelInfo.approveRequest', 'Approve request')}
                        hitSlop={6}
                        style={({ pressed }) => ({
                          paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99,
                          backgroundColor: t.accent,
                          opacity: pressed ? 0.85 : 1,
                        })}
                      >
                        <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.accentInk }}>
                          {i18nT('channelInfo.approve', 'Approve')}
                        </Text>
                      </Pressable>
                    </>
                  )}
                </View>
              ))
            )}
            <Pressable
              onPress={() => void refreshPendingJoins()}
              accessibilityLabel={i18nT('channelInfo.refreshRequests', 'Refresh requests')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6,
                paddingVertical: 11, borderTopWidth: 1, borderTopColor: t.divider,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.5 }}>
                {i18nT('channelInfo.refreshRequests', 'Refresh requests').toUpperCase()}
              </Text>
            </Pressable>
          </Section>
        )}

        {/* Owner: member view + ban (roster is client-side only — docs §10.5) */}
        {isOwner && signingKey && (
          <Section t={t} label={`${i18nT('channelInfo.membersSection', 'MEMBERS').toUpperCase()}${members.length > 0 ? ` · ${members.length}` : ''}`}>
            {members.length === 0 ? (
              <View style={{ paddingHorizontal: 16, paddingVertical: 14 }}>
                <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim }}>
                  {i18nT('channelInfo.noMembersYet', 'No members seen yet. Members appear here once they post.')}
                </Text>
              </View>
            ) : (
              members.map((m, idx) => (
                <View
                  key={m.aegisId}
                  style={{
                    flexDirection: 'row', alignItems: 'center', gap: 10,
                    paddingHorizontal: 16, paddingVertical: 12,
                    borderTopWidth: idx === 0 ? 0 : 1, borderTopColor: t.divider,
                  }}
                >
                  <Avatar t={t} name={m.name} color={t.accent} size={34} seed={m.aegisId} />
                  <View style={{ flex: 1, minWidth: 0 }}>
                    <Text numberOfLines={1} style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>
                      {m.isSelf ? i18nT('channelInfo.you', 'You') : m.name}
                    </Text>
                    <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginTop: 2 }}>
                      {m.aegisId}
                    </Text>
                  </View>
                  {!m.isSelf && (banningId === m.aegisId ? (
                    <ActivityIndicator color={t.danger} />
                  ) : (
                    <Pressable
                      onPress={() => handleBanMember(m.aegisId, m.name)}
                      accessibilityLabel={i18nT('channelInfo.banMember', 'Ban member')}
                      hitSlop={6}
                      style={({ pressed }) => ({
                        paddingHorizontal: 12, paddingVertical: 7, borderRadius: 99,
                        borderWidth: 1, borderColor: `${t.danger}66`,
                        opacity: pressed ? 0.7 : 1,
                      })}
                    >
                      <Text style={{ fontFamily: t.font, fontSize: 12, fontWeight: '600', color: t.danger }}>
                        {i18nT('channelInfo.banConfirm', 'Ban')}
                      </Text>
                    </Pressable>
                  ))}
                </View>
              ))
            )}
            {(bannedList ?? []).map((b) => (
              <View
                key={b}
                style={{
                  flexDirection: 'row', alignItems: 'center', gap: 10,
                  paddingHorizontal: 16, paddingVertical: 12,
                  borderTopWidth: 1, borderTopColor: t.divider,
                  opacity: 0.6,
                }}
              >
                <View style={{ flex: 1, minWidth: 0 }}>
                  <Text numberOfLines={1} style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim }}>
                    {b}
                  </Text>
                </View>
                <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.danger, letterSpacing: 0.8, textTransform: 'uppercase' }}>
                  {i18nT('channelInfo.bannedBadge', 'Banned')}
                </Text>
              </View>
            ))}
          </Section>
        )}

        {/* Avatar edits live on the header avatar tap (see handleAvatarPress) —
            the old duplicate "AVATAR" section was removed. */}

        {/* Invite link */}
        {inviteLink.length > 0 && (
          <Section t={t} label={i18nT('channelInfo.inviteSection', 'INVITE LINK').toUpperCase()}>
            <Pressable
              onPress={() => setShowShareLink(true)}
              accessibilityLabel={i18nT('channelInfo.shareInvite', 'Share invite link')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 14,
                paddingHorizontal: 16, paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <I.Link size={18} color={t.accent} />
              <View style={{ flex: 1 }}>
                <Text style={{ fontFamily: t.font, fontSize: 15, color: t.accent, fontWeight: '500' }}>
                  {i18nT('channelInfo.shareInvite', 'Share invite link')}
                </Text>
                <Text style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2 }}>
                  {i18nT('channelInfo.shareInviteSub', 'Anyone with the link can join')}
                </Text>
              </View>
            </Pressable>
          </Section>
        )}

        {/* Danger zone */}
        <Section t={t} label={i18nT('channelInfo.dangerZone', 'DANGER ZONE').toUpperCase()}>
          {isOwner && signingKey ? (
            <Pressable
              onPress={handleDeleteChannel}
              accessibilityLabel={i18nT('channelInfo.deleteChannel', 'Delete channel')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 14,
                paddingHorizontal: 16, paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <I.X size={18} color={t.danger} />
              <Text style={{ flex: 1, fontFamily: t.font, fontSize: 15, color: t.danger, fontWeight: '500' }}>
                {i18nT('channelInfo.deleteChannel', 'Delete channel')}
              </Text>
            </Pressable>
          ) : (
            <Pressable
              onPress={handleLeaveChannel}
              accessibilityLabel={i18nT('channelInfo.leaveChannel', 'Leave channel')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 14,
                paddingHorizontal: 16, paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <I.X size={18} color={t.danger} />
              <Text style={{ flex: 1, fontFamily: t.font, fontSize: 15, color: t.danger, fontWeight: '500' }}>
                {i18nT('channelInfo.leaveChannel', 'Leave channel')}
              </Text>
            </Pressable>
          )}
        </Section>
      </ScrollView>

      {/* Avatar crop modal */}
      <AvatarCropModal
        t={t}
        visible={cropSource !== null}
        imageUri={cropSource?.uri ?? null}
        imageWidth={cropSource?.width ?? 0}
        imageHeight={cropSource?.height ?? 0}
        title={i18nT('channelInfo.changeAvatar', 'Change channel photo')}
        confirmLabel={i18nT('common.confirm', 'Confirm')}
        cancelLabel={i18nT('common.cancel', 'Cancel')}
        onCancel={() => setCropSource(null)}
        onConfirm={(uri) => { void handleConfirmAvatar(uri); }}
      />

      {/* Edit name/description modal (owner) */}
      <Modal visible={editOpen} transparent animationType="fade" onRequestClose={() => setEditOpen(false)}>
        <Pressable onPress={() => setEditOpen(false)} style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'center', padding: 24 }}>
          <Pressable onPress={() => {}} style={{ backgroundColor: t.surface, borderRadius: t.radius, padding: 18, borderWidth: 1, borderColor: t.border }}>
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 18, color: t.text, marginBottom: 12 }}>
              {i18nT('channelInfo.editChannel', 'Edit name & description')}
            </Text>
            <TextInput
              value={editName}
              onChangeText={setEditName}
              placeholder={i18nT('channels.namePlaceholder', 'Channel name')}
              placeholderTextColor={t.textFaint}
              maxLength={64}
              style={{ backgroundColor: t.surface2, color: t.text, borderRadius: t.radiusS, paddingVertical: 12, paddingHorizontal: 14, fontFamily: t.font, fontSize: 15 }}
            />
            <TextInput
              value={editDesc}
              onChangeText={setEditDesc}
              placeholder={i18nT('channels.descPlaceholder', 'Description (optional)')}
              placeholderTextColor={t.textFaint}
              multiline
              maxLength={280}
              style={{ backgroundColor: t.surface2, color: t.text, borderRadius: t.radiusS, paddingVertical: 12, paddingHorizontal: 14, fontFamily: t.font, fontSize: 14, marginTop: 10, minHeight: 72, textAlignVertical: 'top' }}
            />

            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginTop: 14, marginBottom: 6, letterSpacing: 0.5 }}>
              {i18nT('channelInfo.editChannelType', 'Channel type').toUpperCase()}
            </Text>
            <View style={{ gap: 8 }}>
              {TYPE_IDS.map((ty) => {
                const on = editType === ty.id;
                return (
                  <Pressable
                    key={ty.id}
                    onPress={() => setEditType(ty.id)}
                    accessibilityLabel={i18nT(ty.labelKey)}
                    style={{
                      flexDirection: 'row', alignItems: 'center', gap: 10,
                      paddingVertical: 11, paddingHorizontal: 13,
                      borderWidth: 1, borderColor: on ? t.accent : t.border,
                      borderRadius: t.radius, backgroundColor: on ? t.surface2 : t.surface,
                    }}
                  >
                    <View style={{ width: 16, height: 16, borderRadius: 8, borderWidth: 2, borderColor: on ? t.accent : t.borderStrong, backgroundColor: on ? t.accent : 'transparent' }} />
                    <View>
                      <Text style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: t.text }}>{i18nT(ty.labelKey)}</Text>
                      <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 1 }}>{i18nT(ty.descKey)}</Text>
                    </View>
                  </Pressable>
                );
              })}
            </View>

            <Pressable
              onPress={handleSaveEdit}
              disabled={!editName.trim() || savingEdit}
              accessibilityLabel={i18nT('common.save', 'Save')}
              style={{ marginTop: 14, backgroundColor: editName.trim() ? t.accent : t.surface2, borderRadius: t.radius, paddingVertical: 13, alignItems: 'center' }}
            >
              {savingEdit ? <ActivityIndicator color={t.accentInk} /> : (
                <Text style={{ fontFamily: t.font, fontWeight: '700', color: editName.trim() ? t.accentInk : t.textFaint }}>
                  {i18nT('common.save', 'Save')}
                </Text>
              )}
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

      {/* Share link sheet */}
      <ShareLinkSheet
        visible={showShareLink}
        onClose={() => setShowShareLink(false)}
        title={i18nT('channelInfo.shareInvite', 'Share invite link')}
        link={inviteLink}
        shareMessage={i18nT('channels.shareMessage', { name: summary.name })}
      />
    </View>
  );
}

void ({} as Theme); // keep import
