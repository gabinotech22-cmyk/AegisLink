import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { AegisMark } from '../components/AegisMark';
import { KeySpinner, ProgressBar } from '../components/AegisMark';
import { I } from '../components/icons';
import { PrimaryButton, GhostButton } from '../components/Button';

// ---------------------------------------------------------------------------
// Stubs — real stores and crypto will be wired by another agent
// ---------------------------------------------------------------------------
const identity: null = null;
const status: 'idle' = 'idle';

interface Props {
  onDone: () => void;
  onRestore: () => void;
}

type Step = 'welcome' | 'generating' | 'show';

// Locale cycle for the language toggle button (no i18n dependency in renderer yet)
const LOCALES = ['EN', 'IT', 'ES'] as const;
type LocaleCode = (typeof LOCALES)[number];

export function OnboardingScreen({ onDone, onRestore }: Props) {
  const { t } = useTheme();
  const [step, setStep] = useState<Step>('welcome');
  const [localeIdx, setLocaleIdx] = useState(0);
  const locale = LOCALES[localeIdx];

  const [fingerprint] = useState<string[]>([]);
  const [did] = useState<string | null>(null);

  type RegState = 'idle' | 'registering' | 'error';
  const [regState, setRegState] = useState<RegState>('idle');
  const [regError, setRegError] = useState<string | null>(null);
  const registeredRef = useRef(false);

  function handleGenerate() {
    if (step !== 'welcome') return;
    setStep('generating');
  }

  // Auto-transition generating → show after 10 s
  useEffect(() => {
    if (step === 'generating') {
      const timer = setTimeout(() => setStep('show'), 10000);
      return () => clearTimeout(timer);
    }
  }, [step]);

  async function handleEnter() {
    if (registeredRef.current) {
      onDone();
      return;
    }
    setRegState('registering');
    setRegError(null);
    try {
      // Real registration logic will be wired by another agent.
      // For now, treat as instant success.
      registeredRef.current = true;
      setRegState('idle');
      onDone();
    } catch (e) {
      setRegState('error');
      setRegError((e as Error).message ?? 'Network error. Please retry.');
    }
  }

  const frame: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    flex: 1,
    height: '100%',
    paddingLeft: 28,
    paddingRight: 28,
    paddingTop: 44,
    paddingBottom: 20,
    backgroundColor: t.bg,
    boxSizing: 'border-box',
    overflow: 'auto',
  };

  // ── Step 0: Welcome ──────────────────────────────────────────────────────
  if (step === 'welcome') {
    return (
      <div style={frame}>
        {/* Language toggle */}
        <div style={{ position: 'absolute', top: 16, right: 24, zIndex: 10 }}>
          <button
            onClick={() => setLocaleIdx((i) => (i + 1) % LOCALES.length)}
            aria-label="Toggle language"
            style={{
              paddingLeft: 10,
              paddingRight: 10,
              paddingTop: 5,
              paddingBottom: 5,
              borderRadius: 99,
              border: `1px solid ${t.border}`,
              backgroundColor: t.surface2,
              cursor: 'pointer',
            }}
          >
            <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 0.8 }}>
              {locale === 'EN' ? 'EN | IT | ES' : locale === 'IT' ? 'IT | ES | EN' : 'ES | EN | IT'}
            </span>
          </button>
        </div>

        <div style={{ marginTop: 40, marginBottom: 28 }}>
          <AegisMark t={t} size={56} />
        </div>

        <h1
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 40,
            lineHeight: '41px',
            fontWeight: '600',
            letterSpacing: -1.2,
            color: t.text,
            marginBottom: 16,
            marginTop: 0,
          }}
        >
          Private by design.
        </h1>

        <p
          style={{
            fontFamily: t.font,
            fontSize: 16,
            lineHeight: '23px',
            color: t.textDim,
            marginTop: 0,
            marginBottom: 'auto',
            flex: 1,
          }}
        >
          Zero metadata. No phone number. No email. Your identity lives only on your device.
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24 }}>
          <PrimaryButton t={t} label="Generate my identity" onPress={handleGenerate} />
          <GhostButton t={t} label="Restore from backup" onPress={onRestore} />
        </div>

        <p
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.textFaint,
            textAlign: 'center',
            marginTop: 18,
            letterSpacing: 0.6,
          }}
        >
          No account required · Open source · E2EE
        </p>
      </div>
    );
  }

  // ── Step 1: Generating ───────────────────────────────────────────────────
  if (step === 'generating') {
    return (
      <div
        style={{
          ...frame,
          justifyContent: 'center',
          alignItems: 'center',
        }}
      >
        <KeySpinner t={t} />

        <h2
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 24,
            fontWeight: '600',
            letterSpacing: -0.48,
            color: t.text,
            marginTop: 36,
            textAlign: 'center',
          }}
        >
          Generating your keys…
        </h2>

        <p
          style={{
            fontFamily: t.fontMono,
            fontSize: 11,
            color: t.textDim,
            marginTop: 12,
            letterSpacing: 0.4,
            textAlign: 'center',
          }}
        >
          Entropy sampling · Curve25519 · Double Ratchet
        </p>

        <div style={{ marginTop: 28, width: '100%' }}>
          <ProgressBar t={t} />
        </div>

        <button
          onClick={() => setStep('show')}
          style={{
            marginTop: 32,
            background: 'none',
            border: 'none',
            cursor: 'pointer',
          }}
          aria-label="Skip animation"
        >
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 1.0 }}>
            SKIP →
          </span>
        </button>
      </div>
    );
  }

  // ── Step 2: Show identity ────────────────────────────────────────────────
  return (
    <div style={{ ...frame, paddingLeft: 24, paddingRight: 24 }}>
      <span
        style={{
          fontFamily: t.fontMono,
          fontSize: 11,
          color: t.accent,
          letterSpacing: 1.1,
          marginBottom: 14,
          display: 'block',
        }}
      >
        YOUR IDENTITY
      </span>

      <h2
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 28,
          color: t.text,
          fontWeight: '600',
          letterSpacing: -0.56,
          marginBottom: 24,
          marginTop: 0,
        }}
      >
        Identity created
      </h2>

      {/* AegisID + fingerprint card */}
      <div
        style={{
          border: `1px solid ${t.borderStrong}`,
          borderRadius: t.radius,
          padding: 20,
          marginBottom: 16,
          backgroundColor: t.surface,
        }}
      >
        <Label t={t}>AEGIS ID</Label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 22, color: t.text }}>
            {identity != null ? (identity as { aegisId: string }).aegisId : '— — —'}
          </span>
          {identity != null && (
            <button
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText((identity as { aegisId: string }).aegisId);
                } catch { /* clipboard unavailable */ }
              }}
              style={{ padding: 6, background: 'none', border: 'none', cursor: 'pointer' }}
              aria-label="Copy AegisID"
            >
              <I.Copy size={16} color={t.textDim} />
            </button>
          )}
        </div>

        <Label t={t}>FINGERPRINT</Label>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {(fingerprint.length === 0 ? Array(8).fill('····') : fingerprint).map((f, i) => (
            <div
              key={i}
              style={{
                width: 'calc(25% - 5px)',
                backgroundColor: t.surface2,
                borderRadius: t.radiusS,
                paddingTop: 6,
                paddingBottom: 6,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.text }}>{f}</span>
            </div>
          ))}
        </div>
      </div>

      {/* DID card (optional) */}
      {did !== null && (
        <div
          style={{
            border: `1px solid ${t.border}`,
            borderRadius: t.radius,
            padding: 16,
            marginBottom: 16,
            backgroundColor: t.surface,
          }}
        >
          <Label t={t}>DECENTRALIZED ID</Label>
          <span
            style={{
              fontFamily: t.fontMono,
              fontSize: 10,
              color: t.textDim,
              lineHeight: '15px',
              wordBreak: 'break-all',
              display: 'block',
              userSelect: 'text',
            }}
          >
            {did}
          </span>
          <span
            style={{
              fontFamily: t.font,
              fontSize: 11,
              color: t.textFaint,
              marginTop: 6,
              lineHeight: '16px',
              display: 'block',
            }}
          >
            Your DID is derived locally. It is never sent to any server automatically.
          </span>
        </div>
      )}

      <p
        style={{
          fontFamily: t.font,
          fontSize: 13,
          color: t.textDim,
          lineHeight: '20px',
          marginBottom: 'auto',
          flex: 1,
        }}
      >
        Your private key never leaves this device. Back up your identity phrase to restore access.
      </p>

      {/* Error banner */}
      {regState === 'error' && regError !== null && (
        <div
          style={{
            backgroundColor: '#1a0000',
            border: '1px solid #ff4444',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: '#ff6666', lineHeight: '16px' }}>
            {regError}
          </span>
        </div>
      )}

      <PrimaryButton
        t={t}
        label={
          regState === 'registering'
            ? 'Securing…'
            : regState === 'error'
            ? 'Retry'
            : 'Enter AegisLink'
        }
        onPress={handleEnter}
        disabled={regState === 'registering'}
        style={{ marginTop: 8 }}
      />
    </div>
  );
}

function Label({ t, children }: { t: Theme; children: React.ReactNode }) {
  return (
    <span
      style={{
        fontFamily: t.fontMono,
        fontSize: 10,
        color: t.textDim,
        letterSpacing: 1.0,
        marginBottom: 8,
        display: 'block',
      }}
    >
      {children}
    </span>
  );
}
