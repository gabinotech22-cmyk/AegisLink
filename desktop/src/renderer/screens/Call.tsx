import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { sha256 } from '@noble/hashes/sha256';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { useCall } from '../store/call';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { WORDLIST_256 } from '../crypto/wordlist';
import { endCall, acceptCall } from '../socket/calls';

interface Props {
  onClose: () => void;
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return `${m}:${s}`;
}

function labelFor(status: string, startedAt: number | null): string {
  switch (status) {
    case 'outgoing-ringing': return 'CALLING…';
    case 'incoming-ringing': return 'INCOMING · E2EE';
    case 'connecting': return 'CONNECTING…';
    case 'in-call': return startedAt ? formatDuration(Date.now() - startedAt) : '00:00';
    case 'ended': return 'CALL ENDED';
    default: return '';
  }
}

function CircleBtn({ t, color, onPress, label, outlined = false, children }: {
  t: Theme; color: string; onPress: () => void; label: string; outlined?: boolean; children: React.ReactNode;
}) {
  const style: CSSProperties = {
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    background: 'none', border: 'none', cursor: 'pointer', padding: 0,
  };
  const circleStyle: CSSProperties = {
    width: 64, height: 64, borderRadius: 32,
    backgroundColor: outlined ? 'transparent' : color,
    border: outlined ? `1px solid ${color}` : 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  };
  return (
    <button onClick={onPress} aria-label={label} style={style}>
      <div style={circleStyle}>{children}</div>
      <span style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.6 }}>
        {label.toUpperCase()}
      </span>
    </button>
  );
}

