import { useEffect, useMemo } from 'react';
import { View, Text, Pressable, StyleSheet, StatusBar as RNStatusBar, Alert } from 'react-native';
import { sha256 } from '@noble/hashes/sha256';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { WEBRTC_AVAILABLE } from '../runtime';
const RTCView: React.ComponentType<{ streamURL: string; style?: object; objectFit?: string; mirror?: boolean }> | null =
  WEBRTC_AVAILABLE ? (require('react-native-webrtc') as { RTCView: React.ComponentType<{ streamURL: string; style?: object; objectFit?: string; mirror?: boolean }> }).RTCView : null;
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { useCall } from '../store/call';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { acceptCall, endCall, toggleMute, toggleCamera } from '../socket/calls';
import { WORDLIST_256 } from '../crypto/wordlist';

interface Props {
  onClose: () => void;
}

export function CallScreen({ onClose }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const insets = useSafeAreaInsets();
  const status = useCall((s) => s.status);
  const peerId = useCall((s) => s.peer);
  const media = useCall((s) => s.media);
  const localStream = useCall((s) => s.localStream);
  const remoteStream = useCall((s) => s.remoteStream);
  const muted = useCall((s) => s.muted);
  const cameraOff = useCall((s) => s.cameraOff);
  const startedAt = useCall((s) => s.startedAt);

  const peer = useContacts((s) => (peerId ? s.get(peerId) : undefined));
  const { identity } = useIdentity();
  const peerName = peer?.name ?? peerId ?? 'unknown';
  const peerInitial = peerName.trim()[0]?.toUpperCase() ?? '?';

  // Derive 8 safety words from sha256(myId + peerId)
  const fingerprintWords = useMemo<string[]>(() => {
    if (!identity?.aegisId || !peerId) return [];
    try {
      const hash = sha256(new TextEncoder().encode(identity.aegisId + peerId));
      return Array.from({ length: 8 }, (_, i) => {
        const idx = (hash[i * 4] + hash[i * 4 + 1] * 256) % 256;
        return WORDLIST_256[idx] ?? '???';
      });
    } catch {
      return [];
    }
  }, [identity?.aegisId, peerId]);

  // Auto-close after a brief "ended" state.
  useEffect(() => {
    if (status === 'idle') onClose();
  }, [status, onClose]);

  const isVideo = media === 'video';
  const peerColor = peer?.color ?? t.surface2;

  // Remote video ready (in-call + stream)
  const showRemoteVideo = isVideo && !!remoteStream && status === 'in-call';
  // Local video fills background while waiting for remote (pre-connect)
  const showLocalFullscreen = isVideo && !!localStream && !cameraOff && !showRemoteVideo;
  // Local PiP: once remote is visible
  const showLocalPiP = isVideo && !!localStream && !cameraOff && showRemoteVideo;

  return (
    <View style={[styles.screen, { backgroundColor: '#000' }]}>
      <RNStatusBar barStyle="light-content" />

      {/* ── AUDIO call: radial gradient background ── */}
      {!isVideo && (
        <View style={StyleSheet.absoluteFillObject} pointerEvents="none">
          <View style={{ position: 'absolute', top: -120, left: -100, width: 500, height: 500, borderRadius: 9999, backgroundColor: peerColor, opacity: 0.33 }} />
          <View style={{ position: 'absolute', bottom: -80, right: -80, width: 400, height: 400, borderRadius: 9999, backgroundColor: t.accent, opacity: 0.13 }} />
        </View>
      )}

      {/* ── VIDEO: local camera fills screen while connecting ── */}
      {showLocalFullscreen && RTCView && (
        <RTCView
          style={StyleSheet.absoluteFillObject}
          streamURL={(localStream as unknown as { toURL: () => string }).toURL()}
          objectFit="cover"
          mirror
        />
      )}

      {/* ── VIDEO: remote camera fills screen when in-call ── */}
      {showRemoteVideo && RTCView && (
        <RTCView
          style={StyleSheet.absoluteFillObject}
          streamURL={(remoteStream as unknown as { toURL: () => string }).toURL()}
          objectFit="cover"
        />
      )}

      {/* ── VIDEO: local PiP (top-right) once remote is visible ── */}
      {showLocalPiP && (
        <View
          style={{
            position: 'absolute',
            top: insets.top + 12,
            right: 12,
            width: 110,
            height: 150,
            borderRadius: 12,
            overflow: 'hidden',
            backgroundColor: t.surface,
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.2)',
            zIndex: 10,
          }}
        >
          {RTCView && (
            <RTCView
              style={StyleSheet.absoluteFillObject}
              streamURL={(localStream as unknown as { toURL: () => string }).toURL()}
              objectFit="cover"
              mirror
            />
          )}
        </View>
      )}

      {/* ── VIDEO cameraOff: show avatar placeholder in PiP area ── */}
      {isVideo && cameraOff && (
        <View
          style={{
            position: 'absolute',
            top: insets.top + 12,
            right: 12,
            width: 110,
            height: 150,
            borderRadius: 12,
            backgroundColor: t.surface2,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: 'rgba(255,255,255,0.1)',
            zIndex: 10,
          }}
        >
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 0.6 }}>CAMERA OFF</Text>
        </View>
      )}

      {/* Top: peer name + status */}
      <View style={{ paddingTop: insets.top + 32, alignItems: 'center', zIndex: 2 }}>
        {/* Avatar: only for AUDIO calls */}
        {!isVideo && (
          <View
            style={{
              width: 100,
              height: 100,
              borderRadius: 50,
              backgroundColor: peerColor,
              alignItems: 'center',
              justifyContent: 'center',
              marginBottom: 22,
            }}
          >
            <Text style={{ fontFamily: t.fontDisplay, fontSize: 42, color: '#fff', fontWeight: '600' }}>
              {peerInitial}
            </Text>
          </View>
        )}
        <Text
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 24,
            color: isVideo ? '#fff' : t.text,
            fontWeight: '600',
            letterSpacing: -0.4,
          }}
        >
          {peerName}
        </Text>

        {/* E2EE badge */}
        <Pressable
          onPress={() => Alert.alert(i18nT('call.alertTitle', 'End-to-End Encrypted Call'), i18nT('call.alertDesc', 'This call uses DTLS-SRTP with ephemeral CURVE25519 key exchange. No server can decrypt or intercept the audio/video stream.'))}
          accessibilityLabel="E2EE call info"
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: 4,
            marginTop: 8,
            paddingHorizontal: 10,
            paddingVertical: 4,
            backgroundColor: `${t.accent}22`,
            borderRadius: 99,
            borderWidth: 1,
            borderColor: `${t.accent}44`,
          }}
        >
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 1 }}>
            {i18nT('call.badgeText', '🔒 E2EE · CURVE25519 · SRTP')}
          </Text>
        </Pressable>

        <Text
          style={{
            fontFamily: t.fontMono,
            fontSize: 12,
            color: isVideo ? 'rgba(255,255,255,0.7)' : t.textDim,
            marginTop: 8,
            letterSpacing: 0.5,
          }}
        >
          {labelFor(status, startedAt, i18nT)}
        </Text>

      </View>

      {/* Flip camera button for video — bottom-left overlay */}
      {(showLocalFullscreen || showLocalPiP) ? (
        <Pressable
          onPress={() => {
            try {
              const track = (localStream as unknown as { getVideoTracks(): Array<{ _switchCamera?: () => void }> }).getVideoTracks()[0];
              track._switchCamera?.();
            } catch { /* not available */ }
          }}
          accessibilityLabel="Flip camera"
          style={{
            position: 'absolute',
            top: insets.top + 12,
            left: 12,
            width: 44,
            height: 44,
            borderRadius: 22,
            backgroundColor: 'rgba(0,0,0,0.45)',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 5,
          }}
        >
          <I.FlipCamera size={22} color="#fff" />
        </Pressable>
      ) : null}

      {/* Fingerprint card — just above bottom controls */}
      {status === 'in-call' && fingerprintWords.length >= 4 ? (
        <View
          style={{
            position: 'absolute',
            bottom: insets.bottom + 120,
            left: 24,
            right: 24,
            padding: 12,
            backgroundColor: isVideo ? 'rgba(0,0,0,0.55)' : t.surface,
            borderWidth: 1,
            borderColor: isVideo ? 'rgba(255,255,255,0.1)' : t.border,
            borderRadius: t.radius,
            alignItems: 'center',
            zIndex: 3,
          }}
        >
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1, marginBottom: 4 }}>
            {i18nT('call.fingerprintTitle', 'CALL FINGERPRINT')}
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 16, color: '#fff', marginTop: 4, letterSpacing: 0.4 }}>
            {fingerprintWords.slice(0, 4).join(' · ')}
          </Text>
          <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, marginTop: 6, textAlign: 'center' }}>
            {i18nT('call.fingerprintDesc', 'Compare with your contact to verify')}
          </Text>
        </View>
      ) : null}

      {/* Bottom controls */}
      <View
        style={{
          position: 'absolute',
          bottom: insets.bottom + 24,
          left: 0,
          right: 0,
          alignItems: 'center',
          zIndex: 4,
        }}
      >
        {status === 'incoming-ringing' ? (
          <View style={{ flexDirection: 'row', gap: 60, justifyContent: 'center' }}>
            <CircleBtn t={t} color={t.danger} onPress={() => endCall('declined')} icon="X" label={i18nT('incomingCall.decline', 'Decline')} />
            <CircleBtn t={t} color={t.accent} onPress={() => void acceptCall()} icon="Check" label={i18nT('incomingCall.accept', 'Accept')} />
          </View>
        ) : (
          <View style={{ flexDirection: 'row', gap: 28, justifyContent: 'center' }}>
            <CircleBtn
              t={t}
              color={muted ? t.warn : t.surface2}
              onPress={toggleMute}
              icon="Mic"
              label={muted ? i18nT('call.unmute', 'Unmute') : i18nT('call.mute', 'Mute')}
              accessibilityLabel={muted ? i18nT('call.muteA11y', 'Mute: active') : i18nT('call.muteA11yOff', 'Mute: inactive')}
              accessibilityState={{ selected: muted }}
              outlined
            />
            {isVideo && (
              <CircleBtn
                t={t}
                color={cameraOff ? t.warn : t.surface2}
                onPress={toggleCamera}
                icon="Video"
                label={cameraOff ? i18nT('call.cameraOn', 'Camera on') : i18nT('call.cameraOff', 'Camera off')}
                accessibilityLabel={cameraOff ? i18nT('call.cameraA11yOff', 'Camera: off') : i18nT('call.cameraA11yOn', 'Camera: on')}
                accessibilityState={{ selected: cameraOff }}
                outlined
              />
            )}
            <CircleBtn t={t} color={t.danger} onPress={() => endCall('hangup')} icon="Hangup" label={i18nT('call.end', 'End')} />
          </View>
        )}
      </View>
    </View>
  );
}

