import { useState, useCallback } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { Section, Row, Toggle } from '../components/Section';

interface Props {
  onBack: () => void;
}

type PinStep =
  | { kind: 'create-new' }
  | { kind: 'confirm-new'; prev: string }
  | { kind: 'verify-current' };

const TIMEOUT_OPTIONS: { label: string; value: number }[] = [
  { label: 'Immediately', value: 0 },
  { label: '1 minute', value: 1 },
  { label: '5 minutes', value: 5 },
  { label: '15 minutes', value: 15 },
  { label: '1 hour', value: 60 },
];

function PinDots({ count, error, t }: { count: number; error: boolean; t: Theme }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 18, justifyContent: 'center', marginTop: 28, marginBottom: 28 }}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            width: 16, height: 16, borderRadius: 8,
            backgroundColor: i < count ? (error ? '#ef4444' : t.accent) : 'transparent',
            border: `2px solid ${i < count ? (error ? '#ef4444' : t.accent) : t.borderStrong}`,
            boxSizing: 'border-box',
          }}
        />
      ))}
    </div>
  );
}

function Numpad({ onDigit, onDelete, t }: { onDigit: (d: string) => void; onDelete: () => void; t: Theme }) {
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  return (
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', width: 252, alignSelf: 'center' }}>
      {keys.map((k, i) => {
        if (!k) return <div key={i} style={{ width: 84, height: 68 }} />;
        const isDel = k === '⌫';
        return (
          <button
            key={i}
            onClick={() => isDel ? onDelete() : onDigit(k)}
            aria-label={isDel ? 'Delete' : k}
            style={{ width: 84, height: 68, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <div style={{
              width: 60, height: 60, borderRadius: 30,
              backgroundColor: isDel ? 'transparent' : t.surface,
              border: isDel ? 'none' : `1px solid ${t.borderStrong}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontFamily: isDel ? t.font : t.fontDisplay, fontSize: isDel ? 22 : 24, fontWeight: '400', color: t.text }}>{k}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PinFlowOverlay({ step, onSuccess, onCancel, t }: { step: PinStep; onSuccess: (pin?: string) => void; onCancel: () => void; t: Theme }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [shake, setShake] = useState(false);

  function doShake() {
    setShake(true);
    setTimeout(() => setShake(false), 400);
  }

  function handleDigit(d: string) {
    if (pin.length >= 4) return;
    const next = pin + d;
    setPin(next);
    setError('');
    if (next.length === 4) setTimeout(() => validate(next), 160);
  }

  function handleDelete() {
    setPin((p) => p.slice(0, -1));
    setError('');
  }

  function validate(entered: string) {
    if (step.kind === 'verify-current') {
      // Desktop stub: accept any PIN
      onSuccess(entered);
      return;
    }
    if (step.kind === 'create-new') {
      onSuccess(entered);
      return;
    }
    if (step.kind === 'confirm-new') {
      if (entered !== step.prev) {
        doShake();
        setPin('');
        setError('PINs do not match, start over');
      } else {
        onSuccess(entered);
      }
    }
  }

  const title = step.kind === 'create-new' ? 'Create your 4-digit PIN'
    : step.kind === 'confirm-new' ? 'Confirm your PIN'
    : 'Enter your current PIN';

  const sub = step.kind === 'create-new' ? 'Choose 4 digits you remember'
    : step.kind === 'confirm-new' ? 'Retype the same PIN'
    : 'We need to verify your identity';

  return (
    <div style={{ position: 'fixed', inset: 0, backgroundColor: t.bg, zIndex: 200, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'space-between', padding: '64px 28px 40px', boxSizing: 'border-box' }}>
      <style>{`@keyframes aegis-pin-shake{0%,100%{transform:translateX(0)}20%{transform:translateX(-10px)}40%{transform:translateX(10px)}60%{transform:translateX(-8px)}80%{transform:translateX(8px)}}`}</style>
      <button onClick={onCancel} aria-label="Cancel" style={{ alignSelf: 'flex-start', background: 'none', border: 'none', cursor: 'pointer' }}>
        <I.ChevronL size={22} color={t.text} />
      </button>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        <div style={{ width: 52, height: 52, borderRadius: 26, backgroundColor: `${t.accent}22`, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 14 }}>
          <I.Lock size={24} color={t.accent} />
        </div>
        <span style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.3, color: t.text, textAlign: 'center' }}>{title}</span>
        <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, marginTop: 6, textAlign: 'center' }}>{sub}</span>
        <div style={{ animation: shake ? 'aegis-pin-shake 0.4s ease' : 'none', width: '100%', display: 'flex', justifyContent: 'center' }}>
          <PinDots count={pin.length} error={error.length > 0} t={t} />
        </div>
        {error ? (
          <span style={{ fontFamily: t.font, fontSize: 13, color: '#ef4444', textAlign: 'center', marginBottom: 16 }}>{error}</span>
        ) : <div style={{ height: 36 }} />}
        <Numpad onDigit={handleDigit} onDelete={handleDelete} t={t} />
      </div>
      <div style={{ height: 20 }} />
    </div>
  );
}

export function LockSetupScreen({ onBack }: Props) {
  const { t } = useTheme();
  const [hasPIN, setHasPIN] = useState(false);
  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const [appLockEnabled, setAppLockEnabled] = useState(false);
  const [lockTimeoutMin, setLockTimeoutMin] = useState(5);
  const [pinFlow, setPinFlow] = useState<PinStep | null>(null);

  const startCreatePIN = useCallback(() => {
    if (hasPIN) {
      setPinFlow({ kind: 'verify-current' });
    } else {
      setPinFlow({ kind: 'create-new' });
    }
  }, [hasPIN]);

  const handlePinFlowSuccess = useCallback((pin?: string) => {
    if (!pinFlow) return;
    if (pinFlow.kind === 'verify-current') {
      setPinFlow({ kind: 'create-new' });
      return;
    }
    if (pinFlow.kind === 'create-new') {
      setPinFlow({ kind: 'confirm-new', prev: pin! });
      return;
    }
    if (pinFlow.kind === 'confirm-new') {
      setHasPIN(true);
      if (!appLockEnabled) setAppLockEnabled(true);
      setPinFlow(null);
      window.alert('PIN created. The lock screen is active.');
    }
  }, [pinFlow, appLockEnabled]);

  const handleRemovePIN = useCallback(() => {
    if (window.confirm('Remove PIN? Without a PIN, biometrics will also be disabled. Continue?')) {
      setHasPIN(false);
      setAppLockEnabled(false);
      setBiometricsEnabled(false);
    }
  }, []);

  const handleToggleBiometrics = useCallback((val: boolean) => {
    if (val && !hasPIN) {
      window.alert('Create a PIN first. You need a backup PIN before enabling biometrics.');
      return;
    }
    setBiometricsEnabled(val);
  }, [hasPIN]);

  const handleToggleLock = useCallback((val: boolean) => {
    if (val && !hasPIN) {
      window.alert('Create a PIN first to enable lock.');
      return;
    }
    setAppLockEnabled(val);
  }, [hasPIN]);

  function getTimeoutLabel(val: number) {
    if (val === 0) return 'Immediately';
    if (val === 60) return '1 hour';
    return `${val} minutes`;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg, position: 'relative' }}>
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 10, paddingLeft: 18, paddingRight: 18, paddingTop: 12, paddingBottom: 12, borderBottom: `1px solid ${t.divider}` }}>
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
          <I.ChevronL size={22} color={t.text} />
        </button>
        <span style={{ fontFamily: t.fontDisplay, fontSize: 20, fontWeight: '600', letterSpacing: -0.3, color: t.text }}>Set up lock</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 32 }}>
        {/* Status banner */}
        <div style={{
          margin: 18, padding: 14,
          backgroundColor: appLockEnabled ? `${t.accent}14` : `${t.warn}14`,
          border: `1px solid ${appLockEnabled ? `${t.accent}44` : `${t.warn}44`}`,
          borderRadius: t.radius,
          display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12,
        }}>
          <div style={{ width: 36, height: 36, borderRadius: 18, backgroundColor: appLockEnabled ? `${t.accent}22` : `${t.warn}22`, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I.Lock size={18} color={appLockEnabled ? t.accent : t.warn} />
          </div>
          <div style={{ flex: 1 }}>
            <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 13, color: t.text, display: 'block' }}>
              {appLockEnabled ? 'Lock active' : 'Lock disabled'}
            </span>
            <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2, display: 'block' }}>
              {appLockEnabled ? `PIN ${hasPIN ? '✓' : '—'} · Biometrics ${biometricsEnabled ? '✓' : '—'}` : 'Create a PIN to enable lock'}
            </span>
          </div>
        </div>

        <Section t={t} label="PIN">
          <Row t={t} icon={<I.Key size={20} color={t.textDim} />}
            label={hasPIN ? 'Change PIN' : 'Create PIN'}
            sub={hasPIN ? 'Tap to set a new PIN' : '4-digit PIN required for lock'}
            onPress={startCreatePIN}
          />
          {hasPIN && (
            <Row t={t} icon={<I.Trash size={20} color="#ef4444" />}
              label="Remove PIN" sub="Also disables lock and biometrics"
              onPress={handleRemovePIN} noBorder
            />
          )}
        </Section>

        <Section t={t} label="BIOMETRICS">
          <Toggle t={t} icon={<I.Fingerprint size={20} color={t.textDim} />}
            label="Face ID / Fingerprint"
            sub={hasPIN ? 'Unlock with biometrics in addition to PIN' : 'Create a PIN first'}
            value={biometricsEnabled} onChange={handleToggleBiometrics}
            disabled={!hasPIN}
          />
        </Section>

        <Section t={t} label="CONFIGURATION">
          <Toggle t={t} icon={<I.Lock size={20} color={t.textDim} />}
            label="Auto-lock" sub="Locks the app when leaving foreground"
            value={appLockEnabled} onChange={handleToggleLock}
          />
          {appLockEnabled && (
            <div style={{ paddingLeft: 16, paddingBottom: 12, borderTop: `1px solid ${t.divider}` }}>
              <span style={{ fontFamily: t.fontMono, fontSize: 11, color: t.textDim, letterSpacing: 0.8, display: 'block', marginTop: 14, marginBottom: 10 }}>
                LOCK AFTER
              </span>
              <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {TIMEOUT_OPTIONS.map((opt) => {
                  const selected = lockTimeoutMin === opt.value;
                  return (
                    <button
                      key={opt.value}
                      onClick={() => setLockTimeoutMin(opt.value)}
                      aria-label={opt.label}
                      style={{
                        paddingLeft: 14, paddingRight: 14, paddingTop: 8, paddingBottom: 8,
                        borderRadius: t.radiusS, border: `1px solid ${selected ? t.accent : t.border}`,
                        backgroundColor: selected ? `${t.accent}1A` : t.surface2,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ fontFamily: t.font, fontSize: 13, fontWeight: selected ? '600' : '400', color: selected ? t.accent : t.text }}>
                        {opt.label}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          <Row t={t} icon={<I.Shield size={20} color={t.textDim} />}
            label="Panic mode" sub="Decoy PIN that wipes everything"
            onPress={() => window.alert('Panic mode is configurable from Privacy → Panic mode.')}
            noBorder
          />
        </Section>

        <div style={{ marginLeft: 18, marginRight: 18, marginTop: 8, padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
            <I.Shield size={14} color={t.accent} />
            <span style={{ fontFamily: t.font, fontWeight: '600', fontSize: 12, color: t.text }}>Your PIN never leaves the device</span>
          </div>
          <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '18px', display: 'block', marginTop: 6 }}>
            Saved as a salted SHA-256 hash in system Keychain. Neither AegisLink nor anyone else has access.
          </span>
        </div>
      </div>

      {pinFlow && (
        <PinFlowOverlay
          step={pinFlow}
          t={t}
          onSuccess={handlePinFlowSuccess}
          onCancel={() => setPinFlow(null)}
        />
      )}
    </div>
  );
}