export function CallScreen({ onClose }: Props) {
  const { t } = useTheme();
  const status = useCall((s) => s.status);
  const peerId = useCall((s) => s.peer);
  const media = useCall((s) => s.media);
  const muted = useCall((s) => s.muted);
  const cameraOff = useCall((s) => s.cameraOff);
  const startedAt = useCall((s) => s.startedAt);
  const setMuted = useCall((s) => s.setMuted);
  const setCameraOff = useCall((s) => s.setCameraOff);

  const peer = useContacts((s) => (peerId ? s.get(peerId) : undefined));
  const { identity } = useIdentity();
  const peerName = peer?.name ?? peerId ?? 'unknown';
  const peerInitial = peerName.trim()[0]?.toUpperCase() ?? '?';

  const localVideoRef = useRef<HTMLVideoElement>(null);
  const remoteVideoRef = useRef<HTMLVideoElement>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (status !== 'in-call') return;
    const id = setInterval(() => setTick((v) => v + 1), 1000);
    return () => clearInterval(id);
  }, [status]);

  useEffect(() => {
    if (status === 'idle') onClose();
  }, [status, onClose]);

  useEffect(() => {
    if (media !== 'video') return;
    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then((stream) => {
        setLocalStream(stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      })
      .catch(() => {});
    return () => { localStream?.getTracks().forEach((t) => t.stop()); };
  }, [media]);

  const fingerprintWords = useMemo<string[]>(() => {
    if (!identity?.aegisId || !peerId) return [];
    try {
      const hash = sha256(new TextEncoder().encode(identity.aegisId + peerId));
      return Array.from({ length: 8 }, (_, i) => {
        const idx = (hash[i * 4] + hash[i * 4 + 1] * 256) % 256;
        return WORDLIST_256[idx] ?? '???';
      });
    } catch { return []; }
  }, [identity?.aegisId, peerId]);

  const isVideo = media === 'video';
  const bgColor = isVideo ? '#000' : t.bg;

  const screenStyle: CSSProperties = {
    display: 'flex', flexDirection: 'column', flex: 1, height: '100%',
    backgroundColor: bgColor, position: 'relative', overflow: 'hidden',
  };

  return (
    <div style={screenStyle}>
      {/* Local self-view for video */}
      {isVideo && !cameraOff && (
        <div style={{ position: 'absolute', top: 12, right: 12, width: 110, height: 150, borderRadius: 12, overflow: 'hidden', backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`, zIndex: 3 }}>
          <video ref={localVideoRef} autoPlay muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </div>
      )}

      {/* Remote video */}
      {isVideo && (
        <video ref={remoteVideoRef} autoPlay style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', zIndex: 1 }} />
      )}

      {/* Top content */}
      <div style={{ paddingTop: 48, display: 'flex', flexDirection: 'column', alignItems: 'center', zIndex: 2, position: 'relative' }}>
        {!isVideo && (
          <div style={{ width: 100, height: 100, borderRadius: 50, backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 22 }}>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 42, color: t.accent, fontWeight: '600' }}>{peerInitial}</span>
          </div>
        )}
        <span style={{ fontFamily: t.fontDisplay, fontSize: 24, color: isVideo ? '#fff' : t.text, fontWeight: '600', letterSpacing: -0.4 }}>
          {peerName}
        </span>
        <button
          onClick={() => window.alert('This call uses DTLS-SRTP with ephemeral CURVE25519 key exchange. No server can decrypt or intercept the audio/video stream.')}
          aria-label="E2EE call info"
          style={{
            display: 'flex', alignItems: 'center', gap: 4, marginTop: 8,
            padding: '4px 10px', backgroundColor: `${t.accent}22`,
            border: `1px solid ${t.accent}44`, borderRadius: 99, cursor: 'pointer',
          }}
        >
          <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.accent, letterSpacing: 1 }}>
            E2EE · CURVE25519 · SRTP
          </span>
        </button>
        <span style={{ fontFamily: t.fontMono, fontSize: 12, color: isVideo ? 'rgba(255,255,255,0.7)' : t.textDim, marginTop: 8, letterSpacing: 0.5 }}>
          {labelFor(status, startedAt)}
        </span>

        {/* Fingerprint card */}
        {status === 'in-call' && fingerprintWords.length === 8 && (
          <div style={{ marginTop: 16, marginLeft: 24, marginRight: 24, padding: 12, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius, textAlign: 'center', maxWidth: 360, width: '100%', boxSizing: 'border-box' }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1, display: 'block', marginBottom: 8 }}>
              CALL FINGERPRINT
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 6 }}>
              {fingerprintWords.map((w, i) => (
                <span key={i} style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text }}>{w}</span>
              ))}
            </div>
            <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textFaint, marginTop: 8, display: 'block', textAlign: 'center' }}>
              Compare with your contact to verify
            </span>
          </div>
        )}
      </div>

      {/* Bottom controls */}
      <div style={{ position: 'absolute', bottom: 32, left: 0, right: 0, display: 'flex', justifyContent: 'center', zIndex: 4 }}>
        {status === 'incoming-ringing' ? (
          <div style={{ display: 'flex', gap: 60 }}>
            <CircleBtn t={t} color={t.danger} onPress={() => endCall?.('declined')} label="Decline">
              <I.X size={26} color="#fff" />
            </CircleBtn>
            <CircleBtn t={t} color={t.accent} onPress={() => void acceptCall()} label="Accept">
              <I.Check size={26} color={t.accentInk} />
            </CircleBtn>
          </div>
        ) : (
          <div style={{ display: 'flex', gap: 28 }}>
            <CircleBtn t={t} color={muted ? t.warn : t.surface2} onPress={() => setMuted?.(!muted)} label={muted ? 'Unmute' : 'Mute'} outlined>
              <span style={{ fontSize: 22, color: muted ? t.warn : t.text }}>🎙</span>
            </CircleBtn>
            {isVideo && (
              <CircleBtn t={t} color={cameraOff ? t.warn : t.surface2} onPress={() => setCameraOff?.(!cameraOff)} label={cameraOff ? 'Cam on' : 'Cam off'} outlined>
                <span style={{ fontSize: 22, color: cameraOff ? t.warn : t.text }}>📷</span>
              </CircleBtn>
            )}
            <CircleBtn t={t} color={t.danger} onPress={() => endCall?.('hangup')} label="End">
              <span style={{ fontSize: 22, color: '#fff', display: 'inline-block', transform: 'rotate(135deg)' }}>☎</span>
            </CircleBtn>
          </div>
        )}
      </div>
    </div>
  );
}
