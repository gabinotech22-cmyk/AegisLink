/**
 * ChannelCreate -- create a sealed public channel (Phase 2d-2, Slice 2 avatar)
 *
 * Collects name/description/type + optional avatar photo, then calls
 * useChannels.createChannel which does ALL the crypto (identity, CEK, manifest
 * sign with avatarHash, CEK wrap, register, avatar upload, invite). On success
 * the shareable invite link is surfaced via ShareLinkSheet.
 *
 * Avatar picker follows EXACTLY the Groups.tsx pattern: pick image, hand off
 * to AvatarCropModal (256px square), compress, hash (SHA-256), pass to store.
 *
 * Design ref: prototype/screens-channels.jsx (ScreenChannelCreate, preview 64px)
 *           + Groups.tsx (pickAvatar + AvatarCropModal + groupImage).
 */

import { useState } from 'react';
import { View, Text, Pressable, ScrollView, TextInput, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useTheme } from '../theme/ThemeContext';
import { TopBar } from '../components/TopBar';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { AvatarCropModal } from '../components/AvatarCropModal';
import { ShareLinkSheet } from '../components/ShareLinkSheet';
import { themedAlert } from '../components/AlertHost';
import { withPickingGuard } from '../utils/pickingGuard';
import { hashLocalFile } from '../channels/channelAvatarCache';
import { useChannels } from '../store/channels';
import { useIdentity } from '../store/identity';
import type { PublicChannelType } from '../api/publicChannels';

interface Props {
  onBack: () => void;
  onCreated: () => void;
}

const TYPE_IDS: Array<{ id: PublicChannelType; labelKey: string; descKey: string }> = [
  { id: 'open', labelKey: 'channels.typeOpen', descKey: 'channels.typeOpenDesc' },
  { id: 'readonly', labelKey: 'channels.typeReadonly', descKey: 'channels.typeReadonlyDesc' },
  { id: 'moderated', labelKey: 'channels.typeModerated', descKey: 'channels.typeModeratedDesc' },
  { id: 'approval', labelKey: 'channels.typeApproval', descKey: 'channels.typeApprovalDesc' },
];

