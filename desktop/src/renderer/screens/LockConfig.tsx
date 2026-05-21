import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import type { Theme } from '../theme/vault';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';

interface Props {
  onBack: () => void;
  onLockTest: () => void;
  onLockSettings?: () => void;
}

const TIMEOUT_OPTIONS = [0, 1, 5, 15, 60];

function PinDots({ count, t }: { count: number; t: Theme }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', gap: 16, justifyContent: 'center', marginTop: 28, marginBottom: 28 }}>
      {[0, 1, 2, 3].map((i) => (
        <div
          key={i}
          style={{
            width: 16,
            height: 16,
            borderRadius: 8,
            backgroundColor: i < count ? t.accent : 'transparent',
            border: `2px solid ${i < count ? t.accent : t.borderStrong}`,
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
    <div style={{ display: 'flex', flexDirection: 'row', flexWrap: 'wrap', width: 240, alignSelf: 'center' }}>
      {keys.map((k, i) => {
        if (!k) return <div key={i} style={{ width: 80, height: 64 }} />;
        const isDel = k === '⌫';
        return (
          <button
            key={i}
            onClick={() => isDel ? onDelete() : onDigit(k)}
            aria-label={isDel ? 'Delete' : k}
            style={{ width: 80, height: 64, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
          >
            <div style={{
              width: 56, height: 56, borderRadius: 28,
              backgroundColor: isDel ? 'transparent' : t.surface2,
              border: isDel ? 'none' : `1px solid ${t.border}`,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}>
              <span style={{ fontFamily: isDel ? t.font : t.fontDisplay, fontSize: isDel ? 20 : 22, fontWeight: '500', color: t.text }}>{k}</span>
            </div>
          </button>
        );
      })}
    </div>
  );
}

export function LockConfigScreen({ onBack, onLockTest, onLockSettings }: Props) {
  const { t } = useTheme();
  const [appLockEnabled, setAppLockEnabled] = useState(false);
  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const [lockTimeoutMin, setLockTimeoutMin] = useState(5);
  const [hideRecents, setHideRecents] = useState(false);
  const [pinStored, setPinStored] = useState(false);
  const [showPinModal, setShowPinModal] = useState(false);
  const [pinStep, setPinStep] = useState<'enter' | 'confirm'>('enter');
  const [firstPin, setFirstPin] = useState('');
  const [pinEntry, setPinEntry] = useState('');
  const [pinError, setPinError] = useState('');
  const [showTimeout, setShowTimeout] = useState(false);
  const [shakeModal, setShakeModal] = useState(false);
  const pendingEnable = useRef(false);

  function shake() {
    setShakeModal(true);
    setTimeout(() => setShakeModal(false), 400);
  }

  function openPinModal(isPendingEnable = false) {
    pendingEnable.current = isPendingEnable;
    setPinStep('enter');
    setFirstPin('');
    setPinEntry('');
    setPinError('');
    setShowPinModal(true);
  }

  function handleDigit(d: string) {
    if (pinEntry.length >= 4) return;
    const next = pinEntry + d;
    setPinEntry(next);
    setPinError('');
    if (next.length === 4) setTimeout(() => processPin(next), 180);
  }

  function handleDelete() {
    setPinEntry((p) => p.slice(0, -1));
    setPinError('');
  }

  function processPin(pin: string) {
    if (pinStep === 'enter') {
      setFirstPin(pin);
      setPinStep('confirm');
      setPinEntry('');
    } else {
      if (pin !== firstPin) {
        setPinError('PINs do not match. Try again.');
        shake();
        setPinEntry('');
        setPinStep('enter');
        setFirstPin('');
      } else {
        setPinStored(true);
        if (pendingEnable.current) {
          setAppLockEnabled(true);
          pendingEnable.current = false;
        }
        setShowPinModal(false);
      }
    }
  }

  function handleToggleAppLock(val: boolean) {
    if (val && !pinStored) {
      openPinModal(true);
      return;
    }
    setAppLockEnabled(val);
  }

  function handleClearPin() {
    if (window.confirm('Delete PIN? App lock will be disabled.')) {
      setPinStored(false);
      setAppLockEnabled(false);
    }
  }

  function getTimeoutLabel(val: number) {
    if (val === 0) return 'Immediately';
    if (val === 60) return '1 hour';
    return `${val} minutes`;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <style>{`
        @keyframes aegis-shake-modal {
          0%,100% { transform: translateX(0); }
          20% { transform: translateX(-10px); }
          40% { transform: translateX(10px); }
          60% { transform: translateX(-8px); }
          80% { transform: translateX(8px); }
        }
      `}</style>

      <TopBar t={t} title="App Lock" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 32 }}>
        <Section t={t} label="ACCESS PROTECTION">
          <Toggle t={t} label="App lock" sub={appLockEnabled ? 'Active · Authentication required to open' : 'Disabled'} value={appLockEnabled} onChange={handleToggleAppLock} />

          {appLockEnabled && (
            <>
              <Toggle t={t} label="Face ID / Fingerprint" sub="Use biometrics as primary method" value={biometricsEnabled} onChange={setBiometricsEnabled} />

              <button
                onClick={() => setShowTimeout((v) => !v)}
                aria-label="Inactivity timeout"
                style={{
                  display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingLeft: 16, paddingRight: 16, paddingTop: 13, paddingBottom: 13,
                  backgroundColor: 'transparent', borderBottom: `1px solid ${t.divider}`,
                  width: '100%', cursor: 'pointer', border: 'none', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: t.divider, boxSizing: 'border-box',
                }}
              >
                <span style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>Inactivity timeout</span>
                <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <span style={{ fontFamily: t.fontMono, fontSize: 12, color: t.accent }}>{getTimeoutLabel(lockTimeoutMin)}</span>
                  <I.ChevronD size={14} color={t.textFaint} />
                </div>
              </button>

              {showTimeout && (
                <div style={{ backgroundColor: t.surface2 }}>
                  {TIMEOUT_OPTIONS.map((opt, i) => (
                    <button
                      key={opt}
                      onClick={() => { setLockTimeoutMin(opt); setShowTimeout(false); }}
                      aria-label={getTimeoutLabel(opt)}
                      style={{
                        display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                        paddingLeft: 24, paddingRight: 24, paddingTop: 12, paddingBottom: 12,
                        backgroundColor: 'transparent', width: '100%', cursor: 'pointer',
                        borderBottom: i < TIMEOUT_OPTIONS.length - 1 ? `1px solid ${t.divider}` : 'none',
                        border: 'none', borderBottomWidth: i < TIMEOUT_OPTIONS.length - 1 ? 1 : 0, borderBottomStyle: 'solid', borderBottomColor: t.divider, boxSizing: 'border-box',
                      }}
                    >
                      <span style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{getTimeoutLabel(opt)}</span>
                      {lockTimeoutMin === opt && <I.Check size={16} color={t.accent} />}
                    </button>
                  ))}
                </div>
              )}

              <button
                onClick={() => openPinModal(false)}
                aria-label={pinStored ? 'Change PIN' : 'Set PIN'}
                style={{
                  display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                  paddingLeft: 16, paddingRight: 16, paddingTop: 13, paddingBottom: 13,
                  backgroundColor: 'transparent', borderBottom: `1px solid ${t.divider}`,
                  width: '100%', cursor: 'pointer', border: 'none', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: t.divider, boxSizing: 'border-box',
                }}
              >
                <span style={{ fontFamily: t.font, fontSize: 14, color: t.text }}>{pinStored ? 'Change PIN' : 'Set PIN'}</span>
                <I.Chevron size={16} color={t.textFaint} />
              </button>

              {pinStored && (
                <button
                  onClick={handleClearPin}
                  aria-label="Delete PIN"
                  style={{
                    display: 'block', textAlign: 'left', paddingLeft: 16, paddingRight: 16, paddingTop: 13, paddingBottom: 13,
                    backgroundColor: 'transparent', borderBottom: `1px solid ${t.divider}`,
                    width: '100%', cursor: 'pointer', border: 'none', borderBottomWidth: 1, borderBottomStyle: 'solid', borderBottomColor: t.divider, boxSizing: 'border-box',
                  }}
                >
                  <span style={{ fontFamily: t.font, fontSize: 14, color: '#ef4444' }}>Delete PIN</span>
                </button>
              )}

              <button
                onClick={onLockTest}
                aria-label="Lock now test"
                style={{
                  display: 'block', textAlign: 'left', paddingLeft: 16, paddingRight: 16, paddingTop: 13, paddingBottom: 13,
                  backgroundColor: 'transparent', width: '100%', cursor: 'pointer', border: 'none', boxSizing: 'border-box',
                }}
              >
                <span style={{ fontFamily: t.font, fontSize: 14, color: t.accent }}>Lock now (Test) ▸</span>
              </button>
            </>
          )}
        </Section>

        {onLockSettings && (
          <Section t={t} label="ADVANCED">
            <button
              onClick={onLockSettings}
              aria-label="Lock Settings"
              style={{
                display: 'flex', flexDirection: 'row', alignItems: 'center',
                paddingLeft: 16, paddingRight: 16, paddingTop: 13, paddingBottom: 13,
                backgroundColor: 'transparent', width: '100%', cursor: 'pointer', border: 'none', boxSizing: 'border-box',
              }}
            >
              <I.Settings size={16} color={t.textDim} />
              <span style={{ fontFamily: t.font, fontSize: 14, color: t.text, marginLeft: 10, flex: 1, textAlign: 'left' }}>Lock Settings</span>
              <I.Chevron size={14} color={t.textFaint} />
            </button>
          </Section>
        )}

        <Section t={t} label="SCREEN PRIVACY">
          <Toggle t={t} label="Hide in recents" sub="Screen goes black when switching apps" value={hideRecents} onChange={setHideRecents} noBorder />
        </Section>

        <div style={{ paddingLeft: 18, paddingRight: 18, marginTop: 10 }}>
          <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, lineHeight: '18px', display: 'block' }}>
            AegisLink has no access to your biometric data. They are processed locally. The PIN never leaves the device.
          </span>
        </div>
      </div>

      {/* PIN Modal */}
      {showPinModal && (
        <div style={{
          position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100,
        }}>
          <div style={{
            backgroundColor: t.bg, borderRadius: t.radius, padding: 24, width: 320, maxWidth: '90vw',
            boxSizing: 'border-box',
          }}>
            <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <button onClick={() => { setShowPinModal(false); pendingEnable.current = false; }} aria-label="Cancel" style={{ background: 'none', border: 'none', cursor: 'pointer' }}>
                <span style={{ fontFamily: t.font, fontSize: 15, color: t.accent }}>Cancel</span>
              </button>
              <span style={{ fontFamily: t.font, fontSize: 16, fontWeight: '600', color: t.text }}>
                {pinStored ? 'Change PIN' : 'Set PIN'}
              </span>
              <div style={{ width: 60 }} />
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
              <span style={{ fontFamily: t.font, fontSize: 15, color: t.textDim, marginBottom: 4 }}>
                {pinStep === 'enter' ? 'Enter a 4-digit PIN' : 'Confirm your PIN'}
              </span>

              <div style={{ animation: shakeModal ? 'aegis-shake-modal 0.4s ease' : 'none', width: '100%', display: 'flex', justifyContent: 'center' }}>
                <PinDots count={pinEntry.length} t={t} />
              </div>

              {pinError ? (
                <span style={{ fontFamily: t.font, fontSize: 13, color: '#ef4444', marginBottom: 16, textAlign: 'center' }}>{pinError}</span>
              ) : (
                <div style={{ height: 36 }} />
              )}

              <Numpad onDigit={handleDigit} onDelete={handleDelete} t={t} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
