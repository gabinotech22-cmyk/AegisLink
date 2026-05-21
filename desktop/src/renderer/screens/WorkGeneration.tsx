import { useEffect, useRef, useState } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { I } from '../components/icons';
import { useIdentity } from '../store/identity';

interface Props {
  onDone: () => void;
  onBack: () => void;
}

export function WorkGenerationScreen({ onDone, onBack }: Props) {
  const { t } = useTheme();
  const { createWorkSlot, switchSlot } = useIdentity();
  const [progress, setProgress] = useState(0);
  const [angle, setAngle] = useState(0);
  const isCreatedRef = useRef(false);
  const isAnimDoneRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const startRef = useRef<number | null>(null);

  async function completeAndSwitch() {
    try {
      await switchSlot('work');
      onDone();
    } catch (e) {
      window.alert((e as Error).message);
      onBack();
    }
  }

  useEffect(() => {
    const duration = 10000;
    startRef.current = performance.now();

    function tick(now: number) {
      const elapsed = now - (startRef.current ?? now);
      const p = Math.min(1, elapsed / duration);
      setProgress(p);
      setAngle((a) => (a + 3) % 360);
      if (p < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        isAnimDoneRef.current = true;
        if (isCreatedRef.current) void completeAndSwitch();
      }
    }
    rafRef.current = requestAnimationFrame(tick);

    createWorkSlot()
      .then(() => {
        isCreatedRef.current = true;
        if (isAnimDoneRef.current) void completeAndSwitch();
      })
      .catch((err) => {
        window.alert(err.message || 'Key generation error');
        onBack();
      });

    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, height: '100%', backgroundColor: '#0b0813', alignItems: 'center', justifyContent: 'center', padding: '24px 28px', boxSizing: 'border-box' }}>
      {/* Spinner */}
      <div style={{ width: 96, height: 96, position: 'relative', marginBottom: 36 }}>
        <svg width="96" height="96" viewBox="0 0 96 96" style={{ position: 'absolute', inset: 0, transform: `rotate(${angle}deg)` }}>
          <circle cx="48" cy="48" r="46" fill="none" stroke="#8b5cf6" strokeWidth="2" strokeDasharray="72 216" strokeLinecap="round" />
        </svg>
        <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ width: 60, height: 60, borderRadius: 30, backgroundColor: '#1b152d', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
            <I.Key size={26} color="#8b5cf6" />
          </div>
        </div>
      </div>

      <span style={{ fontFamily: t.fontDisplay, fontSize: 24, fontWeight: '600', letterSpacing: -0.48, color: '#ffffff', textAlign: 'center', display: 'block', marginBottom: 12 }}>
        Generating work keys
      </span>
      <span style={{ fontFamily: t.fontMono, fontSize: 11, color: '#a78bfa', textAlign: 'center', display: 'block', letterSpacing: 0.4, marginBottom: 32 }}>
        CURVE25519 · ED25519 · ISOLATED KEYCHAIN
      </span>

      {/* Progress bar */}
      <div style={{ width: '100%', maxWidth: 320, height: 3, borderRadius: 99, backgroundColor: '#21183c', overflow: 'hidden' }}>
        <div style={{ height: '100%', width: `${progress * 100}%`, backgroundColor: '#8b5cf6', borderRadius: 99, transition: 'width 0.05s linear' }} />
      </div>
    </div>
  );
}
