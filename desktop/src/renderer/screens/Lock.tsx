import { useEffect, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { verifyPIN } from '../lock/pin';
import { getDbKEK } from '../lock/dbKeyWrap';

const MAX_ATTEMPTS = 5;

interface Props {
  onUnlock: () => void;
  onPanic: () => void;
  /**
   * 'overlay' (default): runtime re-lock — the DB is already open, the PIN only
   * gates the UI (biometrics allowed). 'cold': cold-start unlock of a PIN-wrapped
   * DB (C-2 Fase 2) — the entered PIN derives the KEK that opens the DB, so the
   * crypto unlock IS the PIN check and biometrics cannot substitute for it.
   */
  variant?: 'cold' | 'overlay';
}

function PinDots({ count, error, t }: { count: number; error: boolean; t: Theme }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 18, justifyContent: 'center', marginTop: 32, marginBottom: 32 }}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
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
            style={{
              width: 84,
              height: 68,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <div style={{
              width: 60,
              height: 60,
              borderRadius: 30,
              backgroundColor: isDel ? 'transparent' : t.surface,
              border: isDel ? 'none' : `1px solid ${t.borderStrong}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              <span style={{ fontFamily: isDel ? t.font : t.fontDisplay, fontSize: isDel ? 22 : 24, fontWeight: '400', color: t.text }}>
                {k}
              </span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function LockScreen({ onUnlock, onPanic, variant = 'overlay' }: Props) {
  const { t } = useTheme();
  const [mode, setMode] = useState<'biometric' | 'pin'>('pin');
  const [pinCode, setPinCode] = useState('');
  const [pinError, setPinError] = useState('');
  const [attempts, setAttempts] = useState(0);
  const [shakeClass, setShakeClass] = useState(false);

  // On desktop: try Electron biometric auth, fall back to PIN. SKIPPED at cold
  // start — biometrics cannot derive the PIN-KEK that opens the DB (Fase 2).
  useEffect(() => {
    if (variant === 'cold') { setMode('pin'); return; }
    const tryBio = async () => {
      try {
        const electronAny = (window as unknown as Record<string, unknown>)['electronAPI'] as { authenticate?: () => Promise<boolean> } | undefined;
        const ok = electronAny?.authenticate ? await electronAny.authenticate() : false;
        if (ok) { setTimeout(onUnlock, 300); return; }
      } catch {
        // auth not available
      }
      setMode('pin');
    };
    void tryBio();
  }, []);

  function shake() {
    setShakeClass(true);
    setTimeout(() => setShakeClass(false), 400);
  }

  function handleDigit(d: string) {
    if (pinCode.length >= 4) return;
    const next = pinCode + d;
    setPinCode(next);
    setPinError('');
    if (next.length === 4) setTimeout(() => validatePin(next), 180);
  }

  function handleDelete() {
    setPinCode((p) => p.slice(0, -1));
    setPinError('');
  }

  async function validatePin(pin: string) {
    // 'cold': derive the KEK from the PIN and try to OPEN the DB — the crypto
    // unlock (secretbox.open) is itself the PIN check (wrong PIN ⇒ db.unlock
    // throws). 'overlay': verify against the stored Argon2id hash (constant-time).
    // No bypass either way: an empty store / wrong PIN never unlocks.
    let ok = false;
    try {
      if (variant === 'cold') {
        const kek = await getDbKEK(pin);
        await window.aegis.db.unlock(kek); // throws on wrong PIN
        ok = true;
      } else {
        ok = await verifyPIN(pin);
      }
    } catch {
      ok = false;
    }
    if (ok) {
      setPinCode('');
      onUnlock();
      return;
    }
    const newAttempts = attempts + 1;
    setAttempts(newAttempts);
    shake();
    setPinCode('');
    if (newAttempts >= MAX_ATTEMPTS) {
      setPinError(`Max attempts reached. Triggering panic mode.`);
      setTimeout(onPanic, 1800);
    } else {
      const left = MAX_ATTEMPTS - newAttempts;
      setPinError(`Incorrect PIN. ${left} attempt${left === 1 ? '' : 's'} remaining.`);
    }
  }

  return (
    <div style={{
      flex: 1,
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'space-between',
      backgroundColor: t.bg,
      height: '100%',
      padding: '40px 28px 20px',
      boxSizing: 'border-box',
    }}>
      <style>{`
        @keyframes aegis-shake {
          0%,100% { transform: translateX(0); }
          20% { transform: translateX(-12px); }
          40% { transform: translateX(12px); }
          60% { transform: translateX(-10px); }
          80% { transform: translateX(10px); }
        }
      `}</style>

      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 8 }}>
        <I.Lock size={12} color={t.textDim} />
        <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1 }}>LOCKED</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', width: '100%' }}>
        <span style={{ fontFamily: t.fontDisplay, fontSize: 22, fontWeight: '600', letterSpacing: -0.3, color: t.text }}>
          Enter PIN
        </span>

        <div style={{
          animation: shakeClass ? 'aegis-shake 0.4s ease' : 'none',
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
        }}>
          <PinDots count={pinCode.length} error={pinError.length > 0} t={t} />
        </div>

        {pinError ? (
          <span style={{ fontFamily: t.font, fontSize: 13, color: '#ef4444', textAlign: 'center', marginBottom: 20, paddingLeft: 32, paddingRight: 32 }}>
            {pinError}
          </span>
        ) : (
          <div style={{ height: 38 }} />
        )}

        <Numpad onDigit={handleDigit} onDelete={handleDelete} t={t} />

        {mode === 'pin' && variant !== 'cold' && (
          <button
            onClick={async () => {
              try {
                const electronAny = (window as unknown as Record<string, unknown>)['electronAPI'] as { authenticate?: () => Promise<boolean> } | undefined;
                const ok = electronAny?.authenticate ? await electronAny.authenticate() : window.confirm('Authenticate with system credentials?');
                if (ok) onUnlock();
              } catch {
                // ignore
              }
            }}
            style={{ marginTop: 24, background: 'none', border: 'none', cursor: 'pointer' }}
            aria-label="Use biometrics"
          >
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.accent }}>
              Use biometrics / system authentication
            </span>
          </button>
        )}
      </div>

      <button
        onClick={onPanic}
        aria-label="Emergency"
        style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 8 }}
      >
        <span style={{ fontFamily: t.fontMono, fontSize: 11, color: '#ef4444', letterSpacing: 0.8 }}>
          EMERGENCY
        </span>
      </button>
    </div>
  );
}
