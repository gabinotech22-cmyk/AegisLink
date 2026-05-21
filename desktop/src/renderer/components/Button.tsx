import { useState } from 'react';
import type { CSSProperties } from 'react';
import type { Theme } from '../theme/vault';

interface BtnProps {
  t: Theme;
  label: string;
  onPress?: () => void;
  disabled?: boolean;
  full?: boolean;
  style?: CSSProperties;
}

export function PrimaryButton({ t, label, onPress, disabled, full = true, style }: BtnProps) {
  const [pressed, setPressed] = useState(false);

  const baseStyle: CSSProperties = {
    backgroundColor: t.accent,
    opacity: disabled ? 0.5 : pressed ? 0.85 : 1,
    borderRadius: t.radius,
    paddingLeft: 20,
    paddingRight: 20,
    paddingTop: 15,
    paddingBottom: 15,
    alignSelf: full ? 'stretch' : 'flex-start',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: 'none',
    width: full ? '100%' : undefined,
    boxSizing: 'border-box',
    transition: 'opacity 0.1s',
    ...style,
  };

  const textStyle: CSSProperties = {
    color: t.accentInk,
    fontFamily: t.font,
    fontSize: 15,
    fontWeight: '600',
    letterSpacing: -0.15,
    margin: 0,
  };

  return (
    <button
      onClick={onPress}
      disabled={disabled}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      style={baseStyle}
      aria-label={label}
    >
      <span style={textStyle}>{label}</span>
    </button>
  );
}

export function GhostButton({ t, label, onPress, disabled, full = true, style }: BtnProps) {
  const [pressed, setPressed] = useState(false);

  const baseStyle: CSSProperties = {
    backgroundColor: 'transparent',
    border: `1px solid ${t.borderStrong}`,
    opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
    borderRadius: t.radius,
    paddingLeft: 20,
    paddingRight: 20,
    paddingTop: 14,
    paddingBottom: 14,
    alignSelf: full ? 'stretch' : 'flex-start',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: disabled ? 'not-allowed' : 'pointer',
    width: full ? '100%' : undefined,
    boxSizing: 'border-box',
    transition: 'opacity 0.1s',
    ...style,
  };

  const textStyle: CSSProperties = {
    color: t.text,
    fontFamily: t.font,
    fontSize: 14,
    fontWeight: '500',
    margin: 0,
  };

  return (
    <button
      onClick={onPress}
      disabled={disabled}
      onMouseDown={() => setPressed(true)}
      onMouseUp={() => setPressed(false)}
      onMouseLeave={() => setPressed(false)}
      style={baseStyle}
      aria-label={label}
    >
      <span style={textStyle}>{label}</span>
    </button>
  );
}
