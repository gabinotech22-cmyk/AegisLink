import { useEffect, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Avatar } from '../components/Avatar';
import { TopBar } from '../components/TopBar';
import { Section, Row, Toggle } from '../components/Section';
import { useContacts } from '../store/contacts';

// ---------------------------------------------------------------------------
// Stub types
// ---------------------------------------------------------------------------

interface StoredContact {
  aegisId: string;
  name: string;
  color?: string;
  avatarImage?: string | null;
  verified?: boolean;
  blocked?: boolean;
  status?: string;
  zeroTrust?: boolean;
  publicKeyB64: string;
  addedAt: number;
  muted?: boolean;
  mutedUntil?: number | null;
}

interface Props {
  contact: StoredContact;
  keyChanged?: boolean;
  onBack: () => void;
  onChat: () => void;
  onCall: (media: 'audio' | 'video') => void;
  onVerify: () => void;
  onEphemeral: () => void;
}

export function ContactDetailScreen({ contact: contactProp, keyChanged = false, onBack, onChat, onCall, onVerify, onEphemeral }: Props) {
  const { t } = useTheme();
  const [fp, setFp] = useState<string[]>([]);
  const [removing, setRemoving] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Live contact state stubs
  const [muted, setMuted] = useState(contactProp.muted ?? false);
  const [zeroTrust, setZeroTrustState] = useState(contactProp.zeroTrust ?? false);
  const [blocked, setBlockedState] = useState(contactProp.blocked ?? false);

  const contact = contactProp; // stub — in real impl wire to store

  const now = Date.now();
  const effectiveMuted = muted && (contact.mutedUntil === 0 || contact.mutedUntil === null || (contact.mutedUntil ?? 0) > now);

  useEffect(() => {
    // Stub fingerprint — in real impl: fingerprintHex(decodeBase64(contact.publicKeyB64))
    const seed = contact.publicKeyB64.replace(/[^A-Za-z0-9]/g, '').slice(0, 32).padEnd(32, '0');
    const chunks: string[] = [];
    for (let i = 0; i < 8; i++) chunks.push(seed.slice(i * 4, i * 4 + 4).toUpperCase());
    setFp(chunks);
  }, [contact.publicKeyB64]);

  async function handleMute() {
    const next = !muted;
    setMuted(next);
    await useContacts.getState().muteContact(contact.aegisId, next);
  }

  async function handleBlock() {
    const next = !blocked;
    setBlockedState(next);
    await useContacts.getState().setBlocked(contact.aegisId, next);
  }

  async function handleZeroTrust(v: boolean) {
    setZeroTrustState(v);
    await useContacts.getState().setZeroTrust(contact.aegisId, v);
  }

  function handleRemove() {
    if (!window.confirm(`Remove ${contact.name}? This cannot be undone.`)) return;
    setRemoving(true);
    useContacts.getState().removeContact(contact.aegisId).then(() => {
      setRemoving(false);
      onBack();
    }).catch((e: Error) => {
      setRemoving(false);
      setErrorMsg(e.message);
    });
  }

  const isAegisId = /^[A-Z0-9]{3}-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(contact.name);
  const daysSinceAdded = Math.max(1, Math.floor((Date.now() - contact.addedAt) / 86400000));

  if (removing) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg, alignItems: 'center', justifyContent: 'center' }}>
        <span style={{ fontFamily: t.fontMono, fontSize: 13, color: t.textDim }}>Removing…</span>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar
        t={t}
        title="Contact"
        left={
          <button onClick={onBack} aria-label="Back" style={iconBtn}>
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
        right={<I.More size={20} color={t.textDim} />}
      />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 22 }}>
        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', paddingLeft: 22, paddingRight: 22, paddingTop: 14, paddingBottom: 14 }}>
          <Avatar t={t} name={contact.avatarImage ?? contact.name} color={contact.color ?? t.accent} size={88} photoUri={contact.avatarImage ?? undefined} />
          <span style={{ fontFamily: isAegisId ? t.fontMono : t.fontDisplay, fontSize: 24, fontWeight: '600', letterSpacing: -0.4, color: t.text, marginTop: 14, textAlign: 'center', display: 'block' }}>
            {contact.name}
          </span>
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.5, marginTop: 4, display: 'block' }}>
            {contact.aegisId} · added {daysSinceAdded}d ago
          </span>
          {contact.status && (
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 6, fontStyle: 'italic', textAlign: 'center', paddingLeft: 16, paddingRight: 16, display: 'block' }}>
              "{contact.status}"
            </span>
          )}

          {/* Action buttons */}
          <div style={{ display: 'flex', flexDirection: 'row', gap: 8, marginTop: 18 }}>
            <ContactAction t={t} icon={<I.Chat size={20} color={t.accent} />} label="Message" onPress={onChat} />
            <ContactAction t={t} icon={<I.Phone size={20} color={t.accent} />} label="Call" onPress={() => onCall('audio')} />
            <ContactAction t={t} icon={<I.Video size={20} color={t.accent} />} label="Video" onPress={() => onCall('video')} />
            <ContactAction t={t} icon={<I.Mute size={20} color={effectiveMuted ? t.warn : t.accent} />} label={effectiveMuted ? 'Unmute' : 'Mute'} active={effectiveMuted} onPress={handleMute} />
          </div>
        </div>

        {/* Key changed banner */}
        {keyChanged && (
          <div style={{ margin: '0 18px 18px', padding: 14, backgroundColor: t.dark ? 'rgba(255,107,107,0.08)' : 'rgba(184,68,42,0.06)', border: `1px solid ${t.danger}55`, borderRadius: t.radius, display: 'flex', flexDirection: 'row', gap: 12 }}>
            <div style={{ width: 28, height: 28, borderRadius: 14, backgroundColor: t.danger, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <span style={{ color: '#fff', fontFamily: t.font, fontWeight: '700', fontSize: 16 }}>!</span>
            </div>
            <div style={{ flex: 1 }}>
              <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 14, color: t.danger, display: 'block', marginBottom: 4 }}>Key changed</span>
              <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '17px', display: 'block', marginBottom: 10 }}>
                This contact's encryption key has changed. Verify their identity before messaging.
              </span>
              <div style={{ display: 'flex', flexDirection: 'row', gap: 8 }}>
                <button onClick={onVerify} aria-label="Re-verify" style={{ backgroundColor: t.danger, paddingLeft: 14, paddingRight: 14, paddingTop: 7, paddingBottom: 7, borderRadius: t.radiusS, border: 'none', cursor: 'pointer' }}>
                  <span style={{ color: '#fff', fontFamily: t.font, fontSize: 12, fontWeight: '600' }}>Re-verify</span>
                </button>
                <button
                  onClick={async () => {
                    await useContacts.getState().confirmKeyChange(contact.aegisId, contact.publicKeyB64);
                    onBack();
                  }}
                  aria-label="Trust anyway"
                  style={{ border: `1px solid ${t.borderStrong}`, paddingLeft: 14, paddingRight: 14, paddingTop: 7, paddingBottom: 7, borderRadius: t.radiusS, background: 'none', cursor: 'pointer' }}
                >
                  <span style={{ color: t.text, fontFamily: t.font, fontSize: 12 }}>Trust anyway</span>
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Fingerprint */}
        <Section t={t} label="PUBLIC KEY">
          <div style={{ padding: 14 }}>
            <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
              {fp.map((f, i) => (
                <div key={i} style={{ width: '23.5%', backgroundColor: t.surface2, paddingTop: 6, paddingBottom: 6, borderRadius: t.radiusS, display: 'flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box' }}>
                  <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text }}>{f}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 12 }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 10, color: keyChanged ? t.danger : contact.verified ? t.accent : t.warn, letterSpacing: 0.5 }}>
                {keyChanged ? 'KEY CHANGED' : contact.verified ? 'VERIFIED' : 'NOT VERIFIED'}
              </span>
              <button onClick={onVerify} aria-label="Verify identity" style={{ border: `1px solid ${t.borderStrong}`, paddingLeft: 10, paddingRight: 10, paddingTop: 4, paddingBottom: 4, borderRadius: t.radiusS, background: 'none', cursor: 'pointer' }}>
                <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.text, letterSpacing: 0.5 }}>VERIFY IDENTITY</span>
              </button>
            </div>
            {!contact.verified && !keyChanged && (
              <button
                onClick={async () => {
                  await useContacts.getState().markVerified(contact.aegisId, true);
                }}
                aria-label="Mark as verified"
                aria-pressed={false}
                style={{ marginTop: 10, backgroundColor: t.accent, paddingTop: 10, paddingBottom: 10, borderRadius: t.radiusS, border: 'none', cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
              >
                <span style={{ fontFamily: t.font, fontSize: 13, fontWeight: '600', color: '#000', letterSpacing: 0.3 }}>Safety words match — mark verified</span>
              </button>
            )}
          </div>
        </Section>

        <Section t={t} label="THIS CONVERSATION">
          <Row t={t} icon={<I.Timer size={18} color={t.textDim} />} label="Disappearing messages" sub="Set a timer for messages" onPress={onEphemeral} />
          <Toggle t={t} label="Zero Trust" sub={zeroTrust ? 'Blocks sending if key changes' : 'Trust on first use'} value={zeroTrust} onChange={handleZeroTrust} />
          <Row t={t} icon={<I.Bell size={18} color={t.textDim} />} label="Notifications" sub="Manage alerts for this contact" onPress={() => {}} />
          <Row t={t} icon={<I.X size={18} color={t.danger} />} label={blocked ? 'Unblock' : 'Block'} sub={blocked ? 'Unblock this contact' : 'Block messages from this contact'} danger onPress={handleBlock} />
          <Row t={t} icon={<I.Trash size={18} color={t.danger} />} label="Remove contact" danger noBorder onPress={handleRemove} />
        </Section>

        {errorMsg && (
          <div style={{ margin: '0 18px', padding: 12, backgroundColor: `${t.danger}22`, borderRadius: t.radiusS }}>
            <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.danger }}>{errorMsg}</span>
          </div>
        )}
      </div>
    </div>
  );
}

function ContactAction({ t, icon, label, active, onPress }: { t: Theme; icon: React.ReactNode; label: string; active?: boolean; onPress: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <button
      onClick={onPress}
      aria-label={label}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, background: 'none', border: 'none', cursor: 'pointer', padding: 0, minWidth: 60 }}
    >
      <div style={{ width: 48, height: 48, borderRadius: 24, backgroundColor: active ? `${t.accent}22` : hovered ? t.surface2 : t.surface, border: `1px solid ${active ? t.accent : t.border}`, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background-color 0.1s' }}>
        {icon}
      </div>
      <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim }}>{label}</span>
    </button>
  );
}

const iconBtn: CSSProperties = {
  padding: 8, background: 'none', border: 'none', cursor: 'pointer',
  display: 'flex', alignItems: 'center', justifyContent: 'center',
};