function labelFor(status: string, startedAt: number | null, i18nT: any): string {
  switch (status) {
    case 'outgoing-ringing':
      return i18nT('call.calling', 'CALLING…');
    case 'incoming-ringing':
      return i18nT('incomingCall.incoming', 'INCOMING · E2EE');
    case 'connecting':
      return i18nT('call.connecting', 'CONNECTING…');
    case 'in-call':
      return startedAt ? formatDuration(Date.now() - startedAt) : '00:00';
    case 'ended':
      return i18nT('call.ended', 'CALL ENDED');
    default:
      return '';
  }
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function CircleBtn({
  t,
  color,
  onPress,
  icon,
  label,
  outlined = false,
  accessibilityLabel: a11yLabel,
  accessibilityState,
}: {
  t: Theme;
  color: string;
  onPress: () => void;
  icon: 'X' | 'Check' | 'Mic' | 'Video' | 'Hangup';
  label: string;
  outlined?: boolean;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={a11yLabel ?? label}
      accessibilityState={accessibilityState}
      style={({ pressed }) => ({
        alignItems: 'center',
        opacity: pressed ? 0.7 : 1,
      })}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 32,
          backgroundColor: outlined ? 'transparent' : color,
          borderWidth: outlined ? 1 : 0,
          borderColor: color,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <IconGlyph name={icon} color={outlined ? color : t.bg} />
      </View>
      <Text
        style={{
          fontFamily: t.fontMono,
          fontSize: 10,
          color: t.textDim,
          marginTop: 6,
          letterSpacing: 0.6,
        }}
      >
        {label.toUpperCase()}
      </Text>
    </Pressable>
  );
}

function IconGlyph({ name, color }: { name: 'X' | 'Check' | 'Mic' | 'Video' | 'Hangup'; color: string }) {
  // Inline tiny glyphs avoiding wider Icon imports.
  if (name === 'X') return <I.X size={26} color={color} />;
  if (name === 'Check') return <I.Check size={26} color={color} />;
  // Use simple text glyphs for mic/video/hangup to avoid expanding the icon set further.
  const ch = name === 'Mic' ? '🎙' : name === 'Video' ? '📷' : '☎';
  return (
    <Text style={{ fontSize: 22, color, transform: name === 'Hangup' ? [{ rotate: '135deg' }] : undefined }}>
      {ch}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
