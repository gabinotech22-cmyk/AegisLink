import { useEffect } from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withRepeat,
  withSequence,
  withTiming,
  useReducedMotion,
  Easing,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { useGroupCall } from '../store/groupCall';
import { useContacts } from '../store/contacts';
import { SoundFX } from '../hooks/useSoundFX';

interface Props {
  onAccept: () => void;
  onReject: () => void;
}

/**
 * Full-screen incoming group call ringing UI. Matches the style of
 * IncomingCallScreen but shows group name + participant count.
 */
export function IncomingGroupCallScreen({ onAccept, onReject }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion() ?? false;

  const groupName = useGroupCall((s) => s.groupName);
  const initiator = useGroupCall((s) => s.initiator);
  const contacts = useContacts((s) => s.contacts);

  const initiatorContact = contacts.find((c) => c.aegisId === initiator);
  const initiatorName = initiatorContact?.name ?? initiator?.substring(0, 8) ?? '?';
  const initiatorColor = initiatorContact?.color ?? t.accent;
  const initial = initiatorName.trim()[0]?.toUpperCase() ?? '?';

  // Pulsing badge opacity
  const pulseOpacity = useSharedValue(1);
  // Pulsing ring scale
  const ringScale = useSharedValue(1);

  useEffect(() => {
    if (reduceMotion) return;

    pulseOpacity.value = withRepeat(
      withSequence(
        withTiming(0.5, { duration: 1500, easing: Easing.inOut(Easing.ease) }),
        withTiming(1, { duration: 0 }),
      ),
      -1,
      false,
    );

    ringScale.value = withRepeat(
      withSequence(
        withTiming(1.15, { duration: 600 }),
        withTiming(1, { duration: 600 }),
      ),
      -1,
      false,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reduceMotion]);

  // Ring sound
  useEffect(() => {
    void SoundFX.callIncoming();
    return () => { void SoundFX.stopAll(); };
  }, []);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
  }));

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale.value }],
  }));

  function handleAccept() {
    void SoundFX.callConnected();
    onAccept();
  }

  function handleReject() {
    void SoundFX.callEnded();
    onReject();
  }

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      {/* Background glow */}
      <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
        <View
          style={{
            position: 'absolute',
            top: -150,
            left: -150,
            right: -150,
            height: 500,
            borderRadius: 9999,
            backgroundColor: initiatorColor,
            opacity: 0.22,
          }}
        />
        <View
          style={{
            position: 'absolute',
            bottom: -100,
            left: -100,
            right: -100,
            height: 400,
            borderRadius: 9999,
            backgroundColor: t.accent,
            opacity: 0.08,
          }}
        />
      </View>

      <View style={styles.body}>
        {/* E2EE badge */}
        <View style={styles.encryptedBadge}>
          <Animated.View style={[styles.badgeDot, { backgroundColor: t.accent }, pulseStyle]} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.1 }}>
            {i18nT('incomingCall.e2eeCall', 'E2EE CALL · ENCRYPTED').toUpperCase()}
          </Text>
        </View>

        {/* Group icon ring */}
        <Animated.View style={[styles.ring, { borderColor: t.accent }, ringStyle]}>
          <View style={[styles.ringInner, { backgroundColor: initiatorColor }]}>
            <I.Users size={40} color="#fff" />
          </View>
        </Animated.View>

        {/* Group name */}
        <Text style={[styles.groupName, { fontFamily: t.font, color: '#fff' }]} numberOfLines={1}>
          {groupName ?? i18nT('groupCall.groupCall', 'Group Call')}
        </Text>

        {/* Caller info */}
        <Text style={[styles.callerLabel, { fontFamily: t.fontMono, color: 'rgba(255,255,255,0.6)' }]}>
          {i18nT('groupCall.callerLabel', 'Iniciado por')} {initiatorName}
        </Text>

        <Text style={[styles.mediaLabel, { fontFamily: t.fontMono, color: 'rgba(255,255,255,0.5)' }]}>
          {'AUDIO · E2EE MESH · CURVE25519 · SRTP'}
        </Text>
      </View>

      {/* Action buttons */}
      <View style={[styles.actions, { paddingBottom: insets.bottom + 36 }]}>
        <ActionBtn
          t={t}
          color={t.danger}
          label={i18nT('incomingCall.decline', 'DECLINE').toUpperCase()}
          onPress={handleReject}
          icon={<I.Phone size={28} color="#fff" />}
          rotate
        />
        <ActionBtn
          t={t}
          color={t.accent}
          label={i18nT('incomingCall.accept', 'ACCEPT').toUpperCase()}
          onPress={handleAccept}
          icon={<I.Phone size={28} color="#000" />}
        />
      </View>
    </View>
  );
}

// ---------------------------------------------------------------------------
// Action button (same style as IncomingCallScreen)
// ---------------------------------------------------------------------------

function ActionBtn({
  t,
  color,
  icon,
  label,
  onPress,
  rotate,
}: {
  t: Theme;
  color: string;
  icon: React.ReactNode;
  label: string;
  onPress: () => void;
  rotate?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({ alignItems: 'center', gap: 8, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 70,
          height: 70,
          borderRadius: 35,
          backgroundColor: color,
          alignItems: 'center',
          justifyContent: 'center',
          transform: rotate ? [{ rotate: '135deg' }] : undefined,
        }}
      >
        {icon}
      </View>
      <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5 }}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },
  body: { flex: 1, alignItems: 'center', paddingHorizontal: 28, paddingTop: 40 },
  encryptedBadge: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 6,
    backgroundColor: 'rgba(0,0,0,0.4)',
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.1)',
    borderRadius: 99,
    marginBottom: 28,
  },
  badgeDot: { width: 7, height: 7, borderRadius: 3.5 },
  ring: {
    width: 148,
    height: 148,
    borderRadius: 74,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
  },
  ringInner: {
    width: 132,
    height: 132,
    borderRadius: 66,
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupName: { fontSize: 26, fontWeight: '600', letterSpacing: -0.5, textAlign: 'center', marginBottom: 6 },
  callerLabel: { fontSize: 12, letterSpacing: 0.5, marginBottom: 4 },
  mediaLabel: { fontSize: 11, letterSpacing: 0.5, marginTop: 6 },
  actions: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'center',
    paddingHorizontal: 40,
    maxWidth: 360,
    alignSelf: 'center',
    width: '100%',
  },
});
