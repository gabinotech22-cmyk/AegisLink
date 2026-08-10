/**
 * CreateProfile — Section 11, desktop.
 *
 * Three steps: generate an identity, name it, pick a colour. Port of the mobile
 * wizard, rewritten for the web renderer.
 *
 * The identity is minted once, up front, and the SAME object is handed to
 * createProfile() at the end. Regenerating on confirm would persist an AegisID
 * different from the one whose identicon the user just approved — and the
 * identicon is the only thing a person can eyeball to tell two anonymous
 * profiles apart.
 */
import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Avatar } from '../components/Avatar';
import { createIdentity, type Identity } from '../crypto/identity';
import { useProfiles, AVATAR_PALETTE } from '../store/profiles';

interface Props {
  onBack: () => void;
  onCreated: () => void;
}

type Step = 'generating' | 'name' | 'color';

const MAX_NAME_LEN = 32;

export function CreateProfileScreen({ onBack, onCreated }: Props) {
  const { t } = useTheme();
  const createProfile = useProfiles((s) => s.createProfile);
  const switchProfile = useProfiles((s) => s.switchProfile);

  const [step, setStep] = useState<Step>('generating');
  const [aegisId, setAegisId] = useState('');
  const [publicKeyB64, setPublicKeyB64] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [avatarColor, setAvatarColor] = useState(AVATAR_PALETTE[0]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const identityRef = useRef<Identity | null>(null);

  useEffect(() => {
    // createIdentity is synchronous and fast; the short beat is deliberate so
    // the step reads as something happening rather than a flash.
    const timer = setTimeout(() => {
      try {
        const id = createIdentity();
        identityRef.current = id;
        setAegisId(id.aegisId);
        setPublicKeyB64(id.publicKeyB64);
        setDisplayName(id.aegisId.slice(0, 8).toLowerCase().replace(/-/g, ''));
        setStep('name');
      } catch (e) {
        // Without an identity there is no profile to create. Say so instead of
        // leaving a spinner turning forever.
        setError(e instanceof Error ? e.message : String(e));
      }
    }, 900);
    return () => clearTimeout(timer);
  }, []);

  async function handleConfirm() {
    if (busy || !identityRef.current) return;
    setBusy(true);
    setError(null);
    try {
      const profile = await createProfile(
        displayName.trim() || aegisId.slice(0, 8).toLowerCase(),
        avatarColor,
        identityRef.current
      );
      await switchProfile(profile.slotId);
      onCreated();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const panel: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 10,
    padding: '40px 32px',
    textAlign: 'center',
  };

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: '100%',
        backgroundColor: t.bg,
      }}
    >
      <TopBar
        t={t}
        title="New profile"
        left={
          <button
            onClick={onBack}
            aria-label="Go back"
            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
          >
            <I.ChevronL size={22} color={t.textDim} />
          </button>
        }
      />

      {error && (
        <div
          role="alert"
          style={{
            margin: '10px 18px 0',
            padding: '10px 12px',
            borderRadius: t.radiusS,
            backgroundColor: t.surface,
            border: `1px solid ${t.danger}`,
            fontFamily: t.font,
            fontSize: 13,
            color: t.danger,
          }}
        >
          {error}
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {step === 'generating' && (
          <div style={panel}>
            <I.Loader size={34} color={t.accent} />
            <div style={{ fontFamily: t.font, fontSize: 17, fontWeight: 600, color: t.text }}>
              Generating identity
            </div>
            <div style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, maxWidth: 420 }}>
              A fresh keypair, created on this computer. The private key never leaves it.
            </div>
          </div>
        )}

        {step !== 'generating' && (
          <div style={panel}>
            <Avatar t={t} name={displayName || aegisId} color={avatarColor} size={84} seed={publicKeyB64} />
            <div
              style={{
                fontFamily: t.fontMono,
                fontSize: 13,
                color: t.textDim,
                letterSpacing: 1,
                marginTop: 4,
              }}
            >
              {aegisId}
            </div>
          </div>
        )}

        {step === 'name' && (
          <div style={{ padding: '0 32px 32px', maxWidth: 460, margin: '0 auto' }}>
            <div
              style={{
                fontFamily: t.font,
                fontSize: 17,
                fontWeight: 600,
                color: t.text,
                textAlign: 'center',
              }}
            >
              Choose a name
            </div>
            <div
              style={{
                fontFamily: t.font,
                fontSize: 13,
                color: t.textDim,
                textAlign: 'center',
                marginTop: 6,
                marginBottom: 18,
              }}
            >
              Only you see it. It is stored on this computer and never sent to the relay.
            </div>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value.slice(0, MAX_NAME_LEN))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && displayName.trim()) setStep('color');
              }}
              aria-label="Profile name"
              autoFocus
              placeholder="work, travel, spare…"
              style={{
                width: '100%',
                padding: '12px 14px',
                borderRadius: t.radiusS,
                backgroundColor: t.surface,
                border: `1px solid ${t.border}`,
                color: t.text,
                fontFamily: t.font,
                fontSize: 15,
                boxSizing: 'border-box',
              }}
            />
            <button
              onClick={() => setStep('color')}
              disabled={!displayName.trim()}
              aria-label="Continue to colour"
              style={{
                width: '100%',
                marginTop: 16,
                padding: '13px 0',
                borderRadius: t.radiusS,
                border: 'none',
                backgroundColor: displayName.trim() ? t.accent : t.surface2,
                color: displayName.trim() ? t.accentInk : t.textFaint,
                fontFamily: t.font,
                fontSize: 15,
                fontWeight: 600,
                cursor: displayName.trim() ? 'pointer' : 'default',
              }}
            >
              Continue
            </button>
          </div>
        )}

        {step === 'color' && (
          <div style={{ padding: '0 32px 32px', maxWidth: 460, margin: '0 auto' }}>
            <div
              style={{
                fontFamily: t.font,
                fontSize: 17,
                fontWeight: 600,
                color: t.text,
                textAlign: 'center',
              }}
            >
              Pick a colour
            </div>
            <div
              style={{
                fontFamily: t.font,
                fontSize: 13,
                color: t.textDim,
                textAlign: 'center',
                marginTop: 6,
                marginBottom: 18,
              }}
            >
              So you can tell this profile apart at a glance.
            </div>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 12,
                justifyContent: 'center',
              }}
            >
              {AVATAR_PALETTE.map((c) => (
                <button
                  key={c}
                  onClick={() => setAvatarColor(c)}
                  aria-label={`Use colour ${c}`}
                  aria-pressed={avatarColor === c}
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: c,
                    border: avatarColor === c ? `3px solid ${t.text}` : `1px solid ${t.border}`,
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                  }}
                />
              ))}
            </div>
            <button
              onClick={() => void handleConfirm()}
              disabled={busy}
              aria-label="Create this profile"
              style={{
                width: '100%',
                marginTop: 24,
                padding: '13px 0',
                borderRadius: t.radiusS,
                border: 'none',
                backgroundColor: busy ? t.surface2 : t.accent,
                color: busy ? t.textFaint : t.accentInk,
                fontFamily: t.font,
                fontSize: 15,
                fontWeight: 600,
                cursor: busy ? 'default' : 'pointer',
              }}
            >
              {busy ? 'Creating…' : 'Create profile'}
            </button>
            <div
              style={{
                fontFamily: t.fontMono,
                fontSize: 10,
                color: t.textFaint,
                letterSpacing: 0.8,
                textAlign: 'center',
                marginTop: 14,
              }}
            >
              ITS OWN KEYS, ITS OWN DATABASE FILE, SEPARATE FROM YOUR OTHER PROFILES
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
