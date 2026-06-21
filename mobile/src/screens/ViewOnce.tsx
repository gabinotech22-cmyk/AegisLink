import { useEffect, useRef, useState } from 'react';
import { logger } from '../utils/logger';
import { View, Text, Pressable, Animated, Easing, Image, StyleSheet } from 'react-native';
import { Video, ResizeMode } from 'expo-av';
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
  const [caption, setCaption] = useState<string | null>(null);
  // Video view-once is tagged "[viewonce:video]" by the sender/receiver; fall
  // back to the cached file extension for robustness.
  const [isVideo, setIsVideo] = useState(
    !!mediaUri && /\.(mp4|mov|m4v)(\?|$)/i.test(mediaUri),
  );

  useEffect(() => {
    if (contact?.aegisId && messageId) {
      const { useMessages } = require('../store/messages');
      const messages = useMessages.getState().byChat[contact.aegisId] || [];
      const msg = messages.find((m: { id: string; body?: string }) => m.id === messageId);
      if (msg && msg.body) {
        if (msg.body.startsWith('[viewonce:video')) setIsVideo(true);
        if (msg.body.includes('\n')) {
          const parts = msg.body.split('\n');
          setCaption(parts.slice(1).join('\n'));
        }
      }
    }
  }, [contact?.aegisId, messageId]);

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
        if (__DEV__) logger.warn('[view-once] failed to physically delete file:', err);
      }
    }
  };

  // Dynamic screen capture prevention while viewing view-once media
  useEffect(() => {
    try {
      const SC = require('expo-screen-capture');
      SC.preventScreenCaptureAsync().catch(() => {});
    } catch (e) {
      if (__DEV__) logger.warn('[view-once] screen capture block failed:', e);
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

  const VIEW_MS = 30000;
  const [paused, setPaused] = useState(false);
  const [secondsLeft, setSecondsLeft] = useState(Math.round(VIEW_MS / 1000));
  const animRef = useRef<Animated.CompositeAnimation | null>(null);
  const progressValRef = useRef(0);
  const videoRef = useRef<Video>(null);

  // Run the countdown from the current progress value with the remaining time,
  // so it can be paused (hold) and resumed (release) without restarting at 0.
  const runFrom = (fromValue: number) => {
    const remaining = Math.max(0, VIEW_MS * (1 - fromValue));
    const a = Animated.timing(progress, {
      toValue: 1,
      duration: remaining,
      easing: Easing.linear,
      useNativeDriver: false,
    });
    animRef.current = a;
    a.start(({ finished }) => {
      if (finished) {
        performWipe().then(onBack);
      }
    });
  };

  useEffect(() => {
    // Video view-once is NOT auto-wiped on a fixed countdown: it loops so the
    // recipient can replay it as many times as they want while the screen stays
    // open, and it is wiped only when they leave (Close / back). Images keep the
    // 30s auto-delete countdown.
    if (!opened || isVideo) return;
    progress.setValue(0);
    progressValRef.current = 0;
    setSecondsLeft(Math.round(VIEW_MS / 1000));
    const totalSec = Math.round(VIEW_MS / 1000);
    const listenerId = progress.addListener(({ value }) => {
      progressValRef.current = value;
      // Drive the visible countdown number; only re-render when the whole
      // second changes to avoid a render per animation frame.
      const left = Math.ceil(totalSec * (1 - value));
      setSecondsLeft((prev) => (prev !== left ? left : prev));
    });
    runFrom(0);
    return () => {
      progress.removeListener(listenerId);
      animRef.current?.stop();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opened, isVideo]);

  // Hold to pause. For images this pauses the auto-delete countdown (WhatsApp
  // style); for video it pauses playback and resumes on release.
  const pauseCountdown = () => {
    if (!opened) return;
    if (isVideo) {
      setPaused(true);
      void videoRef.current?.pauseAsync().catch(() => {});
      return;
    }
    if (paused) return;
    setPaused(true);
    progress.stopAnimation((value: number) => {
      progressValRef.current = value;
    });
  };
  const resumeCountdown = () => {
    if (!opened) return;
    if (isVideo) {
      setPaused(false);
      void videoRef.current?.playAsync().catch(() => {});
      return;
    }
    if (!paused) return;
    setPaused(false);
    runFrom(progressValRef.current);
  };

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
            <I.Timer size={11} color={paused ? '#5bf2b9' : '#ff8b95'} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: paused ? '#5bf2b9' : '#ff8b95', letterSpacing: 0.5 }}>
              {paused
                ? 'EN PAUSA'
                : isVideo
                  ? 'BUCLE · SE BORRA AL CERRAR'
                  : i18nT('viewOnce.deleteTimer', { seconds: secondsLeft })}
            </Text>
          </View>
        </View>

        {/* Content: real image if available, placeholder otherwise.
            Hold anywhere on the image to pause the auto-delete countdown. */}
        <Pressable
          onPressIn={pauseCountdown}
          onPressOut={resumeCountdown}
          delayLongPress={120}
          style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}
        >
          {mediaUri && isVideo ? (
            <Video
              ref={videoRef}
              source={{ uri: mediaUri }}
              style={{ width: '100%', height: '100%' }}
              resizeMode={ResizeMode.CONTAIN}
              shouldPlay
              isLooping
              useNativeControls={false}
            />
          ) : mediaUri ? (
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
        </Pressable>

        {/* Caption Overlay */}
        {caption ? (
          <View
            style={{
              position: 'absolute',
              bottom: insets.bottom + 50,
              left: 22,
              right: 22,
              backgroundColor: 'rgba(0,0,0,0.65)',
              borderRadius: 12,
              paddingHorizontal: 16,
              paddingVertical: 10,
              zIndex: 20,
            }}
          >
            <Text style={{ color: '#fff', fontSize: 14, fontFamily: t.font, textAlign: 'center', lineHeight: 18 }}>
              {caption}
            </Text>
          </View>
        ) : null}

        {/* Progress bar footer — countdown bar only for images (video loops and
            is wiped on close, so there's no shrinking timer for it). */}
        <View style={{ paddingHorizontal: 22, paddingBottom: insets.bottom + 28 }}>
          {!isVideo && (
            <View style={{ height: 3, backgroundColor: 'rgba(255,255,255,0.12)', borderRadius: 99, overflow: 'hidden' }}>
              <Animated.View style={{ height: '100%', width, backgroundColor: '#e63946', borderRadius: 99 }} />
            </View>
          )}
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.35)', letterSpacing: 0.8, marginTop: 8, textAlign: 'center' }}>
            {i18nT('viewOnce.cannotForwardNotSaved')} · {isVideo ? 'TOCA Y MANTÉN PARA PAUSAR · BUCLE' : 'MANTÉN PULSADO PARA PAUSAR'}
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
