/**
 * FloatingGroupCallBar — shown when the user is in a group call but has
 * navigated away from the GroupChatScreen (minimized=true in the store).
 * Mirrors FloatingCallBar but surfaces group-specific info: participant
 * count instead of a single peer name.
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
import { useGroupCall } from '../store/groupCall';
import { hangupGroupCall, toggleGroupCallMute } from '../socket/groupCalls';
import { I } from './icons';

interface Props {
  onExpand: () => void;
}

function formatElapsed(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, '0');
  const sec = (s % 60).toString().padStart(2, '0');
  return `${m}:${sec}`;
}

export function FloatingGroupCallBar({ onExpand }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion() ?? false;

  const groupName = useGroupCall((s) => s.groupName);
  const participants = useGroupCall((s) => s.participants);
  const muted = useGroupCall((s) => s.muted);
  const startedAt = useGroupCall((s) => s.startedAt);

  const [elapsed, setElapsed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!startedAt) return;
    setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [startedAt]);

  // Slide down entrance
  const translateY = useSharedValue(-80);
  useEffect(() => {
    translateY.value = reduceMotion ? 0 : withSpring(0, { damping: 20, stiffness: 200 });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const slideStyle = useAnimatedStyle(() => ({ transform: [{ translateY: translateY.value }] }));

  // Pulsing dot
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

  const connectedCount = participants.filter((p) => p.connected).length;
  const totalCount = participants.length;

  function handleMute(e: { stopPropagation?: () => void }) {
    e.stopPropagation?.();
    toggleGroupCallMute();
  }

  function handleHangup(e: { stopPropagation?: () => void }) {
    e.stopPropagation?.();
    hangupGroupCall();
  }

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
        accessibilityLabel={i18nT('groupCall.tapToExpand', 'Volver a la llamada grupal')}
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
          shadowColor: '#000',
          shadowOffset: { width: 0, height: 4 },
          shadowOpacity: 0.28,
          shadowRadius: 12,
          elevation: 12,
        })}
      >
        {/* Live pulse dot */}
        <Animated.View
          style={[
            { width: 9, height: 9, borderRadius: 4.5, backgroundColor: t.accent, flexShrink: 0 },
            dotStyle,
          ]}
        />

        {/* Group name + participant count + timer */}
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text numberOfLines={1} style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.text }}>
            {groupName ?? i18nT('groupCall.groupCall', 'Llamada grupal')}
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 0.4, marginTop: 1 }}>
            {formatElapsed(elapsed)}
            {'  ·  '}
            {i18nT('groupCall.participantCountShort', { count: connectedCount || totalCount, defaultValue: '{{count}} en llamada' })}
          </Text>
        </View>

        {/* Mute toggle */}
        <Pressable
          onPress={handleMute}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={muted ? i18nT('call.unmute', 'Reanudar') : i18nT('call.mute', 'Silenciar')}
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
          {muted ? <I.MicOff size={16} color={t.warn} /> : <I.Mic size={16} color={t.textDim} />}
        </Pressable>

        {/* Hangup */}
        <Pressable
          onPress={handleHangup}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel={i18nT('call.hangup', 'Colgar')}
          style={{
            width: 36,
            height: 36,
            borderRadius: 18,
            backgroundColor: t.danger,
            alignItems: 'center',
            justifyContent: 'center',
            transform: [{ rotate: '135deg' }],
          }}
        >
          <I.Phone size={16} color="#fff" />
        </Pressable>

        <I.ChevronD size={16} color={t.textDim} style={{ transform: [{ rotate: '-90deg' }] }} />
      </Pressable>
    </Animated.View>
  );
}
