import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, ScrollView, Modal, TextInput, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { AvatarCropModal } from '../components/AvatarCropModal';
import { ShareLinkSheet } from '../components/ShareLinkSheet';
import { encodeIdentityLink } from '../crypto/qr';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import { useIdentity } from '../store/identity';
import { usePreferences } from '../store/preferences';
import { withPickingGuard } from '../utils/pickingGuard';
import { themedAlert } from '../components/AlertHost';
import { copySensitiveText } from '../utils/secureClipboard';
import { getOrCreateDID } from '../web3/did/DIDManager';



interface Props {
  onBack: () => void;
  onDevices: () => void;
  onAppIcon: () => void;
  onKeys: () => void;
  onExport?: () => void;
  onProfileSwitcher?: () => void;
}

const PROFILE_COLORS = [
  '#05b875', // Emerald
  '#8b5cf6', // Purple
  '#3b82f6', // Blue
  '#ec4899', // Pink
  '#f97316', // Orange
  '#eab308', // Gold
  '#6366f1', // Indigo
];


export function ProfileScreen({ onBack, onDevices, onAppIcon, onKeys, onExport, onProfileSwitcher }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity, displayName, avatarColor, avatarImage, profileStatus, updateProfile, updateStatus, reset } = useIdentity();

  const [showShareLink, setShowShareLink] = useState(false);
  const [did, setDid] = useState<string | null>(null);

  // Derive the user's did:key for awareness display. Off-chain, no network,
  // cached in SecureStore. Optional — silence errors, never block the screen.
  useEffect(() => {
    const id = identity;
    if (!id?.aegisId || !id?.signingPublicKey) return;
    let active = true;
    getOrCreateDID(id.aegisId, id.signingPublicKey)
      .then((rec) => { if (active) setDid(rec.did); })
      .catch(() => { /* DID derivation is optional */ });
    return () => { active = false; };
  }, [identity]);

  const setPreference = usePreferences((s) => s.set);
  const photoVis = usePreferences((s) => s.photoVis);
  const lastSeen = usePreferences((s) => s.lastSeenVisible);
  const typing = usePreferences((s) => s.typingVisible);

  const setPhotoVis = (v: 'all' | 'contacts' | 'none') => void setPreference('photoVis', v);
  const setLastSeen = (v: boolean) => void setPreference('lastSeenVisible', v);
  const setTyping = (v: boolean) => void setPreference('typingVisible', v);


  // Profile Editor States
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(displayName);
  const [editColor, setEditColor] = useState(avatarColor);
  const [editImage, setEditImage] = useState(avatarImage);

  // Status editor
  const [isEditingStatus, setIsEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState('');



  // In-app avatar cropper: holds the freshly-picked image until the user frames
  // and confirms it. Null when the cropper is closed.
  const [cropSource, setCropSource] = useState<{ uri: string; width: number; height: number } | null>(null);

  // Synchronize state when store hydrates/updates or active identity tab changes
  useEffect(() => {
    setEditName(displayName);
    setEditColor(avatarColor);
    setEditImage(avatarImage);
  }, [displayName, avatarColor, avatarImage]);

  function handleDeleteIdentity() {
    themedAlert(
      i18nT('profile.deleteIdentityTitle'),
      i18nT('profile.deleteIdentityDesc'),
      [
        { text: i18nT('common.cancel'), style: 'cancel' },
        {
          text: i18nT('profile.deleteIdentityConfirm'),
          style: 'destructive',
          onPress: async () => {
            try {
              await reset();
            } catch (e) {
              themedAlert(i18nT('common.error'), `${(e as Error).message}`);
            }
          },
        },
      ]
    );
  }

  // NOTE: avatar cropping/resizing now lives in <AvatarCropModal> (the in-app
  // editor). The picker handlers below just hand the raw asset to that modal.

  async function handlePickImage() {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        themedAlert(i18nT('common.permissionDenied'), i18nT('profile.galleryPermission'));
        return;
      }
      // withPickingGuard impide que el AppState 'inactive' active el bloqueo de pantalla
      const result = await withPickingGuard(() =>
        ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 0.8,
        })
      );
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      // Hand off to the in-app cropper; it produces the final 256px avatar on confirm.
      setCropSource({ uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 });
    } catch (e) {
      themedAlert(i18nT('common.error'), i18nT('profile.imageLoadError', { message: (e as Error).message }));
    }
  }

  async function handleTakePhoto() {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        themedAlert(i18nT('common.permissionDenied'), i18nT('profile.cameraPermission'));
        return;
      }
      const result = await withPickingGuard(() =>
        ImagePicker.launchCameraAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 0.8,
        })
      );
      if (result.canceled || !result.assets?.length) return;
      const asset = result.assets[0];
      // Hand off to the in-app cropper; it produces the final 256px avatar on confirm.
      setCropSource({ uri: asset.uri, width: asset.width ?? 0, height: asset.height ?? 0 });
    } catch (e) {
      themedAlert(i18nT('common.error'), i18nT('profile.photoError', { message: (e as Error).message }));
    }
  }

  async function handleSaveProfile() {
    if (!editName.trim()) {
      themedAlert(i18nT('common.error'), i18nT('profile.nameEmpty'));
      return;
    }
    try {
      await updateProfile(editName.trim(), editColor, editImage);
      setIsEditing(false);
      themedAlert(i18nT('profile.profileSaved'), i18nT('profile.profileSavedDesc'));
    } catch (e) {
      themedAlert(i18nT('common.error'), i18nT('profile.saveError'));
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('profile.title')}
        big
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />

      <ScrollView contentContainerStyle={{ paddingBottom: 24 }}>
        <Pressable
          onPress={() => {
            setIsEditing(true);
          }}
          style={{
            marginHorizontal: 18,
            marginTop: 4,
            marginBottom: 18,
            padding: 18,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: t.radius,
          }}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 16 }}>
            <Avatar
              t={t}
              name={displayName}
              color={avatarColor}
              size={56}
              photoUri={avatarImage}
              seed={identity?.publicKeyB64}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text
                  numberOfLines={1}
                  style={{ fontFamily: t.fontDisplay, fontWeight: '600', fontSize: 17, color: t.text }}
                >
                  {displayName}
                </Text>
                <View style={{ padding: 3, borderRadius: 99, backgroundColor: t.surface2 }}>
                  <I.Settings size={10} color={t.accent} />
                </View>
              </View>
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 11,
                  color: avatarColor,
                  letterSpacing: 0.5,
                  marginTop: 2,
                }}
              >
                {identity?.aegisId ?? '— — —'}
              </Text>
            </View>
          </View>
        </Pressable>

        <Section t={t} label={i18nT('profile.statusSection')}>
          <Pressable
            onPress={() => {
              const cur = profileStatus;
              setStatusDraft(cur);
              setIsEditingStatus(true);
            }}
            style={{ padding: 14 }}
          >
            <View
              style={{
                paddingHorizontal: 14,
                paddingVertical: 10,
                backgroundColor: t.surface2,
                borderRadius: t.radiusS,
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Text
                style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: profileStatus ? t.text : t.textFaint }}
                numberOfLines={1}
              >
                {profileStatus || i18nT('profile.addStatus')}
              </Text>
              <I.Settings size={14} color={t.textFaint} />
            </View>
          </Pressable>
        </Section>

        {/* Status edit modal */}
        <Modal visible={isEditingStatus} transparent animationType="fade" onRequestClose={() => setIsEditingStatus(false)}>
          <Pressable
            onPress={() => setIsEditingStatus(false)}
            style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.5)', justifyContent: 'center', paddingHorizontal: 24 }}
          >
            <Pressable
              onPress={(e) => e.stopPropagation?.()}
              style={{ backgroundColor: t.surface, borderRadius: t.radius, borderWidth: 1, borderColor: t.borderStrong, padding: 20 }}
            >
              <Text style={{ fontFamily: t.font, fontWeight: '600', fontSize: 15, color: t.text, marginBottom: 14 }}>
                {i18nT('profile.editStatus')}
              </Text>
              <TextInput
                value={statusDraft}
                onChangeText={setStatusDraft}
                placeholder={i18nT('profile.statusPlaceholder')}
                placeholderTextColor={t.textFaint}
                maxLength={80}
                autoFocus
                style={{
                  backgroundColor: t.surface2,
                  color: t.text,
                  fontFamily: t.font,
                  fontSize: 14,
                  borderRadius: t.radiusS,
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  marginBottom: 6,
                }}
              />
              <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, marginBottom: 16, textAlign: 'right' }}>
                {statusDraft.length}/80
              </Text>
              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable
                  onPress={() => setIsEditingStatus(false)}
                  style={{ flex: 1, paddingVertical: 10, alignItems: 'center', borderWidth: 1, borderColor: t.borderStrong, borderRadius: t.radiusS }}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 14, color: t.textDim }}>{i18nT('common.cancel')}</Text>
                </Pressable>
                <Pressable
                  onPress={async () => {
                    await updateStatus(statusDraft.trim());
                    setIsEditingStatus(false);
                  }}
                  style={{ flex: 1, paddingVertical: 10, alignItems: 'center', backgroundColor: t.accent, borderRadius: t.radiusS }}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.accentInk }}>{i18nT('common.save')}</Text>
                </Pressable>
              </View>
            </Pressable>
          </Pressable>
        </Modal>

        {did && (
          <Section t={t} label={i18nT('profile.didSection')} hint={i18nT('profile.didHint')}>
            <Pressable
              onPress={() => { void copySensitiveText(did); themedAlert(i18nT('profile.didCopied'), did); }}
              accessibilityLabel={i18nT('profile.didCopied')}
              style={{ padding: 14 }}
            >
              <View
                style={{
                  paddingHorizontal: 14,
                  paddingVertical: 10,
                  backgroundColor: t.surface2,
                  borderRadius: t.radiusS,
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: 8,
                }}
              >
                <Text style={{ flex: 1, fontFamily: t.fontMono, fontSize: 11, color: t.textDim }} numberOfLines={2}>
                  {did}
                </Text>
                <I.Copy size={14} color={t.textFaint} />
              </View>
            </Pressable>
          </Section>
        )}

        <Section t={t} label={i18nT('profile.visibilitySection')} hint={i18nT('profile.visibilityHint')}>
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              paddingHorizontal: 16,
              paddingVertical: 12,
              borderBottomWidth: 1,
              borderBottomColor: t.divider,
              gap: 12,
            }}
          >
            <Text style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: t.text }}>{i18nT('profile.profilePhoto')}</Text>
            <PhotoVisPicker t={t} value={photoVis} onChange={setPhotoVis} />
          </View>
          <Toggle
            t={t}
            label={i18nT('profile.lastSeen')}
            sub={i18nT('profile.lastSeenSub')}
            value={lastSeen}
            onChange={setLastSeen}
          />
          <Toggle t={t} label={i18nT('profile.typingIndicator')} value={typing} onChange={setTyping} noBorder />
        </Section>

        <Section t={t} label={i18nT('profile.appearanceSection')}>
          <Row
            t={t}
            icon={<I.Image size={18} color={t.textDim} />}
            label={i18nT('profile.appIcon')}
            sub={i18nT('profile.appIconSub')}
            onPress={onAppIcon}
            noBorder
          />
        </Section>

        <Section t={t} label={i18nT('profile.accountSection')}>
          <Row t={t} icon={<I.Key size={18} color={t.textDim} />} label={i18nT('profile.identitiesAndKeys')} onPress={onKeys} />
          <Row
            t={t}
            icon={<I.Phone size={18} color={t.textDim} />}
            label={i18nT('profile.linkedDevices')}
            onPress={onDevices}
          />
          {/* Notifications live in the Privacy tab (alerts section) — removed
              here to avoid a duplicate entry. */}
          {onExport && (
            <Row
              t={t}
              icon={<I.Forward size={18} color={t.textDim} />}
              label={i18nT('dataExport.export')}
              onPress={onExport}
            />
          )}
          {onProfileSwitcher && (
            <Row
              t={t}
              icon={<I.Person size={18} color={t.textDim} />}
              label={i18nT('profile.isolatedProfiles')}
              sub={i18nT('profile.isolatedProfilesSub')}
              onPress={onProfileSwitcher}
            />
          )}
          <Row
            t={t}
            icon={<I.Plus size={18} color={t.textDim} />}
            label={i18nT('profile.createIdentity')}
            sub={i18nT('profile.createIdentitySub')}
            onPress={() => {
              themedAlert(
                i18nT('profile.createIdentityTitle'),
                i18nT('profile.createIdentityDesc'),
                [
                  { text: i18nT('common.cancel'), style: 'cancel' },
                  {
                    text: i18nT('common.add'),
                    onPress: async () => {
                      try {
                        const newSlotId = await useIdentity.getState().createSlot();
                        themedAlert(
                          i18nT('profile.identityCreated'),
                          i18nT('profile.identityCreatedDesc', { slotId: newSlotId }),
                          [
                            { text: i18nT('common.done') },
                            {
                              text: i18nT('profile.switchToNew'),
                              onPress: async () => {
                                try {
                                  await useIdentity.getState().switchSlot(newSlotId);
                                } catch (e) {
                                  themedAlert(i18nT('common.error'), (e as Error).message);
                                }
                              },
                            },
                          ]
                        );
                      } catch (e) {
                        themedAlert(i18nT('common.error'), (e as Error).message);
                      }
                    },
                  },
                ]
              );
            }}
          />
          <Row
            t={t}
            icon={<I.Forward size={18} color={t.textDim} />}
            label={i18nT('profile.shareMyId', 'Compartir mi ID')}
            sub={i18nT('profile.shareMyIdSub', 'Comparte tu contacto AegisLink')}
            onPress={() => {
              if (!identity) return;
              setShowShareLink(true);
            }}
          />
          <Row
            t={t}
            icon={<I.Trash size={18} color={t.danger} />}
            label={i18nT('profile.deleteIdentity')}
            danger
            noBorder
            onPress={handleDeleteIdentity}
          />
        </Section>
      </ScrollView>

      {/* Share my ID — in-app floating window (not the native OS sheet). */}
      <ShareLinkSheet
        visible={showShareLink}
        onClose={() => setShowShareLink(false)}
        title={i18nT('profile.shareMyId', 'Compartir mi ID')}
        link={identity ? encodeIdentityLink(identity.aegisId, identity.publicKeyB64) : ''}
      />

      {/* Edit Profile Modal */}
      <Modal visible={isEditing} transparent animationType="slide">
        <View style={styles.modalBg}>
          <ScrollView contentContainerStyle={{ flexGrow: 1, justifyContent: 'center' }}>
            <View style={[styles.modalContent, { backgroundColor: t.surface, borderColor: t.border }]}>
              <Text style={[styles.modalTitle, { color: t.text, fontFamily: t.fontDisplay }]}>
                {i18nT('profile.editProfile')}
              </Text>

              {/* Avatar Preview */}
              <View style={{ alignItems: 'center', marginBottom: 12 }}>
                <Avatar t={t} name={editName} color={editColor} size={72} photoUri={editImage} seed={identity?.publicKeyB64} />
              </View>

              {/* Photo picking buttons */}
              <View style={{ flexDirection: 'row', gap: 10, justifyContent: 'center', marginBottom: 20 }}>
                <Pressable
                  onPress={handlePickImage}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: t.radiusS,
                    backgroundColor: t.surface2,
                    borderWidth: 1,
                    borderColor: t.borderStrong,
                  }}
                >
                  <I.Plus size={14} color={t.text} />
                  <Text style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>{i18nT('common.gallery')}</Text>
                </Pressable>
                <Pressable
                  onPress={handleTakePhoto}
                  style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: 6,
                    paddingHorizontal: 12,
                    paddingVertical: 8,
                    borderRadius: t.radiusS,
                    backgroundColor: t.surface2,
                    borderWidth: 1,
                    borderColor: t.borderStrong,
                  }}
                >
                  <I.Video size={14} color={t.text} />
                  <Text style={{ fontFamily: t.font, fontSize: 12, color: t.text }}>{i18nT('common.camera')}</Text>
                </Pressable>
                {editImage && (
                  <Pressable
                    onPress={() => setEditImage(null)}
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
                    <Text style={{ fontFamily: t.font, fontSize: 12, color: t.danger }}>{i18nT('common.remove')}</Text>
                  </Pressable>
                )}
              </View>

              <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 12, marginBottom: 6 }}>
                {i18nT('profile.visibleName')}
              </Text>
              <TextInput
                placeholder={i18nT('profile.namePlaceholder')}
                placeholderTextColor={t.textDim}
                value={editName}
                onChangeText={setEditName}
                maxLength={20}
                style={{
                  color: t.text,
                  backgroundColor: t.bg,
                  borderColor: t.borderStrong,
                  borderWidth: 1,
                  borderRadius: t.radiusS,
                  padding: 12,
                  fontSize: 15,
                  marginBottom: 16,
                  fontFamily: t.font,
                }}
              />

              <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 12, marginBottom: 6 }}>
                {i18nT('profile.profileColor')}
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 16 }}>
                {PROFILE_COLORS.map((c) => {
                  const isSel = editColor === c;
                  return (
                    <Pressable
                      key={c}
                      onPress={() => setEditColor(c)}
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 16,
                        backgroundColor: c,
                        borderWidth: 2,
                        borderColor: isSel ? t.text : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {isSel && (
                        <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: '#fff' }} />
                      )}
                    </Pressable>
                  );
                })}
              </View>

              <View style={{ flexDirection: 'row', gap: 10 }}>
                <Pressable
                  onPress={handleSaveProfile}
                  style={{
                    flex: 1,
                    backgroundColor: t.accent,
                    paddingVertical: 12,
                    borderRadius: t.radiusS,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: t.accentInk, fontFamily: t.font, fontWeight: '600' }}>
                    {i18nT('common.save')}
                  </Text>
                </Pressable>
                <Pressable
                  onPress={() => {
                    setEditName(displayName);
                    setEditColor(avatarColor);
                    setEditImage(avatarImage);
                    setIsEditing(false);
                  }}
                  style={{
                    flex: 1,
                    borderWidth: 1,
                    borderColor: t.borderStrong,
                    paddingVertical: 12,
                    borderRadius: t.radiusS,
                    alignItems: 'center',
                  }}
                >
                  <Text style={{ color: t.text, fontFamily: t.font, fontWeight: '500' }}>
                    {i18nT('common.cancel')}
                  </Text>
                </Pressable>
              </View>
            </View>
          </ScrollView>
        </View>
      </Modal>

      <AvatarCropModal
        t={t}
        visible={cropSource !== null}
        imageUri={cropSource?.uri ?? null}
        imageWidth={cropSource?.width ?? 0}
        imageHeight={cropSource?.height ?? 0}
        title={i18nT('profile.adjustPhoto')}
        confirmLabel={i18nT('common.confirm')}
        cancelLabel={i18nT('common.cancel')}
        onCancel={() => setCropSource(null)}
        onConfirm={(uri) => { setEditImage(uri); setCropSource(null); }}
      />
    </View>
  );
}

