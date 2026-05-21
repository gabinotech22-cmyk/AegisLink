import type { CSSProperties, ReactNode } from 'react';
import type { Theme } from '../theme/vault';

interface Props {
  t: Theme;
  title: string;
  left?: ReactNode;
  right?: ReactNode;
  big?: boolean;
  style?: CSSProperties;
}

export function TopBar({ t, title, left, right, big = false, style }: Props) {
  const containerStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingLeft: 18,
    paddingRight: 18,
    paddingTop: 14,
    paddingBottom: 12,
    minHeight: 52,
    borderBottom: big ? 'none' : `1px solid ${t.divider}`,
    boxSizing: 'border-box',
    ...style,
  };

  const leftGroupStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
  };

  const titleStyle: CSSProperties = {
    fontFamily: t.fontDisplay,
    fontWeight: '600',
    fontSize: big ? 28 : 18,
    letterSpacing: -0.5,
    color: t.text,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    margin: 0,
  };

  const rightGroupStyle: CSSProperties = {
    display: 'flex',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  };

  return (
    <div style={containerStyle}>
      <div style={leftGroupStyle}>
        {left}
        <span style={titleStyle}>{title}</span>
      </div>
      <div style={rightGroupStyle}>{right}</div>
    </div>
  );
}
