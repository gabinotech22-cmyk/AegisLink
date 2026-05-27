import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useTheme } from '../theme/ThemeContext';
import { AegisMark } from '../components/AegisMark';

interface Props {
  onDone: () => void;
}

export function SplashScreen({ onDone }: Props) {
  const { t } = useTheme();
  const doneRef = useRef(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      if (!doneRef.current) {
        doneRef.current = true;
        onDone();
      }
    }, 2500);
    return () => clearTimeout(timer);
  }, [onDone]);

  const root: CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100vh',
    width: '100vw',
    backgroundColor: t.bg,
    position: 'fixed',
    inset: 0,
    zIndex: 100,
  };

  const pulseRingBase: CSSProperties = {
    position: 'absolute',
    width: 72,
    height: 72,
    borderRadius: '50%',
    border: `1.5px solid ${t.accent}`,
    boxSizing: 'border-box',
    pointerEvents: 'none',
  };

  return (
    <div style={root}>
      <style>{`
        @keyframes aegis-pulse {
          0%   { transform: scale(1);   opacity: 0.6; }
          100% { transform: scale(2.2); opacity: 0; }
        }
        @keyframes splash-fadein {
          from { opacity: 0; transform: translateY(8px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        .splash-logo {
          animation: splash-fadein 0.5s ease forwards;
        }
        .splash-name {
          animation: splash-fadein 0.5s ease 0.3s both;
        }
        .splash-tagline {
          animation: splash-fadein 0.5s ease 0.6s both;
        }
        .splash-ring-1 {
          animation: aegis-pulse 2s ease-out 0s infinite;
        }
        .splash-ring-2 {
          animation: aegis-pulse 2s ease-out 0.5s infinite;
        }
        .splash-ring-3 {
          animation: aegis-pulse 2s ease-out 1s infinite;
        }
      `}</style>

      {/* Pulse rings + Shield logo — stacked in relative container */}
      <div className="splash-logo" style={{ position: 'relative', width: 72, height: 72, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <div className="splash-ring-1" style={pulseRingBase} />
        <div className="splash-ring-2" style={pulseRingBase} />
        <div className="splash-ring-3" style={pulseRingBase} />
        <div style={{ position: 'relative', zIndex: 1 }}>
          <AegisMark t={t} size={72} />
        </div>
      </div>

      {/* App name */}
      <div className="splash-name" style={{ marginTop: 24 }}>
        <span
          style={{
            fontFamily: t.fontDisplay,
            fontSize: 32,
            fontWeight: '600',
            letterSpacing: -0.8,
            color: t.text,
          }}
        >
          AegisLink
        </span>
      </div>

      {/* Tagline */}
      <div className="splash-tagline" style={{ marginTop: 8 }}>
        <span
          style={{
            fontFamily: t.fontMono,
            fontSize: 10,
            color: t.textDim,
            letterSpacing: 2,
          }}
        >
          SECURE · ANONYMOUS · ON-DEVICE
        </span>
      </div>
    </div>
  );
}
