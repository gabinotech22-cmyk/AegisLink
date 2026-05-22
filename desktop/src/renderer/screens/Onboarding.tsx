import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '../i18n/useLocale';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { AegisMark } from '../components/AegisMark';
import { KeySpinner, ProgressBar } from '../components/AegisMark';
import { I } from '../components/icons';
import { PrimaryButton, GhostButton } from '../components/Button';
import { useIdentity } from '../store/identity';

interface Props {
  onDone: () => void;
  onRestore: () => void;
  /** Skip the welcome step and jump directly to this step. Default: 'welcome'. */
  initialStep?: 'welcome' | 'generating' | 'show';
}

type Step = 'welcome' | 'generating' | 'show';

export function OnboardingScreen({ onDone, onRestore, initialStep = 'welcome' }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const { locale, setLocale } = useLocale();
  const [step, setStep] = useState<Step>(initialStep);

  const identity = useIdentity((s) => s.identity);
  const [fingerprint] = useState<string[]>([]);
  const [did] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);

  type RegState = 'idle' | 'registering' | 'error';
  const [regState, setRegState] = useState<RegState>('idle');
  const [regError, setRegError] = useState<string | null>(null);
  const registeredRef = useRef(false);

  // Track whether we've already fired the generate call so it doesn't run twice.
  const generatingFiredRef = useRef(false);

  async function handleGenerate() {
    if (step !== 'welcome') return;
    setStep('generating');
    setGenError(null);
    const minDelay = new Promise<void>(resolve => setTimeout(resolve, 2500));
    try {
      await Promise.all([useIdentity.getState().generate(), minDelay]);
      setStep('show');
    } catch (e) {
      setGenError((e as Error).message ?? 'Key generation failed.');
      await minDelay;
      setStep('show');
    }
  }

  // When initialStep='generating' (skipped welcome via Entry), auto-fire keygen once.
  // Promise.all ensures the animation shows for at least 2.5s regardless of how fast generate() runs.
  useEffect(() => {
    if (initialStep === 'generating' && step === 'generating' && !generatingFiredRef.current) {
      generatingFiredRef.current = true;
      setGenError(null);
      const minDelay = new Promise<void>(resolve => setTimeout(resolve, 2500));
      void Promise.all([useIdentity.getState().generate(), minDelay])
        .then(() => { setStep('show'); })
        .catch((e: unknown) => {
          setGenError((e as Error).message ?? 'Key generation failed.');
          void minDelay.then(() => setStep('show'));
        });
    }
  // Only run on mount — intentional single-fire
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Safety net: if generate() never resolves in 15 s, advance anyway
  useEffect(() => {
    if (step === 'generating') {
      const timer = setTimeout(() => setStep('show'), 15000);
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
            onClick={() => {
              if (locale === 'en') {
                void setLocale('it');
              } else if (locale === 'it') {
                void setLocale('es');
              } else {
                void setLocale('en');
              }
            }}
            aria-label={i18nT('onboarding.langToggle')}
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
              {locale === 'en' ? 'EN | IT | ES' : locale === 'it' ? 'IT | ES | EN' : 'ES | EN | IT'}
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
          {i18nT('onboarding.tagline')}
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
          {i18nT('onboarding.lead')}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 24 }}>
          <PrimaryButton t={t} label={i18nT('onboarding.generateBtn')} onPress={handleGenerate} />
          <GhostButton t={t} label={i18nT('onboarding.restoreBtn')} onPress={onRestore} />
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
          {i18nT('onboarding.footer')}
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
          {i18nT('onboarding.generatingTitle')}
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
          {i18nT('onboarding.generatingSubtitle')}
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
            {i18nT('onboarding.skipAnimation')}
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
        {i18nT('onboarding.yourIdentityLabel')}
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
        {i18nT('onboarding.identityTitle')}
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
        <Label t={t}>{i18nT('onboarding.aegisIdLabel')}</Label>
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

        <Label t={t}>{i18nT('onboarding.fingerprintLabel')}</Label>
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
          <Label t={t}>{i18nT('onboarding.decentralizedIdLabel')}</Label>
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
            {i18nT('onboarding.didDescription')}
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
        {i18nT('onboarding.identityWarning')}
      </p>

      {/* Key generation error banner */}
      {genError !== null && (
        <div
          style={{
            backgroundColor: '#1a0500',
            border: '1px solid #ff8800',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: '#ffaa44', lineHeight: '16px' }}>
            Key generation warning: {genError}. Your keys may be stored without OS-level encryption.
          </span>
        </div>
      )}

      {/* Registration error banner */}
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
            ? i18nT('onboarding.securingBtn')
            : regState === 'error'
            ? i18nT('onboarding.retryBtn')
            : i18nT('onboarding.enterBtn')
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
