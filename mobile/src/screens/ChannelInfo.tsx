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

import { useState, useEffect } from 'react';
import { View, Text, Pressable, ScrollView, Image } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { encodeBase64 } from 'tweetnacl-util';
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

// Channel type display labels (i18n keys)
const TYPE_LABELS: Record<string, string> = {
  open: 'channels.typeOpen',
  readonly: 'channels.typeReadonly',
  moderated: 'channels.typeModerated',
  approval: 'channels.typeApproval',
};

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

  const channelAvatarUri = useChannelAvatar(channelId, summary?.avatarHash ?? null);

  const [cropSource, setCropSource] = useState<{ uri: string; width: number; height: number } | null>(null);
  const [showShareLink, setShowShareLink] = useState(false);
  const [signingKey, setSigningKey] = useState<Uint8Array | null>(null);
  const [capability, setCapability] = useState<Uint8Array | null>(null);

  const isOwner = summary?.owned === true;

  // Load signing key + capability on mount (async SecureStore)
  useEffect(() => {
    void (async () => {
      const sk = await getChannelSigningKey(channelId);
      setSigningKey(sk);
      const cap = await getChannelCapability(channelId);
      setCapability(cap);
    })();
  }, [channelId]);

  // ── Avatar pick (owner only) ───────────────────────────────────────────────

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

  // ── Build invite link ──────────────────────────────────────────────────────

  function getInviteLink(): string {
    if (!capability || !summary) return '';
    // We need the channel public key to build the link. For owned channels we
    // could derive it from the signing secret, but for subscribers we don't
    // have the pubkey directly. The invite link requires the channelEd25519Pub.
    // Since we don't store it separately, we derive it from the signingKey
    // (for owners) or skip (subscribers still share the channelId-based link).
    // For now, build with the signing key's public half if available.
    if (signingKey) {
      // Ed25519 secret key is 64 bytes: first 32 are seed, last 32 are public key
      const pub = signingKey.subarray(32);
      return buildInviteLink({
        channelId,
        channelEd25519Pub: pub,
        capability: summary.channelType === 'approval' ? null : capability,
        approvalGated: summary.channelType === 'approval',
      });
    }
    // Subscriber: we cannot build a full invite link without the channel pubkey.
    // Fall back to a minimal scheme link. In a future iteration the pubkey would
    // be persisted at join time.
    return '';
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
            onPress={isOwner && signingKey ? () => void handlePickAvatar() : undefined}
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
        </View>

        {/* Owner avatar actions */}
        {isOwner && signingKey && (
          <Section t={t} label={i18nT('channelInfo.avatarSection', 'AVATAR').toUpperCase()}>
            <Pressable
              onPress={() => void handlePickAvatar()}
              accessibilityLabel={i18nT('channelInfo.replacePhoto', 'Replace photo')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 14,
                paddingHorizontal: 16, paddingVertical: 14,
                opacity: pressed ? 0.7 : 1,
              })}
            >
              <I.Image size={18} color={t.accent} />
              <Text style={{ flex: 1, fontFamily: t.font, fontSize: 15, color: t.accent, fontWeight: '500' }}>
                {i18nT('channelInfo.replacePhoto', 'Replace photo')}
              </Text>
            </Pressable>
            {channelAvatarUri && (
              <Pressable
                onPress={() => void handleRemoveAvatar()}
                accessibilityLabel={i18nT('channelInfo.removePhoto', 'Remove photo')}
                style={({ pressed }) => ({
                  flexDirection: 'row', alignItems: 'center', gap: 14,
                  paddingHorizontal: 16, paddingVertical: 14,
                  opacity: pressed ? 0.7 : 1,
                  borderTopWidth: 1, borderTopColor: t.divider,
                })}
              >
                <I.X size={18} color={t.danger} />
                <Text style={{ flex: 1, fontFamily: t.font, fontSize: 15, color: t.danger, fontWeight: '500' }}>
                  {i18nT('channelInfo.removePhoto', 'Remove photo')}
                </Text>
              </Pressable>
            )}
          </Section>
        )}

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
