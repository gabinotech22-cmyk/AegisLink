import { useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import type { Theme } from '../theme/vault';
import { I } from './icons';

interface SectionProps {
  t: Theme;
  label: string;
  hint?: string;
  children: ReactNode;
}

export function Section({ t, label, hint, children }: SectionProps) {
  const wrapperStyle: CSSProperties = {
    marginBottom: 18,
  };

  const headerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingLeft: 22,
    paddingRight: 22,
    paddingBottom: 6,
  };

  const labelStyle: CSSProperties = {
    fontFamily: t.fontMono,
    fontSize: 10,
    color: t.textDim,
    letterSpacing: 1.1,
    margin: 0,
  };

  const hintStyle: CSSProperties = {
    fontFamily: t.fontMono,
    fontSize: 10,
    color: t.textFaint,
    letterSpacing: 0.6,
    margin: 0,
  };

  const bodyStyle: CSSProperties = {
    marginLeft: 18,
    marginRight: 18,
    backgroundColor: t.surface,
    borderRadius: t.radius,
    border: `1px solid ${t.border}`,
    overflow: 'hidden',
  };

  return (
    <div style={wrapperStyle}>
      <div style={headerStyle}>
        <span style={labelStyle}>{label}</span>
        {hint ? <span style={hintStyle}>{hint}</span> : null}
      </div>
      <div style={bodyStyle}>{children}</div>
    </div>
  );
}

interface RowProps {
  t: Theme;
  icon?: ReactNode;
  label: string;
  sub?: string;
  onPress?: () => void;
  trailing?: ReactNode;
  danger?: boolean;
  noBorder?: boolean;
}

export function Row({ t, icon, label, sub, onPress, trailing, danger, noBorder }: RowProps) {
  const [hovered, setHovered] = useState(false);
  const labelColor = danger ? t.danger : t.text;

  const rowStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 12,
    paddingBottom: 12,
    borderBottom: noBorder ? 'none' : `1px solid ${t.divider}`,
    backgroundColor: onPress && hovered ? t.surface2 : 'transparent',
    cursor: onPress ? 'pointer' : 'default',
    transition: 'background-color 0.1s',
    boxSizing: 'border-box',
  };

  const content = (
    <>
      {icon ? (
        <div style={{ width: 22, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </div>
      ) : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: t.font, fontSize: 14, color: labelColor, display: 'block' }}>{label}</span>
        {sub ? (
          <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2, display: 'block' }}>{sub}</span>
        ) : null}
      </div>
      {trailing ?? (onPress ? <I.Chevron size={14} color={t.textFaint} /> : null)}
    </>
  );

  if (onPress) {
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={onPress}
        onKeyDown={(e) => e.key === 'Enter' && onPress()}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={rowStyle}
        aria-label={label}
      >
        {content}
      </div>
    );
  }

  return <div style={rowStyle}>{content}</div>;
}

interface ToggleProps {
  t: Theme;
  icon?: ReactNode;
  label: string;
  sub?: string;
  value: boolean;
  onChange: (v: boolean) => void;
  noBorder?: boolean;
  disabled?: boolean;
}

export function Toggle({ t, icon, label, sub, value, onChange, noBorder, disabled }: ToggleProps) {
  const rowStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingLeft: 16,
    paddingRight: 16,
    paddingTop: 11,
    paddingBottom: 11,
    borderBottom: noBorder ? 'none' : `1px solid ${t.divider}`,
    opacity: disabled ? 0.45 : 1,
    boxSizing: 'border-box',
  };

  const trackStyle: CSSProperties = {
    width: 44,
    height: 26,
    borderRadius: 99,
    backgroundColor: value ? t.accent : t.surface3,
    display: 'flex',
    alignItems: 'center',
    padding: '0 3px',
    boxSizing: 'border-box',
    cursor: disabled ? 'not-allowed' : 'pointer',
    flexShrink: 0,
    border: 'none',
    transition: 'background-color 0.2s',
  };

  const thumbStyle: CSSProperties = {
    width: 20,
    height: 20,
    borderRadius: '50%',
    backgroundColor: value ? t.accentInk : '#fff',
    marginLeft: value ? 'auto' : 0,
    transition: 'margin 0.2s, background-color 0.2s',
  };

  return (
    <div style={rowStyle}>
      {icon && (
        <div style={{ width: 24, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {icon}
        </div>
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <span style={{ fontFamily: t.font, fontSize: 14, color: t.text, display: 'block' }}>{label}</span>
        {sub ? (
          <span style={{ fontFamily: t.font, fontSize: 12, color: t.textDim, marginTop: 2, display: 'block' }}>{sub}</span>
        ) : null}
      </div>
      <button
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => !disabled && onChange(!value)}
        style={trackStyle}
      >
        <div style={thumbStyle} />
      </button>
    </div>
  );
}

interface StatProps {
  t: Theme;
  label: string;
  val: string;
}

export function Stat({ t, label, val }: StatProps) {
  const containerStyle: CSSProperties = {
    padding: 12,
    backgroundColor: t.surface2,
    borderRadius: t.radiusS,
  };

  return (
    <div style={containerStyle}>
      <span style={{ fontFamily: t.fontMono, fontSize: 9, color: t.textDim, letterSpacing: 1.1, display: 'block' }}>
        {label}
      </span>
      <span
        style={{
          fontFamily: t.fontDisplay,
          fontSize: 22,
          color: t.text,
          marginTop: 2,
          fontWeight: '600',
          letterSpacing: -0.4,
          display: 'block',
        }}
      >
        {val}
      </span>
    </div>
  );
}
