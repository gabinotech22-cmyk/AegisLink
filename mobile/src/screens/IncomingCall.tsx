import { useEffect, useState } from 'react';
import { View, Text, Pressable, Modal, ScrollView } from 'react-native';
import { decodeBase64 } from 'tweetnacl-util';
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
import { useCall } from '../store/call';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { sendMessage } from '../socket/client';
import { SoundFX } from '../hooks/useSoundFX';

interface Props {
  onAccept: () => void;
  onReject: () => void;
}

/**
 * Full-screen incoming call ringing UI. Matches `ScreenIncoming` from the
 * prototype: pulsing avatar, encrypted badge, three action buttons.
 * Animations run on the UI thread via Reanimated 3 worklets.
 */
export function IncomingCallScreen({ onAccept, onReject }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const peerId = useCall((s) => s.peer);
  const media = useCall((s) => s.media);
  const peer = useContacts((s) => (peerId ? s.get(peerId) : undefined));
  const name = peer?.name ?? peerId ?? 'unknown';
  const initial = name.trim()[0]?.toUpperCase() ?? '?';

  const { identity } = useIdentity();
  const [showReplies, setShowReplies] = useState(false);
  const reduceMotion = useReducedMotion() ?? false;

  // pulse: opacity 1 → 0.5 → 1 on repeat (badge dot)
  const pulseOpacity = useSharedValue(1);
  // ringScale: scale 1 → 1.15 → 1 on repeat (avatar ring)
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

  // Start ringing when the screen mounts; stop on unmount regardless of outcome
  useEffect(() => {
    void SoundFX.callIncoming();
    return () => {
      void SoundFX.stopAll();
    };
  }, []);

  const pulseStyle = useAnimatedStyle(() => ({
    opacity: pulseOpacity.value,
  }));

  const ringStyle = useAnimatedStyle(() => ({
    transform: [{ scale: ringScale.value }],
  }));

  const quickReplies = [
    i18nT('incomingCall.quickReply1', 'Cannot talk now'),
    i18nT('incomingCall.quickReply2', 'Call you in 5 minutes'),
    i18nT('incomingCall.quickReply3', 'What do you need?'),
    i18nT('incomingCall.quickReply4', 'I am in a meeting'),
    i18nT('incomingCall.quickReply5', 'Write to me instead'),
  ];

  function handleAccept() {
    void SoundFX.callConnected();
    onAccept();
  }

  function handleReject() {
    void SoundFX.callEnded();
    onReject();
  }

  async function handleQuickReply(text: string) {
    setShowReplies(false);
    if (identity && peer) {
      try {
        await sendMessage({
          identity,
          recipientAegisId: peer.aegisId,
          recipientPublicKey: decodeBase64(peer.publicKeyB64),
          plaintext: text,
        });
      } catch { /* socket offline — queued */ }
    }
    handleReject();
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000', paddingTop: insets.top }}>
      <View style={{ flex: 1, alignItems: 'center', paddingHorizontal: 28, paddingTop: 40 }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            paddingHorizontal: 14,
            paddingVertical: 6,
            backgroundColor: 'rgba(0,0,0,0.4)',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.1)',
            borderRadius: 99,
          }}
        >
          <Animated.View style={[{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.accent }, pulseStyle]} />
          <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.1 }}>
            {i18nT('incomingCall.e2eeCall', 'E2EE CALL · ENCRYPTED').toUpperCase()}
          </Text>
        </View>

        <Animated.View
          style={[
            {
              width: 148,
              height: 148,
              borderRadius: 74,
              borderWidth: 2,
              borderColor: t.accent,
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 28,
              marginBottom: 16,
            },
            ringStyle,
          ]}
        >
          <View
            style={{
              width: 132,
              height: 132,
              borderRadius: 66,
              backgroundColor: '#8b5cf6',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Text style={{ color: '#fff', fontFamily: t.font, fontWeight: '600', fontSize: 48, letterSpacing: -0.6 }}>
              {initial}
            </Text>
          </View>
        </Animated.View>

        <Text
          style={{
            fontFamily: /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(name) ? t.fontMono : t.fontDisplay,
            fontSize: 28,
            color: '#fff',
            fontWeight: '600',
            letterSpacing: -0.5,
          }}
        >
          {name}
        </Text>
        <Text style={{ fontFamily: t.fontMono, fontSize: 12, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5, marginTop: 6 }}>
          {media === 'video' ? i18nT('call.video', 'VIDEO').toUpperCase() : i18nT('call.audio', 'AUDIO').toUpperCase()} · CURVE25519 · SRTP
        </Text>

        {peer?.verified ? (
          <View
            style={{
              marginTop: 18,
              paddingHorizontal: 14,
              paddingVertical: 8,
              backgroundColor: 'rgba(255,255,255,0.06)',
              borderRadius: t.radius,
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <I.Check size={11} color={t.accent} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: 'rgba(255,255,255,0.7)', letterSpacing: 0.4 }}>
              {i18nT('incomingCall.verified', 'Verified identity')}
            </Text>
          </View>
        ) : null}
      </View>

      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          paddingHorizontal: 40,
          paddingBottom: insets.bottom + 36,
          maxWidth: 360,
          alignSelf: 'center',
          width: '100%',
        }}
      >
        <ActionBtn t={t} color="#e63946" label={i18nT('incomingCall.decline', 'DECLINE').toUpperCase()} onPress={handleReject} icon={<I.Phone size={28} color="#fff" />} rotate />
        <ActionBtn t={t} color="rgba(255,255,255,0.08)" label={i18nT('incomingCall.reply', 'REPLY').toUpperCase()} small icon={<I.Chat size={20} color="#fff" />} onPress={() => setShowReplies(true)} />
        <ActionBtn t={t} color={t.accent} label={i18nT('incomingCall.accept', 'ACCEPT').toUpperCase()} onPress={handleAccept} icon={<I.Phone size={28} color={t.accentInk} />} />
      </View>
      <Modal transparent visible={showReplies} animationType="slide" onRequestClose={() => setShowReplies(false)}>
        <Pressable
          onPress={() => setShowReplies(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation?.()}
            style={{
              backgroundColor: '#1a1a1a',
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              borderTopWidth: 1,
              borderColor: 'rgba(255,255,255,0.1)',
              paddingTop: 12,
              paddingBottom: insets.bottom + 16,
            }}
          >
            <View style={{ alignItems: 'center', paddingBottom: 12 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' }} />
            </View>
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.8, paddingHorizontal: 22, paddingBottom: 8 }}>
              {i18nT('incomingCall.replyAndReject', 'REPLY AND REJECT').toUpperCase()}
            </Text>
            <ScrollView>
              {quickReplies.map((reply) => (
                <Pressable
                  key={reply}
                  onPress={() => void handleQuickReply(reply)}
                  style={({ pressed }) => ({
                    paddingHorizontal: 22,
                    paddingVertical: 16,
                    borderTopWidth: 1,
                    borderTopColor: 'rgba(255,255,255,0.07)',
                    backgroundColor: pressed ? 'rgba(255,255,255,0.05)' : 'transparent',
                  })}
                >
                  <Text style={{ fontFamily: t.font, fontSize: 15, color: '#fff' }}>{reply}</Text>
                </Pressable>
              ))}
            </ScrollView>
          </Pressable>
        </Pressable>
      </Modal>
    </View>
  );
}

function ActionBtn({
  t,
  color,
  icon,
  label,
  onPress,
  small,
  rotate,
}: {
  t: Theme;
  color: string;
  icon: React.ReactNode;
  label: string;
  onPress?: () => void;
  small?: boolean;
  rotate?: boolean;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={({ pressed }) => ({
        alignItems: 'center',
        gap: 8,
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: small ? 50 : 70,
          height: small ? 50 : 70,
          borderRadius: small ? 25 : 35,
          backgroundColor: color,
          borderWidth: small ? 1 : 0,
          borderColor: 'rgba(255,255,255,0.15)',
          alignItems: 'center',
          justifyContent: 'center',
          transform: rotate ? [{ rotate: '135deg' }] : undefined,
        }}
      >
        {icon}
      </View>
      <Text style={{ fontFamily: t.fontMono, fontSize: small ? 9 : 10, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5 }}>
        {label}
      </Text>
    </Pressable>
  );
}
