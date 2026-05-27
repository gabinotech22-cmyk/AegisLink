import { useState } from 'react';
import { View, Text, Pressable, ScrollView, Alert, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import * as ImagePicker from 'expo-image-picker';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { useMessages } from '../store/messages';
import { withPickingGuard } from '../utils/pickingGuard';

interface Props {
  onBack: () => void;
  onPick: (kind: 'scheduled' | 'location' | 'viewoncesend' | 'photo' | 'camera' | 'file' | 'voice' | 'contact') => void;
}

export function AttachSheetScreen({ onBack, onPick }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const setPendingMedia = useMessages((s) => s.setPendingMedia);
  const [picking, setPicking] = useState(false);

  /**
   * Re-encode the image to JPEG to strip EXIF (GPS, device, timestamps) and
   * bound dimensions so we never ship multi-megapixel originals. The
   * re-encode is the security boundary — even though we pass `exif:false`
   * to the picker, some Android pickers still return the original file URI
   * which retains EXIF in the file bytes. manipulateAsync writes fresh
   * JPEG bytes without the EXIF segment.
   */
  async function stripExif(uri: string): Promise<string> {
    try {
      const result = await manipulateAsync(
        uri,
        [{ resize: { width: 1280 } }],
        { compress: 0.85, format: SaveFormat.JPEG }
      );
      return result.uri;
    } catch (e) {
      if (__DEV__) console.warn('[attach] EXIF strip failed:', e);
      // Fail closed: do not return the original URI with EXIF intact.
      throw new Error(i18nT('attachSheet.errorProcessImage', 'Could not process image securely'));
    }
  }

  async function handlePhoto() {
    if (picking) return;
    try {
      const perm = await ImagePicker.requestMediaLibraryPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          i18nT('attachSheet.permissionRequired', 'Permission required'),
          i18nT('attachSheet.galleryPermission', 'Access to gallery is required.')
        );
        return;
      }
      const result = await withPickingGuard(() =>
        ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 0.85,
          allowsEditing: false,
          exif: false,
        })
      );
      if (!result.canceled && result.assets[0]) {
        setPicking(true);
        const safeUri = await stripExif(result.assets[0].uri);
        setPendingMedia(safeUri);
        onBack();
      }
    } catch (e) {
      Alert.alert(
        i18nT('common.error', 'Error'),
        `${i18nT('attachSheet.errorGallery', 'Could not open gallery')}: ${(e as Error).message}`
      );
    } finally {
      setPicking(false);
    }
  }

  async function handleCamera() {
    if (picking) return;
    try {
      const perm = await ImagePicker.requestCameraPermissionsAsync();
      if (!perm.granted) {
        Alert.alert(
          i18nT('attachSheet.permissionRequired', 'Permission required'),
          i18nT('attachSheet.cameraPermission', 'Access to camera is required.')
        );
        return;
      }
      const result = await withPickingGuard(() =>
        ImagePicker.launchCameraAsync({
          mediaTypes: ['images'] as ImagePicker.MediaType[],
          quality: 0.85,
          exif: false,
        })
      );
      if (!result.canceled && result.assets[0]) {
        setPicking(true);
        const safeUri = await stripExif(result.assets[0].uri);
        setPendingMedia(safeUri);
        onBack();
      }
    } catch (e) {
      Alert.alert(
        i18nT('common.error', 'Error'),
        `${i18nT('attachSheet.errorCamera', 'Could not access camera')}: ${(e as Error).message}`
      );
    } finally {
      setPicking(false);
    }
  }

  const opts: { id: Parameters<Props['onPick']>[0]; icon: React.ReactNode; label: string; sub: string; accent?: boolean; handler?: () => void }[] = [
    { id: 'photo', icon: <I.Eye size={22} color={t.textDim} />, label: i18nT('attachSheet.photo', 'Photo'), sub: i18nT('attachSheet.gallery', 'Gallery'), handler: handlePhoto },
    { id: 'camera', icon: <I.Video size={22} color={t.textDim} />, label: i18nT('attachSheet.camera', 'Camera'), sub: i18nT('attachSheet.exifRemoved', 'EXIF removed'), handler: handleCamera },
    { id: 'file', icon: <I.Attach size={22} color={t.textDim} />, label: i18nT('attachSheet.file', 'File'), sub: i18nT('attachSheet.anyType', 'Any type') },
    { id: 'voice', icon: <I.Mic size={22} color={t.accent} />, label: i18nT('attachSheet.audio', 'Voice note'), sub: i18nT('attachSheet.ephemeral', 'Ephemeral'), accent: true },
    { id: 'viewoncesend', icon: <I.EyeOff size={22} color={t.accent} />, label: i18nT('attachSheet.viewOnce', 'View once'), sub: i18nT('attachSheet.viewOnceSub', 'Non-savable'), accent: true },
    { id: 'scheduled', icon: <I.Timer size={22} color={t.textDim} />, label: i18nT('attachSheet.scheduled', 'Scheduled'), sub: i18nT('attachSheet.delayedSend', 'Delayed send') },
    { id: 'location', icon: <I.Globe size={22} color={t.textDim} />, label: i18nT('attachSheet.location', 'Location'), sub: i18nT('attachSheet.temporary', 'Temporary') },
    { id: 'contact', icon: <I.Users size={22} color={t.textDim} />, label: i18nT('attachSheet.contact', 'Contact'), sub: i18nT('attachSheet.shareId', 'Share ID') },
  ];

  if (picking) {
    return (
      <View style={{ flex: 1, backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <ActivityIndicator color={t.accent} size="small" />
        <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.8 }}>
          {i18nT('attachSheet.loading', 'LOADING…')}
        </Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('attachSheet.title', 'Attach')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />
      <ScrollView contentContainerStyle={{ padding: 18, paddingBottom: 22 + insets.bottom }}>
        <View
          style={{
            padding: 14,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.border,
            borderRadius: t.radius,
            marginBottom: 18,
          }}
        >
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19 }}>
            {i18nT('attachSheet.cryptoWarning', 'Everything is encrypted before leaving the device. File EXIF and metadata are automatically removed.')}
          </Text>
        </View>
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 10 }}>
          {opts.map((o) => (
            <Pressable
              key={o.id}
              onPress={o.handler ? o.handler : () => onPick(o.id)}
              style={({ pressed }) => ({
                width: '48%',
                padding: 14,
                backgroundColor: t.surface,
                borderWidth: 1,
                borderColor: o.accent ? `${t.accent}44` : t.border,
                borderRadius: t.radius,
                gap: 10,
                opacity: pressed ? 0.8 : 1,
              })}
            >
              {o.icon}
              <View>
                <Text style={{ fontFamily: t.font, fontSize: 14, fontWeight: '600', color: t.text }}>{o.label}</Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.4, marginTop: 3 }}>
                  {o.sub.toUpperCase()}
                </Text>
              </View>
            </Pressable>
          ))}
        </View>
      </ScrollView>
    </View>
  );
}

void ({} as Theme); // keep import
