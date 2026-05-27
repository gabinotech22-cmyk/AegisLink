import { useState } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { TopBar } from '../components/TopBar';
import { Section, Toggle } from '../components/Section';

interface Props {
  onBack: () => void;
  /** Called after a real wipe is triggered — App.tsx wires this to reset identity + stack */
  onWipe?: () => Promise<void>;
}

export function PanicScreen({ onBack, onWipe }: Props) {
  const { t } = useTheme();
  const [duressPin, setDuressPin] = useState(true);
  const [autoWipe, setAutoWipe] = useState(false);
  const [isEditingPin, setIsEditingPin] = useState(false);
  const [tempPin, setTempPin] = useState('');
  const [pinSaved, setPinSaved] = useState(false);
  const [pinError, setPinError] = useState('');

  function handleSavePin() {
    if (tempPin.length < 4 || tempPin.length > 6) {
      setPinError('PIN must be 4–6 digits.');
      return;
    }
    setPinSaved(true);
    setIsEditingPin(false);
    setTempPin('');
    setPinError('');
    window.alert('Decoy PIN saved. Entering this PIN will trigger the panic wipe.');
  }

  function handleActivatePanic() {
    const first = window.confirm(
      'ACTIVATE PANIC MODE?\n\nThis will wipe all keys, messages and contacts from this device permanently. This cannot be undone.'
    );
    if (!first) return;
    const second = window.confirm('Are you absolutely sure? THIS CANNOT BE UNDONE.');
    if (!second) return;
    // If App.tsx supplied a real wipe callback, use it (clears stack before
    // setting identity = null to avoid the green-screen race).
    if (onWipe) {
      void onWipe();
    } else {
      window.alert('Panic activated. All data has been wiped.');
      onBack();
    }
  }

  const overlayStyle: CSSProperties = {
    position: 'fixed',
    inset: 0,
    backgroundColor: 'rgba(0,0,0,0.7)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 100,
    padding: 24,
    boxSizing: 'border-box',
  };

  const modalStyle: CSSProperties = {
    backgroundColor: t.surface,
    borderRadius: t.radius,
    border: `1px solid ${t.border}`,
    padding: 20,
    width: '100%',
    maxWidth: 380,
    boxSizing: 'border-box',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: t.bg }}>
      <TopBar t={t} title="Panic mode" left={
        <button onClick={onBack} aria-label="Go back" style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
          <I.ChevronL size={22} color={t.textDim} />
        </button>
      } />

      <div style={{ flex: 1, overflowY: 'auto', paddingBottom: 32 }}>
        {/* Hero */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', padding: '24px 28px 20px' }}>
          <div style={{
            width: 76, height: 76, borderRadius: 38,
            backgroundColor: 'rgba(255,107,107,0.12)',
            border: `1px solid ${t.danger}55`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            marginBottom: 16,
          }}>
            <I.Shield size={32} color={t.danger} />
          </div>
          <span style={{ fontFamily: t.fontDisplay, fontSize: 24, fontWeight: '600', letterSpacing: -0.4, color: t.text, textAlign: 'center', display: 'block' }}>
            Panic Mode
          </span>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '19px', textAlign: 'center', maxWidth: 290, marginTop: 10, display: 'block' }}>
            Instantly wipe all keys, messages and contacts from this device. Nothing stays — not even in memory.
          </span>
        </div>

        {/* Trigger method — desktop note */}
        <div style={{ margin: '0 18px 18px', padding: 14, backgroundColor: t.surface, border: `1px solid ${t.border}`, borderRadius: t.radius }}>
          <span style={{ fontFamily: t.fontMono, fontSize: 10, color: t.textDim, letterSpacing: 1.1, display: 'block', marginBottom: 8 }}>
            TRIGGER METHOD
          </span>
          <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, lineHeight: '18px', display: 'block' }}>
            On desktop, use the red PANIC button below. Shake and volume gestures are only available on mobile.
          </span>
        </div>

        <Section t={t} label="DECOY PIN">
          <Toggle
            t={t}
            label="Enable decoy PIN"
            sub="Entering this PIN instead of your real PIN triggers a wipe"
            value={duressPin}
            onChange={setDuressPin}
          />
          {duressPin && (
            <div
              role="button"
              tabIndex={0}
              onClick={() => setIsEditingPin(true)}
              onKeyDown={(e) => e.key === 'Enter' && setIsEditingPin(true)}
              style={{
                display: 'flex', flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
                padding: '12px 16px', cursor: 'pointer', boxSizing: 'border-box',
              }}
              aria-label="Change decoy PIN"
            >
              <div>
                <span style={{ fontFamily: t.font, fontSize: 14, color: t.text, display: 'block' }}>
                  {pinSaved ? 'Change decoy PIN' : 'Set decoy PIN'}
                </span>
                <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, display: 'block', marginTop: 2 }}>
                  {pinSaved ? 'Decoy PIN is set' : '4–6 digit PIN that wipes on entry'}
                </span>
              </div>
              <I.Chevron size={14} color={t.textFaint} />
            </div>
          )}
        </Section>

        <Section t={t} label="AUTO-WIPE">
          <Toggle
            t={t}
            label="Auto-wipe after 5 failed attempts"
            sub="If the main PIN is wrong 5 times consecutively, wipe everything"
            value={autoWipe}
            onChange={setAutoWipe}
            noBorder
          />
        </Section>

        {/* Big red PANIC button */}
        <div style={{ padding: '8px 18px 24px' }}>
          <button
            onClick={handleActivatePanic}
            aria-label="Activate panic mode"
            style={{
              width: '100%', padding: '18px 0', borderRadius: t.radius,
              backgroundColor: t.danger, border: 'none', cursor: 'pointer',
              fontFamily: t.font, fontWeight: '700', fontSize: 16, color: '#fff',
              letterSpacing: 0.5,
            }}
          >
            PANIC — WIPE EVERYTHING
          </button>
          <span style={{ fontFamily: t.font, fontSize: 11, color: t.textDim, display: 'block', textAlign: 'center', marginTop: 8, lineHeight: '16px' }}>
            This action is irreversible. All data will be permanently deleted.
          </span>
        </div>
      </div>

      {/* Change Decoy PIN overlay */}
      {isEditingPin && (
        <div style={overlayStyle}>
          <div style={modalStyle}>
            <span style={{ fontFamily: t.fontDisplay, fontSize: 18, fontWeight: '700', color: t.text, display: 'block', marginBottom: 8 }}>
              Set decoy PIN
            </span>
            <span style={{ fontFamily: t.font, fontSize: 13, color: t.textDim, display: 'block', marginBottom: 16, lineHeight: '18px' }}>
              Enter 4–6 digits. Never tell anyone this PIN — it triggers an immediate wipe.
            </span>
            <input
              type="password"
              inputMode="numeric"
              maxLength={6}
              value={tempPin}
              onChange={(e) => { setTempPin(e.target.value.replace(/[^0-9]/g, '')); setPinError(''); }}
              placeholder="Enter 4–6 digit PIN"
              style={{
                width: '100%', padding: 12, fontSize: 20, textAlign: 'center', letterSpacing: 8,
                fontFamily: t.fontMono, color: t.text, backgroundColor: t.bg,
                border: `1px solid ${pinError ? '#ef4444' : t.borderStrong}`, borderRadius: t.radiusS,
                marginBottom: 8, boxSizing: 'border-box',
              }}
            />
            {pinError && (
              <span style={{ fontFamily: t.font, fontSize: 12, color: '#ef4444', display: 'block', marginBottom: 12 }}>{pinError}</span>
            )}
            <div style={{ display: 'flex', flexDirection: 'row', gap: 10, marginTop: 12 }}>
              <button
                onClick={handleSavePin}
                style={{
                  flex: 1, padding: '12px 0', backgroundColor: t.danger, border: 'none',
                  borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '600', color: '#fff',
                }}
              >
                Save PIN
              </button>
              <button
                onClick={() => { setIsEditingPin(false); setTempPin(''); setPinError(''); }}
                style={{
                  flex: 1, padding: '12px 0', backgroundColor: 'transparent',
                  border: `1px solid ${t.borderStrong}`,
                  borderRadius: t.radiusS, cursor: 'pointer', fontFamily: t.font, fontWeight: '500', color: t.text,
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
