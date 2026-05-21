import type { CSSProperties } from 'react';
import type { Theme } from '../theme/vault';

interface Props {
  t: Theme;
  size?: number;
  mono?: boolean;
}

export function AegisMark({ t, size = 32, mono = false }: Props) {
  const stroke = mono ? t.text : t.accent;
  const fill = mono ? t.text : t.accent;
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path
        d="M20 2 L35 10 L35 30 L20 38 L5 30 L5 10 Z"
        stroke={stroke}
        strokeWidth={2.4}
        strokeLinejoin="round"
        fill="none"
      />
      <rect x={13} y={15} width={14} height={3.2} rx={0.4} fill={fill} />
      <rect x={13} y={21.8} width={14} height={3.2} rx={0.4} fill={fill} opacity={0.55} />
    </svg>
  );
}

interface WordProps {
  t: Theme;
  size?: number;
  compact?: boolean;
}

export function AegisWord({ t, size = 22, compact = false }: WordProps) {
  const style: CSSProperties = {
    fontFamily: t.fontDisplay,
    fontWeight: '500',
    fontSize: size,
    letterSpacing: -0.2,
    color: t.text,
    lineHeight: `${size * 1.05}px`,
    margin: 0,
  };

  return <span style={style}>{compact ? 'Aegis' : 'AegisLink'}</span>;
}

/** Spinning key animation for the onboarding generating step. */
interface SpinnerProps {
  t: Theme;
}

export function KeySpinner({ t }: SpinnerProps) {
  const containerStyle: CSSProperties = {
    width: 96,
    height: 96,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
  };

  const ringStyle: CSSProperties = {
    position: 'absolute',
    width: 96,
    height: 96,
    borderRadius: '50%',
    border: `2px solid ${t.surface3}`,
    borderTopColor: t.accent,
    animation: 'aegis-spin 1.4s linear infinite',
    boxSizing: 'border-box',
  };

  const innerStyle: CSSProperties = {
    width: 60,
    height: 60,
    borderRadius: '50%',
    backgroundColor: t.surface,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    zIndex: 1,
  };

  return (
    <>
      <style>{`
        @keyframes aegis-spin {
          from { transform: rotate(0deg); }
          to   { transform: rotate(360deg); }
        }
        @keyframes aegis-progress {
          from { width: 0%; }
          to   { width: 100%; }
        }
        @keyframes aegis-pulse-ring {
          0%   { transform: scale(0.5); opacity: 0.6; }
          100% { transform: scale(1.3); opacity: 0; }
        }
      `}</style>
      <div style={containerStyle}>
        <div style={ringStyle} />
        <div style={innerStyle}>
          {/* Key icon inline SVG */}
          <svg width={26} height={26} viewBox="0 0 24 24" fill="none" stroke={t.accent} strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <circle cx={8} cy={14} r={4} />
            <path d="M11 13l9-9M17 7l3 3M14 10l3 3" />
          </svg>
        </div>
      </div>
    </>
  );
}

/** Animated progress bar matching mobile's ProgressBar. */
interface ProgressBarProps {
  t: Theme;
  /** Duration in ms — default 10000 to match prototype. */
  duration?: number;
}

export function ProgressBar({ t, duration = 10000 }: ProgressBarProps) {
  const trackStyle: CSSProperties = {
    height: 3,
    backgroundColor: t.surface3,
    borderRadius: 99,
    overflow: 'hidden',
    width: '100%',
  };

  const fillStyle: CSSProperties = {
    height: '100%',
    backgroundColor: t.accent,
    borderRadius: 99,
    animation: `aegis-progress ${duration}ms linear forwards`,
  };

  return (
    <div style={trackStyle}>
      <div style={fillStyle} />
    </div>
  );
}
