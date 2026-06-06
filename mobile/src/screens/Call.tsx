import { useEffect, useState, useCallback } from 'react';
import { View, Text, Pressable, StyleSheet, StatusBar as RNStatusBar, Alert, Modal } from 'react-native';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
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
import { acceptCall, endCall, toggleMute, toggleCamera } from '../socket/calls';
import { useProximitySensor } from '../hooks/useProximitySensor';
import { SoundFX } from '../hooks/useSoundFX';

interface Props {
  onClose: () => void;
  /** If provided, a drag-handle appears during `in-call` state that lets the
   *  user collapse the full-screen UI into the FloatingCallBar overlay. */
  onMinimize?: () => void;
}

export function CallScreen({ onClose, onMinimize }: Props) {
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
  const activePeer = useCall((s) => s.activePeer);
  const direction = useCall((s) => s.direction);

  const peer = useContacts((s) => (peerId ? s.get(peerId) : undefined));
  const peerName = peer?.name ?? peerId ?? 'unknown';
  const peerInitial = peerName.trim()[0]?.toUpperCase() ?? '?';

  // Per-second tick so the in-call duration label re-renders every second.
  // Without it, labelFor() computes Date.now()-startedAt only on unrelated
  // re-renders, leaving the timer frozen at 00:00.
  const [, setNowTick] = useState(0);
  useEffect(() => {
    if (status !== 'in-call') return;
    const id = setInterval(() => setNowTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  // Session fingerprint derived from DTLS certificate fingerprints in the SDP.
  // This is session-specific: a new fingerprint is computed per call.
  // null = not yet available (loading state); string = ready.
  const [sessionFingerprint, setSessionFingerprint] = useState<string | null>(null);

  useEffect(() => {
    if (status !== 'in-call' || !activePeer) {
      setSessionFingerprint(null);
      return;
    }
    const pc = activePeer.pc as unknown as {
      localDescription?: { sdp?: string } | null;
      remoteDescription?: { sdp?: string } | null;
    };
    const extractDTLS = (sdp: string): string | null => {
      const match = /a=fingerprint:(\S+)\s+(\S+)/i.exec(sdp);
      return match ? match[2] : null;
    };
    const localSdp = pc.localDescription?.sdp ?? '';
    const remoteSdp = pc.remoteDescription?.sdp ?? '';
    const local = extractDTLS(localSdp);
    const remote = extractDTLS(remoteSdp);
    if (!local || !remote) {
      setSessionFingerprint(null);
      return;
    }
    // Sort so both peers derive the same value regardless of caller/callee role.
    const sorted = [local, remote].sort();
    const hash = sha256(new TextEncoder().encode(sorted.join('|')));
    const hex = bytesToHex(hash);
    // Format as 8 groups of 4 chars: "A1B2 C3D4 …"
    const groups = Array.from({ length: 8 }, (_, i) => hex.slice(i * 4, i * 4 + 4).toUpperCase());
    setSessionFingerprint(groups.join(' '));
  }, [status, activePeer]);

  // Outgoing-call sound management.
  // IncomingCallScreen owns all sound for the callee side; this effect handles
  // only the caller side (outgoing-ringing → connecting → in-call → ended).
  useEffect(() => {
    if (status === 'incoming-ringing') return; // IncomingCallScreen owns this
    switch (status) {
      case 'outgoing-ringing':
        void SoundFX.callRingback(); // looping ringback until callee answers
        break;
      case 'connecting':
        void SoundFX.stopAll(); // callee answered — ringback ends
        break;
      case 'in-call':
        if (direction === 'out') {
          // Callee already played callConnected in IncomingCallScreen.handleAccept;
          // play it here only for the caller.
          void SoundFX.stopAll();
          void SoundFX.callConnected();
        }
        break;
      case 'ended':
        void SoundFX.stopAll();
        void SoundFX.callEnded();
        break;
      default:
        break;
    }
  }, [status, direction]);

  // Ensure sounds stop when the screen unmounts (e.g. navigation pop).
  useEffect(() => () => { void SoundFX.stopAll(); }, []);

  // Auto-close after a brief "ended" state.
  useEffect(() => {
    if (status === 'idle') onClose();
  }, [status, onClose]);

  const [speakerOn, setSpeakerOn] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);

  const toggleSpeaker = useCallback(async () => {
    const next = !speakerOn;
    setSpeakerOn(next);
    try {
      const { Audio } = require('expo-av') as typeof import('expo-av');
      await Audio.setAudioModeAsync({
        allowsRecordingIOS: true,
        playsInSilentModeIOS: true,
        staysActiveInBackground: true,
        shouldDuckAndroid: false,
        playThroughEarpieceAndroid: !next, // false = speaker, true = earpiece
      });
    } catch { /* no-op */ }
  }, [speakerOn]);

  const isVideo = media === 'video';
  const peerColor = peer?.color ?? t.surface2;

  const callActive = status === 'in-call' || status === 'connecting';
  useProximitySensor(!isVideo && callActive);

  // Remote video ready (in-call + stream)
  const showRemoteVideo = isVideo && !!remoteStream && status === 'in-call';
  // Local video fills background while waiting for remote (pre-connect)
  const showLocalFullscreen = isVideo && !!localStream && !cameraOff && !showRemoteVideo;

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


      {/* Minimize handle — tap to collapse into FloatingCallBar.
          Only shown during in-call (not while ringing, connecting, or ended). */}
      {status === 'in-call' && onMinimize && (
        <Pressable
          onPress={onMinimize}
          hitSlop={20}
          accessibilityRole="button"
          accessibilityLabel={i18nT('call.minimize', 'Minimize call')}
          style={{
            position: 'absolute',
            top: insets.top + 10,
            left: 0,
            right: 0,
            alignItems: 'center',
            zIndex: 10,
          }}
        >
          <View
            style={{
              width: 38,
              height: 4,
              borderRadius: 2,
              backgroundColor: 'rgba(255,255,255,0.32)',
            }}
          />
        </Pressable>
      )}

      {/* Top: peer info (left) + self-preview (right) — matches JSX design */}
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          paddingTop: insets.top + 22,
          paddingHorizontal: 22,
          zIndex: 2,
        }}
      >
        {/* Left: badge + name + timer + avatar (audio only) */}
        <View style={{ flex: 1, paddingRight: 16 }}>
          {/* Avatar: only for AUDIO calls */}
          {!isVideo && (
            <View
              style={{
                width: 80,
                height: 80,
                borderRadius: 40,
                backgroundColor: peerColor,
                alignItems: 'center',
                justifyContent: 'center',
                marginBottom: 16,
              }}
            >
              <Text style={{ fontFamily: t.fontDisplay, fontSize: 34, color: '#fff', fontWeight: '600' }}>
                {peerInitial}
              </Text>
            </View>
          )}

          {/* E2EE badge */}
          <Pressable
            onPress={() => Alert.alert(i18nT('call.alertTitle', 'End-to-End Encrypted Call'), i18nT('call.alertDesc', 'This call uses DTLS-SRTP with ephemeral CURVE25519 key exchange. No server can decrypt or intercept the audio/video stream.'))}
            accessibilityLabel="E2EE call info"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: 6,
              alignSelf: 'flex-start',
              paddingHorizontal: 10,
              paddingVertical: 4,
              backgroundColor: 'rgba(0,0,0,0.5)',
              borderRadius: 99,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.1)',
            }}
          >
            <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: t.accent }} />
            <Text style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 0.8 }}>
              {i18nT('call.badgeShort', 'E2EE · ENCRYPTED')}
            </Text>
          </Pressable>

          <Text
            style={{
              fontFamily: /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(peerName) ? t.fontMono : t.fontDisplay,
              fontSize: 26,
              color: '#fff',
              fontWeight: '600',
              letterSpacing: -0.5,
              marginTop: 12,
            }}
          >
            {peerName}
          </Text>

          <Text
            style={{
              fontFamily: t.fontMono,
              fontSize: 13,
              color: 'rgba(255,255,255,0.7)',
              marginTop: 4,
              letterSpacing: 0.5,
            }}
          >
            {labelFor(status, startedAt, i18nT)}
          </Text>
        </View>

        {/* Right: self-preview (90×130) — video only */}
        {isVideo && (
          <View
            style={{
              width: 90,
              height: 130,
              borderRadius: 10,
              overflow: 'hidden',
              backgroundColor: `${t.accent}22`,
              borderWidth: 1,
              borderColor: 'rgba(255,255,255,0.15)',
            }}
          >
            {localStream && !cameraOff && RTCView ? (
              <RTCView
                style={{ flex: 1 }}
                streamURL={(localStream as unknown as { toURL: () => string }).toURL()}
                objectFit="cover"
                mirror
              />
            ) : (
              <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.5)' }}>OFF</Text>
              </View>
            )}
            {/* "YOU" label — bottom-right */}
            <View style={{ position: 'absolute', bottom: 6, right: 7 }}>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: 'rgba(255,255,255,0.7)', letterSpacing: 0.5 }}>YOU</Text>
            </View>
          </View>
        )}
      </View>

      {/* Flip camera button for video — bottom-left overlay */}
      {(isVideo && !!localStream) ? (
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

      {/* Session fingerprint card — just above bottom controls */}
      {status === 'in-call' ? (
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
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', width: '100%' }}>
            <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1 }}>
              {i18nT('call.sessionFingerprintTitle', 'SESSION FINGERPRINT')}
            </Text>
            {sessionFingerprint ? <I.Check size={14} color={t.accent} /> : null}
          </View>
          {sessionFingerprint ? (
            <>
              <Text
                style={{ fontFamily: t.fontMono, fontSize: 13, color: '#fff', marginTop: 8, letterSpacing: 1.2, textAlign: 'center' }}
                accessibilityLabel={`Session fingerprint: ${sessionFingerprint}`}
              >
                {sessionFingerprint}
              </Text>
              <Text style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, marginTop: 6, textAlign: 'center' }}>
                {i18nT('call.fingerprintDesc', 'Compare with your contact to verify')}
              </Text>
            </>
          ) : (
            <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 8, textAlign: 'center' }}>
              {i18nT('call.fingerprintPending', 'Deriving session fingerprint…')}
            </Text>
          )}
        </View>
      ) : null}

      {/* More options bottom sheet */}
      <Modal
        transparent
        visible={moreOpen}
        animationType="slide"
        onRequestClose={() => setMoreOpen(false)}
      >
        <Pressable
          onPress={() => setMoreOpen(false)}
          style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' }}
        >
          <Pressable
            onPress={(e) => e.stopPropagation?.()}
            style={{
              backgroundColor: t.surface,
              borderTopLeftRadius: 20,
              borderTopRightRadius: 20,
              borderTopWidth: 1,
              borderColor: t.border,
              paddingTop: 12,
              paddingBottom: insets.bottom + 20,
            }}
          >
            {/* Handle */}
            <View style={{ alignItems: 'center', paddingBottom: 14 }}>
              <View style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: t.border }} />
            </View>

            {/* Option: Teclado */}
            <Pressable
              onPress={() => { setMoreOpen(false); /* keypad TODO */ }}
              accessibilityRole="button"
              accessibilityLabel={i18nT('call.keypad', 'Teclado')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 16,
                paddingHorizontal: 24, paddingVertical: 16,
                backgroundColor: pressed ? t.surface2 : 'transparent',
              })}
            >
              <Text style={{ fontSize: 18, color: t.text, letterSpacing: 3 }}>···</Text>
              <Text style={{ fontFamily: t.font, fontSize: 16, color: t.text }}>
                {i18nT('call.keypad', 'Teclado')}
              </Text>
            </Pressable>

            {/* Option: Añadir al grupo */}
            <Pressable
              onPress={() => { setMoreOpen(false); /* group add TODO */ }}
              accessibilityRole="button"
              accessibilityLabel={i18nT('call.addToGroup', 'Añadir al grupo')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 16,
                paddingHorizontal: 24, paddingVertical: 16,
                backgroundColor: pressed ? t.surface2 : 'transparent',
              })}
            >
              <I.Users size={22} color={t.text} />
              <Text style={{ fontFamily: t.font, fontSize: 16, color: t.text }}>
                {i18nT('call.addToGroup', 'Añadir al grupo')}
              </Text>
            </Pressable>

            {/* Option: Verificar huella */}
            <Pressable
              onPress={() => { setMoreOpen(false); /* show fingerprint */ }}
              accessibilityRole="button"
              accessibilityLabel={i18nT('call.verifyFingerprint', 'Verificar huella')}
              style={({ pressed }) => ({
                flexDirection: 'row', alignItems: 'center', gap: 16,
                paddingHorizontal: 24, paddingVertical: 16,
                backgroundColor: pressed ? t.surface2 : 'transparent',
              })}
            >
              <I.Shield size={22} color={t.accent} />
              <View>
                <Text style={{ fontFamily: t.font, fontSize: 16, color: t.text }}>
                  {i18nT('call.verifyFingerprint', 'Verificar huella')}
                </Text>
                <Text style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, marginTop: 2 }}>
                  {sessionFingerprint
                    ? sessionFingerprint.slice(0, 19)
                    : i18nT('call.fingerprintPending', 'Deriving session fingerprint…')}
                </Text>
              </View>
            </Pressable>
          </Pressable>
        </Pressable>
      </Modal>

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
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 4, width: '100%', paddingLeft: 24, paddingRight: 24 }}>
            {/* Mic — filled+warn+MicOff icon when muted, outlined+Mic when active */}
            <CircleBtn
              t={t}
              color={muted ? t.warn : t.surface2}
              onPress={toggleMute}
              icon="Mic"
              label={muted ? i18nT('call.unmute', 'Unmute') : i18nT('call.mute', 'Mute')}
              accessibilityLabel={muted ? i18nT('call.muteA11y', 'Muted') : i18nT('call.muteA11yOff', 'Mic on')}
              accessibilityState={{ selected: muted }}
              outlined={!muted}
              active={muted}
            />
            {/* Camera — filled+warn when off, outlined when on */}
            {isVideo && (
              <CircleBtn
                t={t}
                color={cameraOff ? t.warn : t.surface2}
                onPress={toggleCamera}
                icon="Video"
                label={cameraOff ? i18nT('call.cameraOn', 'Cam on') : i18nT('call.cameraOff', 'Cam off')}
                accessibilityLabel={cameraOff ? i18nT('call.cameraA11yOff', 'Camera off') : i18nT('call.cameraA11yOn', 'Camera on')}
                accessibilityState={{ selected: cameraOff }}
                outlined={!cameraOff}
              />
            )}
            {/* Speaker — filled+accent when on, outlined when off */}
            <CircleBtn
              t={t}
              color={speakerOn ? t.accent : t.surface2}
              onPress={() => void toggleSpeaker()}
              icon="Speaker"
              label={speakerOn ? i18nT('call.speakerOn', 'Speaker') : i18nT('call.speakerOff', 'Earpiece')}
              accessibilityLabel={speakerOn ? 'Speaker: on' : 'Speaker: off'}
              accessibilityState={{ selected: speakerOn }}
              outlined={!speakerOn}
            />
            <CircleBtn
              t={t}
              color={t.surface2}
              onPress={() => setMoreOpen(true)}
              icon="More"
              label={i18nT('call.more', 'Más')}
              outlined
            />
            <CircleBtn t={t} color={t.danger} onPress={() => endCall('hangup')} icon="Hangup" label={i18nT('call.end', 'End')} large />
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
  large = false,
  active = false,
  accessibilityLabel: a11yLabel,
  accessibilityState,
}: {
  t: Theme;
  color: string;
  onPress: () => void;
  icon: 'X' | 'Check' | 'Mic' | 'Video' | 'Hangup' | 'Speaker' | 'More';
  label: string;
  outlined?: boolean;
  large?: boolean;
  active?: boolean;
  accessibilityLabel?: string;
  accessibilityState?: { selected?: boolean; disabled?: boolean };
}) {
  const size = large ? 64 : 54;
  const r = size / 2;
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
          width: size,
          height: size,
          borderRadius: r,
          backgroundColor: outlined ? 'rgba(255,255,255,0.06)' : color,
          borderWidth: 1,
          borderColor: outlined ? 'rgba(255,255,255,0.15)' : 'transparent',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <IconGlyph name={icon} color={outlined ? '#fff' : t.bg} active={active} />
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

function IconGlyph({ name, color, active }: { name: 'X' | 'Check' | 'Mic' | 'Video' | 'Hangup' | 'Speaker' | 'More'; color: string; active?: boolean }) {
  if (name === 'More') return <I.More size={22} color={color} />;
  if (name === 'X') return <I.X size={26} color={color} />;
  if (name === 'Check') return <I.Check size={26} color={color} />;
  if (name === 'Speaker') return <I.Volume size={22} color={color} />;
  // Mic: show MicOff when active (muted state)
  if (name === 'Mic') return active ? <I.MicOff size={22} color={color} /> : <I.Mic size={22} color={color} />;
  // Video/Hangup: emoji fallback
  const ch = name === 'Video' ? '📷' : '☎';
  return (
    <Text style={{ fontSize: 22, color, transform: name === 'Hangup' ? [{ rotate: '135deg' }] : undefined }}>
      {ch}
    </Text>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
});
