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
import { Identicon } from '../components/Identicon';
import { useIdentity } from '../store/identity';
import { fingerprintHex } from '../crypto/fingerprint';

interface Props {
  onDone: () => void;
  onRestore: () => void;
  /** Skip the welcome step and jump directly to this step. Default: 'welcome'. */
  initialStep?: 'welcome' | 'generating' | 'show';
}

type Step = 'welcome' | 'generating' | 'show' | 'nickname';

const AVATAR_COLOR_SWATCHES = ['#05b875', '#3b82f6', '#8b5cf6', '#ec4899', '#f97316', '#eab308'];

export function OnboardingScreen({ onDone, onRestore, initialStep = 'welcome' }: Props) {
  const { t } = useTheme();
  const { t: i18nT } = useTranslation();
  const { locale, setLocale } = useLocale();
  const [step, setStep] = useState<Step>(initialStep);

  const identity = useIdentity((s) => s.identity);
  const storeAvatarColor = useIdentity((s) => s.avatarColor);
  const updateProfile = useIdentity((s) => s.updateProfile);
  const [fingerprint, setFingerprint] = useState<string[]>([]);
  const [did] = useState<string | null>(null);
  const [genError, setGenError] = useState<string | null>(null);
  const [nickname, setNickname] = useState('');
  const [selectedColor, setSelectedColor] = useState<string>(
    AVATAR_COLOR_SWATCHES.includes(storeAvatarColor) ? storeAvatarColor : AVATAR_COLOR_SWATCHES[0],
  );

  // Default display name mirrors the identity store's own fallback derivation
  // (aegisId lowercased, dashes stripped) so the placeholder and helper text
  // always agree with what will actually be persisted if the user skips.
  const defaultName = identity != null ? (identity as { aegisId: string }).aegisId.toLowerCase().replace(/-/g, '') : '';

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

  // Compute the real public-key fingerprint once we reach the identity screen
  // (mobile parity — previously the card always rendered placeholder dots).
  useEffect(() => {
    if (step === 'show' && identity != null) {
      setFingerprint(fingerprintHex((identity as { publicKey: Uint8Array }).publicKey));
    }
  }, [step, identity]);

  async function handleEnter() {
    if (registeredRef.current) {
      onDone();
      return;
    }
    setRegState('registering');
    setRegError(null);
    try {
      // Registration (PoW + prekey upload) already ran inside generate() ->
      // publishToServer(); entering is just the gate into the app.
      registeredRef.current = true;
      setRegState('idle');
      onDone();
    } catch (e) {
      setRegState('error');
      setRegError((e as Error).message ?? 'Network error. Please retry.');
    }
  }

  async function handleContinueFromNickname() {
    const trimmed = nickname.trim();
    const colorChanged = selectedColor !== storeAvatarColor;
    // Only persist if the user actually changed something — otherwise generate()'s
    // defaults already hold and we avoid a redundant write + profile broadcast.
    if (trimmed || colorChanged) {
      try {
        await updateProfile(trimmed || defaultName, selectedColor, null);
      } catch {
        /* non-fatal: profile is optional, proceed into the app */
      }
    }
    await handleEnter();
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

  // ── Step 3: Nickname + avatar (optional) ─────────────────────────────────
  if (step === 'nickname') {
    return (
      <div style={{ ...frame, paddingLeft: 24, paddingRight: 24 }}>
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 18 }}>
          <AegisMark t={t} size={28} />
          <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.accent, letterSpacing: 1.1 }}>
            {i18nT('onboarding.almostDone')}
          </span>
        </div>

        <h2 style={{ fontFamily: t.fontDisplay, fontSize: 28, color: t.text, fontWeight: '600', letterSpacing: -0.56, marginTop: 0, marginBottom: 10 }}>
          {i18nT('onboarding.nicknameTitle')}
        </h2>
        <p style={{ fontFamily: t.font, fontSize: 14, color: t.textDim, lineHeight: '20px', marginTop: 0, marginBottom: 24 }}>
          {i18nT('onboarding.nicknameSubtitle')}
        </p>

        {/* Avatar preview — the identicon is derived from the public key and
            tinted with the selected swatch (mobile parity). */}
        <div style={{ display: 'flex', justifyContent: 'center', marginBottom: 16 }}>
          <div style={{ width: 64, height: 64, borderRadius: '50%', backgroundColor: t.surface2, display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' }}>
            {identity != null && (
              <Identicon seed={(identity as { publicKeyB64: string }).publicKeyB64} color={selectedColor} size={64} rounded />
            )}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'row', justifyContent: 'center', gap: 12, marginBottom: 24 }}>
          {AVATAR_COLOR_SWATCHES.map((c) => {
            const selected = c === selectedColor;
            return (
              <button
                key={c}
                onClick={() => setSelectedColor(c)}
                aria-label={i18nT('onboarding.colorSwatchLabel', { color: c })}
                style={{ width: 30, height: 30, borderRadius: 15, backgroundColor: c, border: selected ? `2px solid ${t.accent}` : '2px solid transparent', cursor: 'pointer' }}
              />
            );
          })}
        </div>

        <Label t={t}>{i18nT('onboarding.nicknameLabel')}</Label>
        <input
          value={nickname}
          onChange={(e) => setNickname(e.target.value)}
          placeholder={defaultName}
          maxLength={20}
          autoCapitalize="none"
          autoCorrect="off"
          style={{ color: t.text, backgroundColor: t.surface, border: `1px solid ${t.borderStrong}`, borderRadius: t.radiusS, padding: 12, fontSize: 15, marginBottom: 8, fontFamily: t.font, width: '100%', boxSizing: 'border-box', outline: 'none' }}
        />
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textFaint, letterSpacing: 0.4, marginBottom: 'auto', display: 'block', flex: 1 }}>
          {i18nT('onboarding.nicknameDefault', { name: defaultName })}
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <PrimaryButton t={t} label={i18nT('onboarding.continueBtn')} onPress={handleContinueFromNickname} />
          <GhostButton t={t} label={i18nT('onboarding.skipNickname')} onPress={handleEnter} />
        </div>
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
        label={i18nT('onboarding.continueBtn')}
        onPress={() => setStep('nickname')}
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