function PhotoVisPicker({
  t,
  value,
  onChange,
}: {
  t: Theme;
  value: 'all' | 'contacts' | 'none';
  onChange: (v: 'all' | 'contacts' | 'none') => void;
}) {
  const { t: i18nT } = useTranslation();
  const opts = [
    { id: 'all' as const, l: i18nT('profile.all') },
    { id: 'contacts' as const, l: i18nT('profile.contacts') },
    { id: 'none' as const, l: i18nT('profile.nobody') },
  ];
  return (
    <View style={{ flexDirection: 'row', padding: 2, backgroundColor: t.surface2, borderRadius: 99 }}>
      {opts.map((o) => {
        const active = value === o.id;
        return (
          <Pressable
            key={o.id}
            onPress={() => onChange(o.id)}
            style={{
              paddingHorizontal: 10,
              paddingVertical: 5,
              backgroundColor: active ? t.accent : 'transparent',
              borderRadius: 99,
            }}
          >
            <Text
              style={{
                fontFamily: t.fontMono,
                fontSize: 10,
                letterSpacing: 0.4,
                fontWeight: active ? '600' : '400',
                color: active ? t.accentInk : t.textDim,
              }}
            >
              {o.l.toUpperCase()}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  modalBg: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: 20,
  },
  modalContent: {
    borderWidth: 1,
    borderRadius: 16,
    padding: 20,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 16,
  },
});

