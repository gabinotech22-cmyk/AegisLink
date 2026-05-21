import { useState } from 'react';
import type { CSSProperties } from 'react';
import { decodeBase64 } from 'tweetnacl-util';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { useCall } from '../store/call';
import { useContacts } from '../store/contacts';
import { useIdentity } from '../store/identity';
import { sendMessage } from '../socket/client';

interface Props {
  onAccept: () => void;
  onReject: () => void;
}

const QUICK_REPLIES = [
  'Cannot talk now',
  'Call you in 5 minutes',
  'What do you need?',
  'I am in a meeting',
  'Write to me instead',
];

function ActionBtn({ t, color, icon, label, onPress, small, rotate }: {
  t: Theme; color: string; icon: React.ReactNode; label: string;
  onPress?: () => void; small?: boolean; rotate?: boolean;
}) {
  const circleStyle: CSSProperties = {
    width: small ? 50 : 70, height: small ? 50 : 70,
    borderRadius: small ? 25 : 35,
    backgroundColor: color,
    border: small ? '1px solid rgba(255,255,255,0.15)' : 'none',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    transform: rotate ? 'rotate(135deg)' : undefined,
  };
  return (
    <button
      onClick={onPress}
      aria-label={label}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
    >
      <div style={circleStyle}>{icon}</div>
      <span style={{ fontFamily: t.fontMono, fontSize: small ? 9 : 10, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5 }}>
        {label}
      </span>
    </button>
  );
}

export function IncomingCallScreen({ onAccept, onReject }: Props) {
  const { t } = useTheme();
  const peerId = useCall((s) => s.peer);
  const media = useCall((s) => s.media);
  const peer = useContacts((s) => (peerId ? s.get(peerId) : undefined));
  const name = peer?.name ?? peerId ?? 'unknown';
  const initial = name.trim()[0]?.toUpperCase() ?? '?';
  const { identity } = useIdentity();
  const [showReplies, setShowReplies] = useState(false);

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
      } catch { /* offline */ }
    }
    onReject();
  }

  const isMonoId = /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(name);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: '#000', position: 'relative' }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '40px 28px 0' }}>
        {/* E2EE badge */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 14px', backgroundColor: 'rgba(0,0,0,0.4)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 99 }}>
          <div style={{ width: 7, height: 7, borderRadius: 3.5, backgroundColor: t.accent }} />
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.accent, letterSpacing: 1.1 }}>
            E2EE CALL · ENCRYPTED
          </span>
        </div>

        {/* Avatar with CSS pulse animation */}
        <style>{`@keyframes aegis-ring-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.12)}}`}</style>
        <div style={{ width: 148, height: 148, borderRadius: 74, border: `2px solid ${t.accent}`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginTop: 28, marginBottom: 16, animation: 'aegis-ring-pulse 1.2s ease-in-out infinite' }}>
          <div style={{ width: 132, height: 132, borderRadius: 66, backgroundColor: '#8b5cf6', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <span style={{ color: '#fff', fontFamily: isMonoId ? t.fontMono : t.font, fontWeight: '600', fontSize: 48, letterSpacing: -0.6 }}>
              {initial}
            </span>
          </div>
        </div>

        <span style={{ fontFamily: isMonoId ? t.fontMono : t.fontDisplay, fontSize: 28, color: '#fff', fontWeight: '600', letterSpacing: -0.5 }}>
          {name}
        </span>
        <span style={{ fontFamily: t.fontMono, fontSize: 12, color: 'rgba(255,255,255,0.6)', letterSpacing: 0.5, marginTop: 6 }}>
          {(media === 'video' ? 'VIDEO' : 'AUDIO')} · CURVE25519 · SRTP
        </span>

        {peer?.verified && (
          <div style={{ marginTop: 18, padding: '8px 14px', backgroundColor: 'rgba(255,255,255,0.06)', borderRadius: t.radius, display: 'flex', alignItems: 'center', gap: 6 }}>
            <I.Check size={11} color={t.accent} />
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: 'rgba(255,255,255,0.7)', letterSpacing: 0.4 }}>Verified identity</span>
          </div>
        )}
      </div>

      {/* Action buttons */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0 40px 48px', maxWidth: 360, margin: '0 auto', width: '100%', boxSizing: 'border-box' }}>
        <ActionBtn t={t} color="#e63946" label="DECLINE" onPress={onReject} rotate
          icon={<I.Phone size={28} color="#fff" />}
        />
        <ActionBtn t={t} color="rgba(255,255,255,0.08)" label="REPLY" small onPress={() => setShowReplies(true)}
          icon={<I.Chat size={20} color="#fff" />}
        />
        <ActionBtn t={t} color={t.accent} label="ACCEPT" onPress={onAccept}
          icon={<I.Phone size={28} color={t.accentInk} />}
        />
      </div>

      {/* Quick replies overlay */}
      {showReplies && (
        <div
          onClick={() => setShowReplies(false)}
          style={{ position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', zIndex: 100 }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{ backgroundColor: '#1a1a1a', borderTop: '1px solid rgba(255,255,255,0.1)', borderRadius: '18px 18px 0 0', paddingTop: 12, paddingBottom: 24 }}
          >
            <div style={{ display: 'flex', justifyContent: 'center', paddingBottom: 12 }}>
              <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.2)' }} />
            </div>
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: 'rgba(255,255,255,0.4)', letterSpacing: 0.8, padding: '0 22px 8px', display: 'block' }}>
              REPLY AND REJECT
            </span>
            {QUICK_REPLIES.map((reply) => (
              <button
                key={reply}
                onClick={() => void handleQuickReply(reply)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '16px 22px', fontFamily: t.font, fontSize: 15, color: '#fff',
                  background: 'none', border: 'none', borderTop: '1px solid rgba(255,255,255,0.07)',
                  cursor: 'pointer',
                }}
              >
                {reply}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
