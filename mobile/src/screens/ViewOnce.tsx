import { useEffect, useState } from 'react';
import { View, Text, Pressable, Animated, Easing, Image, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { PrimaryButton } from '../components/Button';
import type { StoredContact } from '../db/local';

interface Props {
  contact?: StoredContact;
  mediaUri?: string;
  messageId?: string;
  onBack: () => void;
}

export function ViewOnceScreen({ contact, mediaUri, messageId, onBack }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const [opened, setOpened] = useState(false);
  const [progress] = useState(new Animated.Value(0));

  const performWipe = async () => {
    if (contact?.aegisId && messageId) {
      const { useMessages } = require('../store/messages');
      await useMessages.getState().softDelete(contact.aegisId, messageId);
    }
    if (mediaUri && (mediaUri.startsWith('file://') || mediaUri.startsWith('content://'))) {
      try {
        // expo-file-system v18 (Expo SDK 54) — deleteAsync on the default export
        const FileSystem = require('expo-file-system') as typeof import('expo-file-system');
        await FileSystem.deleteAsync(mediaUri, { idempotent: true });
      } catch (err) {
        if (__DEV__) console.warn('[view-once] failed to physically delete file:', err);
      }
    }
  };

  // Dynamic screen capture prevention while viewing view-once media
  useEffect(() => {
    try {
      const SC = require('expo-screen-capture');
      SC.preventScreenCaptureAsync().catch(() => {});
    } catch (e) {
      if (__DEV__) console.warn('[view-once] screen capture block failed:', e);
    }
    return () => {
      try {
        const { usePreferences } = require('../store/preferences');
        const blockGlobal = usePreferences.getState().blockScreenshots;
        const SC = require('expo-screen-capture');
        if (!blockGlobal) {
          SC.allowScreenCaptureAsync().catch(() => {});
        }
      } catch (e) {}
    };
  }, []);

  useEffect(() => {
    if (!opened) return;
    progress.setValue(0);
    const a = Animated.timing(progress, {
      toValue: 1,
      duration: 5000,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    a.start(({ finished }) => {
      if (finished) {
        performWipe().then(onBack);
      }
    });
    return () => a.stop();
  }, [opened, progress, onBack]);

  if (opened) {
    const width = progress.interpolate({ inputRange: [0, 1], outputRange: ['100%', '0%'] });
    return (
      <View style={{ flex: 1, backgroundColor: '#000' }}>
        {/* Header overlay */}
        <View
          style={{
            position: 'absolute', top: 0, left: 0, right: 0, zIndex: 10,
            flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
            paddingHorizontal: 22, paddingTop: insets.top + 12, paddingBottom: 16,
          }}
        >
          <Pressable
            onPress={() => {
              performWipe().then(onBack);
            }}
            style={{
              backgroundColor: 'rgba(0,0,0,0.55)',
              borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)',
              paddingHorizontal: 12, paddingVertical: 6, borderRadius: 99,
            }}
          >
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: '#fff', letterSpacing: 0.5 }}>{i18nT('viewOnce.closeCaps')}</Text>
          </Pressable>
          <View
            style={{
              flexDirection: 'row', alignItems: 'center', gap: 6,
              paddingHorizontal: 12, paddingVertical: 6,
              backgroundColor: 'rgba(230,57,70,0.25)',
              borderWidth: 1, borderColor: 'rgba(230,57,70,0.5)', borderRadius: 99,
            }}
          >
            <I.Timer size={11} color="#ff8b95" />
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: '#ff8b95', letterSpacing: 0.5 }}>{i18nT('viewOnce.deleteTimer', { seconds: 5 })}</Text>
          </View>
        </View>

        {/* Content: real image if available, placeholder otherwise */}
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          {mediaUri ? (
            <Image
              source={{ uri: mediaUri }}
              style={{ width: '100%', height: '100%' }}
              resizeMode="contain"
            />
          ) : (
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: 'rgba(255,255,255,0.4)', letterSpacing: 1.1, textAlign: 'center' }}>
              [ {i18nT('viewOnce.title').toUpperCase()} ]{'\n'}
              <Text style={{ fontSize: 9 }}>{i18nT('viewOnce.noCaptureNoSaving')}</Text>
            </Text>
          )}
        </View>

        {/* Progress bar footer */}
        <View style={{ paddingHorizontal: 22, paddingBottom: insets.bottom + 28 }}>
          <View style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 99, overflow: 'hidden' }}>
            <Animated.View style={{ height: '100%', width, backgroundColor: '#e63946', borderRadius: 99 }} />
          </View>
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: 0.8, marginTop: 8, textAlign: 'center' }}>
            {i18nT('viewOnce.cannotForwardNotSaved')}
          </Text>
        </View>
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
      <TopBar
        t={t}
        title={i18nT('viewOnce.title')}
        left={
          <Pressable onPress={onBack} hitSlop={8} style={{ padding: 4 }}>
            <I.ChevronL size={22} color={t.textDim} />
          </Pressable>
        }
      />
      <View style={{ flex: 1, paddingHorizontal: 22, paddingTop: 14 }}>
        <View
          style={{
            alignSelf: 'center',
            maxWidth: 320,
            padding: 28,
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: t.borderStrong,
            borderRadius: t.radius,
            alignItems: 'center',
          }}
        >
          <View
            style={{
              width: 80,
              height: 80,
              borderRadius: 40,
              backgroundColor: t.surface2,
              borderWidth: 1,
              borderColor: t.borderStrong,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 18,
            }}
          >
            <I.EyeOff size={36} stroke={1.6} color={t.accent} />
          </View>
          <Text style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.4, color: t.text, marginBottom: 8, textAlign: 'center' }}>
            {contact?.name
              ? i18nT('viewOnce.receivedTitle', { name: contact.name })
              : i18nT('viewOnce.receivedTitleDefault')}
          </Text>
          <Text style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: 19, textAlign: 'center' }}>
            {i18nT('viewOnce.receivedDesc')}
          </Text>
        </View>
      </View>
      <View style={{ paddingHorizontal: 22, paddingBottom: 24 + insets.bottom }}>
        <PrimaryButton t={t} label={i18nT('viewOnce.viewNow')} onPress={() => setOpened(true)} />
      </View>
    </View>
  );
}

void StyleSheet; // keep import