export function ChannelCreateScreen({ onBack, onCreated }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const identity = useIdentity((s) => s.identity);
  const createChannel = useChannels((s) => s.createChannel);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<PublicChannelType>('open');
  const [busy, setBusy] = useState(false);
  const [invite, setInvite] = useState<string | null>(null);

  // Avatar state -- same pattern as Groups.tsx
  const [avatarUri, setAvatarUri] = useState<string | null>(null);
  const [cropSource, setCropSource] = useState<{ uri: string; width: number; height: number } | null>(null);

  const canCreate = name.trim().length > 0 && !busy && identity;

  // ---- Avatar picker (identical to Groups.tsx handlePickImage) ----
  async function handlePickImage() {
    const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (status !== 'granted') {
      themedAlert(i18nT('groups.permissionDeniedTitle'), i18nT('groups.permissionDeniedGallery'));
      return;
    }
    const result = await withPickingGuard(() =>
      ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'] as ImagePicker.MediaType[],
        quality: 0.8,
      })
    );
    if (!result.canceled && result.assets && result.assets.length > 0) {
      const asset = result.assets[0];
      setCropSource({ uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 });
    }
  }

  async function handleTakePhoto() {
    const { status } = await ImagePicker.requestCameraPermissionsAsync();
    if (status !== 'granted') {
      themedAlert(i18nT('groups.permissionDeniedTitle'), i18nT('groups.permissionDeniedCamera'));
      return;
    }
    const result = await withPickingGuard(() =>
      ImagePicker.launchCameraAsync({
        mediaTypes: ['images'] as ImagePicker.MediaType[],
        quality: 0.8,
      })
    );
    if (!result.canceled && result.assets && result.assets.length > 0) {
      const asset = result.assets[0];
      setCropSource({ uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 });
    }
  }

  // Confirm from AvatarCropModal -- compress to 256px and stage.
  async function handleConfirmAvatar(uri: string) {
    setCropSource(null);
    try {
      const compressed = await manipulateAsync(
        uri,
        [{ resize: { width: 256 } }],
        { compress: 0.7, format: SaveFormat.JPEG },
      );
      setAvatarUri(compressed.uri);
    } catch (e) {
      themedAlert(i18nT('common.error', 'Error'), (e as Error).message);
    }
  }

  const handleCreate = async () => {
    if (!identity || !canCreate) return;
    setBusy(true);
    try {
      // Compute SHA-256 of the avatar file BEFORE passing to createChannel
      // (the hash goes into the manifest before signing).
      let avatarHash: Uint8Array | null = null;
      if (avatarUri) {
        avatarHash = await hashLocalFile(avatarUri);
      }

      const res = await createChannel(
        {
          name: name.trim(),
          description: description.trim(),
          channelType: type,
          avatarUri,
          avatarHash,
        },
        identity,
      );
      if (res.ok && res.invite) {
        setInvite(res.invite);
      } else {
        themedAlert(i18nT('channels.createFailed'), res.error ?? i18nT('channels.unknownError'));
      }
    } finally {
      setBusy(false);
    }
  };

  const lbl = { fontFamily: t.fontMono, fontSize: 10, color: t.textDim, marginBottom: 6, letterSpacing: 0.5 } as const;
  const inp = { backgroundColor: t.surface, color: t.text, borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS, paddingVertical: 12, paddingHorizontal: 14, fontFamily: t.font, fontSize: 15 } as const;

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('channels.newChannel')}
        left={<Pressable onPress={onBack} hitSlop={8} accessibilityLabel={i18nT('common.back', 'Back')}><I.ChevronL size={22} color={t.text} /></Pressable>}
      />
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24 }} keyboardShouldPersistTaps="handled">
        {/* Avatar preview -- 64px, photo if chosen, identicon/Globe otherwise */}
        <View style={{ alignItems: 'center', marginBottom: 12 }}>
          <Avatar
            t={t}
            name={name.trim() || 'Channel'}
            seed={name.trim() || 'new-channel'}
            size={64}
            photoUri={avatarUri}
          />
        </View>

        {/* Photo picking buttons -- identical layout to Groups.tsx */}
        <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'center', marginBottom: 20 }}>
          <Pressable
            onPress={handlePickImage}
            accessibilityLabel={i18nT('common.gallery', 'Gallery')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: t.radiusS,
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.borderStrong,
            }}
          >
            <I.Plus size={14} color={t.text} />
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>{i18nT('common.gallery', 'Gallery')}</Text>
          </Pressable>
          <Pressable
            onPress={handleTakePhoto}
            accessibilityLabel={i18nT('common.camera', 'Camera')}
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              paddingHorizontal: 12,
              paddingVertical: 8,
              borderRadius: t.radiusS,
              backgroundColor: t.surface,
              borderWidth: 1,
              borderColor: t.borderStrong,
            }}
          >
            <I.Video size={14} color={t.text} />
            <Text style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>{i18nT('common.camera', 'Camera')}</Text>
          </Pressable>
          {avatarUri && (
            <Pressable
              onPress={() => setAvatarUri(null)}
              accessibilityLabel={i18nT('common.remove', 'Remove')}
              style={{
                flexDirection: 'row',
                alignItems: 'center',
                gap: 6,
                paddingHorizontal: 12,
                paddingVertical: 8,
                borderRadius: t.radiusS,
                backgroundColor: `${t.danger}15`,
                borderWidth: 1,
                borderColor: t.danger,
              }}
            >
              <I.Trash size={14} color={t.danger} />
              <Text style={{ fontFamily: t.font, fontSize: 12, color: t.danger }}>{i18nT('common.remove', 'Remove')}</Text>
            </Pressable>
          )}
        </View>

        <Text style={lbl}>{i18nT('channels.nameLabel')}</Text>
        <TextInput value={name} onChangeText={setName} placeholder={i18nT('channels.namePlaceholder')} placeholderTextColor={t.textFaint} style={inp} maxLength={64} />

        <Text style={[lbl, { marginTop: 16 }]}>{i18nT('channels.descLabel')}</Text>
        <TextInput value={description} onChangeText={setDescription} placeholder={i18nT('channels.descPlaceholder')} placeholderTextColor={t.textFaint} style={inp} maxLength={140} />

        <Text style={[lbl, { marginTop: 16 }]}>{i18nT('channels.typeLabel')}</Text>
        <View style={{ gap: 8 }}>
          {TYPE_IDS.map((ty) => {
            const on = type === ty.id;
            return (
              <Pressable
                key={ty.id}
                onPress={() => setType(ty.id)}
                accessibilityLabel={i18nT(ty.labelKey)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 11, paddingHorizontal: 13, borderWidth: 1, borderColor: on ? t.accent : t.border, borderRadius: t.radius, backgroundColor: on ? t.surface2 : t.surface }}
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

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7, marginTop: 16 }}>
          <I.Lock size={12} color={t.textDim} />
          <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 10, color: t.textDim, lineHeight: 15 }}>
            {i18nT('channels.encryptNote')}
          </Text>
        </View>

        <Pressable
          onPress={handleCreate}
          disabled={!canCreate}
          accessibilityLabel={i18nT('channels.create')}
          style={{ marginTop: 22, backgroundColor: canCreate ? t.accent : t.surface2, borderRadius: t.radius, paddingVertical: 15, alignItems: 'center' }}
        >
          {busy ? <ActivityIndicator color={t.accentInk} /> : (
            <Text style={{ fontFamily: t.font, fontSize: 15, fontWeight: '700', color: canCreate ? t.accentInk : t.textFaint }}>{i18nT('channels.create')}</Text>
          )}
        </Pressable>
      </ScrollView>

      <ShareLinkSheet
        visible={invite !== null}
        onClose={() => { setInvite(null); onCreated(); }}
        link={invite ?? ''}
        title={i18nT('channels.shareTitle')}
        shareMessage={i18nT('channels.shareMessage', { name: name.trim() })}
      />

      <AvatarCropModal
        t={t}
        visible={cropSource !== null}
        imageUri={cropSource?.uri ?? null}
        imageWidth={cropSource?.width ?? 0}
        imageHeight={cropSource?.height ?? 0}
        title={i18nT('channels.channelPhoto', 'Channel photo')}
        confirmLabel={i18nT('common.confirm', 'Confirm')}
        cancelLabel={i18nT('common.cancel', 'Cancel')}
        onCancel={() => setCropSource(null)}
        onConfirm={(uri) => { void handleConfirmAvatar(uri); }}
      />
    </View>
  );
}
