import type { CSSProperties } from 'react';
import type { Theme } from '../theme/vault';
import { I } from './icons';

interface Props {
  t: Theme;
  name: string;
  color?: string;
  size?: number;
  photoUri?: string | null;
  /** When true renders a group-style avatar (I.Users icon instead of initials when no image) */
  group?: boolean;
}

export function Avatar({ t, name, color, size = 44, photoUri, group }: Props) {
  const bg = color ?? t.surface2;
  const safeName = typeof name === 'string' ? name.trim() : '';
  const uri =
    photoUri ||
    (safeName.startsWith('file://') ||
    safeName.startsWith('content://') ||
    safeName.startsWith('data:') ||
    safeName.startsWith('http')
      ? safeName
      : null);

  const circleStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: '50%',
    backgroundColor: bg,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
  };

  if (uri) {
    return (
      <img
        src={uri}
        alt={safeName}
        style={{ ...circleStyle, objectFit: 'cover' }}
      />
    );
  }

  if (group) {
    return (
      <div style={circleStyle}>
        <I.Users size={Math.round(size * 0.52)} color={bg === t.surface2 ? t.accent : '#fff'} />
      </div>
    );
  }

  const initialChar = Array.from(safeName)[0] ?? '?';
  const isEmojiChar = (initialChar.codePointAt(0) ?? 0) > 255;
  const initial = isEmojiChar ? initialChar : initialChar.toUpperCase();
  const fontSize = isEmojiChar ? Math.round(size * 0.5) : Math.round(size * 0.42);

  const textStyle: CSSProperties = {
    fontFamily: isEmojiChar ? undefined : t.fontDisplay,
    fontWeight: '600',
    fontSize,
    color: bg === t.surface2 ? t.accent : '#fff',
    letterSpacing: isEmojiChar ? 0 : -0.4,
    userSelect: 'none',
  };

  return (
    <div style={circleStyle}>
      <span style={textStyle}>{initial}</span>
    </div>
  );
}
