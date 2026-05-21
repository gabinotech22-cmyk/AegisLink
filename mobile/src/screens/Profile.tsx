import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { View, Text, Pressable, ScrollView, Alert, Modal, TextInput, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import { useIdentity } from '../store/identity';
import { usePreferences } from '../store/preferences';
import { withPickingGuard } from '../utils/pickingGuard';

interface Props {
  onBack: () => void;
  onDevices: () => void;
  onPanic: () => void;
  onAppIcon: () => void;
  onWorkDashboard: () => void;
  onSwitchToPersonal: () => void;
  onKeys: () => void;
  onSubscription?: () => void;
  onWorkGeneration?: () => void;
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

const PROFILE_EMOJIS = [
  { label: 'Inicial', val: null },
  { label: 'Escudo', val: '🛡️' },
  { label: 'Candado', val: '🔒' },
  { label: 'Llave', val: '🔑' },
  { label: 'Rayo', val: '⚡' },
  { label: 'Búho', val: '🦉' },
  { label: 'Zorro', val: '🦊' },
  { label: 'Cubo', val: '🧊' },
  { label: 'OVNI', val: '🛸' },
  { label: 'Robot', val: '🤖' },
];

export function ProfileScreen({ onBack, onDevices, onPanic, onAppIcon, onWorkDashboard, onSwitchToPersonal, onKeys, onSubscription, onWorkGeneration }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const { identity, displayName, avatarColor, avatarImage, profileStatus, workDisplayName, workAvatarColor, workAvatarImage, workProfileStatus, updateProfile, updateStatus, activeProfile, setActiveProfile, reset, slotsList, switchSlot } = useIdentity();

  const [isSwappingSlot, setIsSwappingSlot] = useState(false);

  useEffect(() => {
    setIdentityIdState(activeProfile);
  }, [activeProfile]);

  function handleDeleteIdentity() {
    Alert.alert(
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
              Alert.alert(i18nT('common.error'), `${(e as Error).message}`);
            }
          },
        },
      ]
    );
  }
  
  const setPreference = usePreferences((s) => s.set);
  const photoVis = usePreferences((s) => s.photoVis);
  const lastSeen = usePreferences((s) => s.lastSeenVisible);
  const typing = usePreferences((s) => s.typingVisible);

  const setPhotoVis = (v: 'all' | 'contacts' | 'none') => void setPreference('photoVis', v);
  const setLastSeen = (v: boolean) => void setPreference('lastSeenVisible', v);
  const setTyping = (v: boolean) => void setPreference('typingVisible', v);

  const [identityId, setIdentityIdState] = useState<'personal' | 'work'>(activeProfile);
  const setIdentityId = (type: 'personal' | 'work') => {
    if (type === identityId) return;
    if (type === 'work') {
      if (!slotsList.includes('work')) {
        Alert.alert(
          i18nT('profile.activateWorkTitle'),
          i18nT('profile.activateWorkDesc'),
          [
            { text: i18nT('common.cancel'), style: 'cancel' },
            {
              text: i18nT('profile.activateWorkConfirm'),
              onPress: () => {
                onWorkGeneration?.();
              },
            },
          ]
        );
      } else {
        setIsSwappingSlot(true);
        setTimeout(async () => {
          try {
            await switchSlot('work');
            setIsSwappingSlot(false);
            onWorkDashboard();
          } catch (e) {
            setIsSwappingSlot(false);
            Alert.alert(i18nT('common.error'), (e as Error).message);
          }
        }, 1500);
      }
    } else {
      setIsSwappingSlot(true);
      setTimeout(async () => {
        try {
          await switchSlot('self');
          setIsSwappingSlot(false);
          onSwitchToPersonal();
        } catch (e) {
          setIsSwappingSlot(false);
          Alert.alert(i18nT('common.error'), (e as Error).message);
        }
      }, 1500);
    }
  };

  // Profile Editor States
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(displayName);
  const [editColor, setEditColor] = useState(avatarColor);
  const [editImage, setEditImage] = useState(avatarImage);

  // Status editor
  const [isEditingStatus, setIsEditingStatus] = useState(false);
  const [statusDraft, setStatusDraft] = useState('');

  // Image processing state
  const [isProcessingImage, setIsProcessingImage] = useState(false);

  // Synchronize state when store hydrates/updates or active identity tab changes
  useEffect(() => {
    if (identityId === 'personal') {
      setEditName(displayName);
      setEditColor(avatarColor);
      setEditImage(avatarImage);
    } else {
      setEditName(workDisplayName);
      setEditColor(workAvatarColor);
      setEditImage(workAvatarImage);
    }
  }, [identityId, displayName, avatarColor, avatarImage, workDisplayName, workAvatarColor, workAvatarImage]);

  /**
   * Resize + compress to 256×256 JPEG using expo-image-manipulator v14 API.
   * Falls back to the raw URI if manipulation fails so the user always gets
   * their photo rather than a frozen screen.
   */
  async function shrinkToAvatar(uri: string): Promise<string> {
    try {
      const result = await manipulateAsync(
        uri,
        [{ resize: { width: 256, height: 256 } }],
        { compress: 0.7, format: SaveFormat.JPEG }
      );
      return result.uri;
    } catch (e) {
      if (__DEV__) console.warn('[avatar] manipulateAsync failed, using raw URI:', e);
      return uri; // graceful fallback — user still gets their photo
    }
  }

  async function handlePickImage() {
    try {
      const { status } = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(i18nT('common.permissionDenied'), i18nT('profile.galleryPermission'));
        return;
      }
      // withPickingGuard impide que el AppState 'inactive' active el bloqueo de pantalla
      const result = await withPickingGuard(() =>
        ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
        })
      );
      if (result.canceled || !result.assets?.length) return;
      setIsProcessingImage(true);
      const uri = await shrinkToAvatar(result.assets[0].uri);
      setEditImage(uri);
    } catch (e) {
      Alert.alert(i18nT('common.error'), i18nT('profile.imageLoadError', { message: (e as Error).message }));
    } finally {
      setIsProcessingImage(false);
    }
  }

  async function handleTakePhoto() {
    try {
      const { status } = await ImagePicker.requestCameraPermissionsAsync();
      if (status !== 'granted') {
        Alert.alert(i18nT('common.permissionDenied'), i18nT('profile.cameraPermission'));
        return;
      }
      const result = await withPickingGuard(() =>
        ImagePicker.launchCameraAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 0.8,
        })
      );
      if (result.canceled || !result.assets?.length) return;
      setIsProcessingImage(true);
      const uri = await shrinkToAvatar(result.assets[0].uri);
      setEditImage(uri);
    } catch (e) {
      Alert.alert(i18nT('common.error'), i18nT('profile.photoError', { message: (e as Error).message }));
    } finally {
      setIsProcessingImage(false);
    }
  }

  async function handleSaveProfile() {
    if (!editName.trim()) {
      Alert.alert(i18nT('common.error'), i18nT('profile.nameEmpty'));
      return;
    }
    try {
      await updateProfile(identityId, editName.trim(), editColor, editImage);
      setIsEditing(false);
      Alert.alert(i18nT('profile.profileSaved'), i18nT('profile.profileSavedDesc'));
    } catch (e) {
      Alert.alert(i18nT('common.error'), i18nT('profile.saveError'));
    }
  }

  const ids = [
    { id: 'personal' as const, name: displayName, tag: identity?.aegisId ?? '— — —', color: avatarColor },
    { id: 'work' as const, name: workDisplayName, tag: identity?.aegisId ?? '— — —', color: workAvatarColor },
  ];

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
              name={identityId === 'personal' ? displayName : workDisplayName}
              color={identityId === 'personal' ? avatarColor : workAvatarColor}
              size={56}
              photoUri={identityId === 'personal' ? avatarImage : workAvatarImage}
            />
            <View style={{ flex: 1, minWidth: 0 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                <Text
                  numberOfLines={1}
                  style={{ fontFamily: t.fontDisplay, fontWeight: '600', fontSize: 17, color: t.text }}
                >
                  {identityId === 'personal' ? displayName : workDisplayName}
                </Text>
                <View style={{ padding: 3, borderRadius: 99, backgroundColor: t.surface2 }}>
                  <I.Settings size={10} color={t.accent} />
                </View>
              </View>
              <Text
                style={{
                  fontFamily: t.fontMono,
                  fontSize: 11,
                  color: identityId === 'personal' ? avatarColor : workAvatarColor,
                  letterSpacing: 0.5,
                  marginTop: 2,
                }}
              >
                {identity?.aegisId ?? '— — —'}
              </Text>
            </View>
          </View>
          <View
            style={{
              flexDirection: 'row',
              padding: 3,
              backgroundColor: t.surface2,
              borderRadius: t.radiusS,
            }}
          >
            {ids.map((id) => {
              const active = identityId === id.id;
              return (
                <Pressable
                  key={id.id}
                  onPress={() => setIdentityId(id.id)}
                  style={{
                    flex: 1,
                    paddingVertical: 8,
                    backgroundColor: active ? t.surface : 'transparent',
                    borderRadius: t.radiusS - 1,
                    alignItems: 'center',
                  }}
                >
                  <Text
                    style={{
                      fontFamily: t.font,
                      fontSize: 12,
                      fontWeight: active ? '600' : '400',
                      color: active ? t.text : t.textDim,
                    }}
                  >
                    {id.id === 'personal' ? i18nT('profile.personal') : i18nT('profile.work')}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              onPress={() => Alert.alert(i18nT('profile.multiIdentityAlert'), i18nT('profile.multiIdentityDesc'))}
              style={{ paddingHorizontal: 12, paddingVertical: 8 }}
            >
              <Text style={{ color: t.textFaint, fontSize: 14 }}>+</Text>
            </Pressable>
          </View>
          <Text style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, marginTop: 12, lineHeight: 16 }}>
            {i18nT('profile.separateIdentities')}
          </Text>
        </Pressable>

        <Section t={t} label={i18nT('profile.statusSection')}>
          <Pressable
            onPress={() => {
              const cur = identityId === 'personal' ? profileStatus : workProfileStatus;
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
                style={{ flex: 1, fontFamily: t.font, fontSize: 14, color: (identityId === 'personal' ? profileStatus : workProfileStatus) ? t.text : t.textFaint }}
                numberOfLines={1}
              >
                {(identityId === 'personal' ? profileStatus : workProfileStatus) || i18nT('profile.addStatus')}
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
                    await updateStatus(identityId, statusDraft.trim());
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
          <Row
            t={t}
            icon={<I.Shield size={18} color={t.accent} />}
            label={i18nT('profile.panicMode')}
            sub={i18nT('profile.panicModeSub')}
            onPress={onPanic}
          />
          {onSubscription && (
            <Row
              t={t}
              icon={<I.Zap size={18} color={t.textDim} />}
              label={i18nT('profile.anonSubscription')}
              sub={i18nT('profile.anonSubscriptionSub')}
              onPress={onSubscription}
            />
          )}
          <Row
            t={t}
            icon={<I.Plus size={18} color={t.textDim} />}
            label={i18nT('profile.createIdentity')}
            sub={i18nT('profile.createIdentitySub')}
            onPress={() => {
              Alert.alert(
                i18nT('profile.createIdentityTitle'),
                i18nT('profile.createIdentityDesc'),
                [
                  { text: i18nT('common.cancel'), style: 'cancel' },
                  {
                    text: i18nT('common.add'),
                    onPress: async () => {
                      try {
                        const newSlotId = await useIdentity.getState().createSlot();
                        Alert.alert(
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
                                  Alert.alert(i18nT('common.error'), (e as Error).message);
                                }
                              },
                            },
                          ]
                        );
                      } catch (e) {
                        Alert.alert(i18nT('common.error'), (e as Error).message);
                      }
                    },
                  },
                ]
              );
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
                <Avatar t={t} name={editName} color={editColor} size={72} photoUri={editImage} />
              </View>

              {/* Photo picking buttons */}
              {isProcessingImage ? (
                <View style={{ alignItems: 'center', paddingVertical: 18, marginBottom: 20 }}>
                  <ActivityIndicator color={t.accent} size="small" />
                  <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 8, letterSpacing: 0.5 }}>
                    {i18nT('common.processingImage')}
                  </Text>
                </View>
              ) : (
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
              )}

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

              <Text style={{ color: t.textDim, fontFamily: t.font, fontSize: 12, marginBottom: 6 }}>
                {i18nT('profile.avatarIcon')}
              </Text>
              <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: 8, paddingBottom: 6, marginBottom: 24 }}>
                {PROFILE_EMOJIS.map((e) => {
                  const isSel = editImage === e.val;
                  return (
                    <Pressable
                      key={e.label}
                      onPress={() => setEditImage(e.val)}
                      style={{
                        paddingHorizontal: 12,
                        paddingVertical: 8,
                        borderRadius: t.radiusS,
                        backgroundColor: isSel ? t.accent : t.bg,
                        borderWidth: 1,
                        borderColor: isSel ? t.accent : t.borderStrong,
                        minWidth: 50,
                        alignItems: 'center',
                      }}
                    >
                      <Text style={{ fontSize: 13, color: isSel ? t.accentInk : t.text, fontFamily: t.font }}>
                        {e.val || 'A-Z'}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

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
      {isSwappingSlot && (
        <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(0,0,0,0.85)', justifyContent: 'center', alignItems: 'center', zIndex: 9999 }]}>
          <ActivityIndicator size="large" color="#8b5cf6" />
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 16, color: '#fff', marginTop: 24, textAlign: 'center', paddingHorizontal: 40 }}>
            {i18nT('profile.securingWorkSlot')}
          </Text>
        </View>
      )}
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

