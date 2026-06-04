/**
 * FloatingCallBar — persistent overlay shown when the user navigates away
 * from the full-screen CallScreen while a call is active.
 *
 * Behaviour (mirrors Signal / WhatsApp / Telegram):
 *   • Slides down from above the status bar when it appears.
 *   • Shows peer name, live elapsed timer, E2EE label.
 *   • Mute toggle — highlights in warning colour when muted.
 *   • End-call button — plays callEnded tone before hanging up.
 *   • Tap anywhere else → onExpand() returns to the full CallScreen.
 *   • Respects reduce-motion: pulse animation is suppressed, entrance is instant.
 *   • Safe-area aware: never overlaps the system status bar.
 */

import { useEffect, useRef, useState } from 'react';
import { View, Text, Pressable } from 'react-native';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  withSpring,
  useReducedMotion,
} from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useTheme } from '../theme/ThemeContext';
import { useCall } from '../store/call';
import { useContacts } from '../store/contacts';
import { endCall, toggleMute } from '../socket/calls';
import { SoundFX } from '../hooks/useSoundFX';
import { I } from './icons';

interface Props {
  onExpand: () => void;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

export function FloatingCallBar({ onExpand }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion() ?? false;

  const peerId = useCall((s) => s.peer);
  const muted = useCall((s) => s.muted);
  const startedAt = useCall((s) => s.startedAt);
  const media = useCall((s) => s.media);

  const peer = useContacts((s) => (peerId ? s.get(peerId) : undefined));
  const peerName = peer?.name ?? peerId ?? '—';
  const peerColor = peer?.color ?? t.accent;

  // ── Live elapsed timer ──────────────────────────────────────────────────
  const [elapsed, setElapsed] = useState(startedAt ? Date.now() - startedAt : 0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setElapsed(startedAt ? Date.now() - startedAt : 0);
    timerRef.current = setInterval(() => {
      setElapsed(startedAt ? Date.now() - startedAt : 0);
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startedAt]);

  // ── Entrance: slide down from above the status bar ──────────────────────
  const translateY = useSharedValue(-80);
  useEffect(() => {
    if (reduceMotion) {
      translateY.value = 0;
      return;
    }
    translateY.value = withSpring(0, { damping: 20, stiffness: 200 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const slideStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  // ── Live-dot pulse ───────────────────────────────────────────────────────
  const dotOpacity = useSharedValue(1);
  useEffect(() => {
    if (reduceMotion) return;
    dotOpacity.value = withRepeat(
      withSequence(
        withTiming(0.2, { duration: 750 }),
        withTiming(1.0, { duration: 750 }),
      ),
      -1,
      false,
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);
  const dotStyle = useAnimatedStyle(() => ({ opacity: dotOpacity.value }));

  // ── Handlers ─────────────────────────────────────────────────────────────
  function handleMute(e: { stopPropagation?: () => void }): void {
    e.stopPropagation?.();
    toggleMute();
  }

  function handleEnd(e: { stopPropagation?: () => void }): void {
    e.stopPropagation?.();
    void SoundFX.callEnded();
    endCall('hangup');
  }

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        {
          position: 'absolute',
          top: insets.top + 6,
          left: 12,
          right: 12,
          zIndex: 9999,
        },
        slideStyle,
      ]}
    >
      <Pressable
        onPress={onExpand}
        accessibilityRole="button"
        accessibilityLabel={i18nT('call.tapToReturn', 'Return to call')}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          paddingLeft: 14,
          paddingRight: 8,
          paddingVertical: 10,
          backgroundColor: pressed ? t.surface2 : t.surface,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: t.borderStrong,
          gap: 10,
          // Shadow (iOS + Android)
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.28,
          shadowRadius: 12,
          elevation: 12,
        })}
      >
        {/* Live pulse dot — peer accent colour */}
        <Animated.View
          style={[
            {
              width: 9,
              height: 9,
              borderRadius: 4.5,
              backgroundColor: peerColor,
              flexShrink: 0,
            },
            dotStyle,
          ]}
        />

        {/* Peer name + elapsed + media tag */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: t.font,
              fontWeight: '600',
              fontSize: 14,
              color: t.text,
            }}
          >
            {peerName}
          </Text>
          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 11,
              color: t.accent,
              letterSpacing: 0.4,
              marginTop: 1,
            }}
          >
            {formatDuration(elapsed)}
            {media === 'video' ? '  ·  VIDEO' : '  ·  AUDIO'}
          </Text>
        </View>

        {/* Mute toggle */}
        <Pressable
          onPress={handleMute}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={
            muted
              ? i18nT('call.unmute', 'Unmute')
              : i18nT('call.mute', 'Mute')
          }
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: muted ? `${t.warn}22` : t.surface2,
            borderWidth: 1,
            borderColor: muted ? t.warn : t.border,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          {muted
            ? <I.MicOff size={16} color={t.warn} />
            : <I.Mic size={16} color={t.textDim} />
          }
        </Pressable>

        {/* End call */}
        <Pressable
          onPress={handleEnd}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={i18nT('call.end', 'End call')}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: t.danger,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <I.Phone size={16} color="#fff" />
        </Pressable>

        {/* "Return to call" chevron → */}
        <I.ChevronD
          size={16}
          color={t.textDim}
          style={{ transform: [{ rotate: '-90deg' }] }}
        />
      </Pressable>
    </Animated.View>
  );
}
