import type { CSSProperties } from 'react';
import type { Theme } from '../theme/vault';
import { I } from './icons';
import { Identicon } from './Identicon';

interface Props {
  t: Theme;
  name: string;
  color?: string;
  size?: number;
  photoUri?: string | null;
  /** When true renders a group-style avatar (I.Users icon instead of initials when no image) */
  group?: boolean;
  /**
   * Deterministic seed (prefer publicKeyB64, fall back to aegisId) used to render
   * an identicon when there is no photo. If omitted, falls back to the legacy
   * initial+color circle so existing call sites without a seed keep working.
   */
  seed?: string;
}

/** True only for strings that an <img src> can actually load. Emoji glyphs
 *  (which Profile stores in avatarImage) are NOT URIs and must render as text. */
function isImageUri(v?: string | null): v is string {
  if (!v) return false;
  return (
    v.startsWith('file://') ||
    v.startsWith('content://') ||
    v.startsWith('data:') ||
    v.startsWith('blob:') ||
    v.startsWith('http://') ||
    v.startsWith('https://')
  );
}

export function Avatar({ t, name, color, size = 44, photoUri, group, seed }: Props) {
  const bg = color ?? t.surface2;
  const safeName = typeof name === 'string' ? name.trim() : '';

  // photoUri may be a real image URI, an emoji glyph (chosen in Profile), or null.
  // Only treat it as an <img> source when it's actually a loadable URI — otherwise
  // an emoji like "🛡️" would render as a broken image icon.
  const imgUri = isImageUri(photoUri) ? photoUri : isImageUri(safeName) ? safeName : null;
  const emojiGlyph = !imgUri && photoUri && !isImageUri(photoUri) ? photoUri : null;

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

  if (imgUri) {
    return (
      <img
        src={imgUri}
        alt={safeName}
        style={{ ...circleStyle, objectFit: 'cover' }}
      />
    );
  }

  if (emojiGlyph) {
    return (
      <div style={circleStyle}>
        <span style={{ fontSize: Math.round(size * 0.5), userSelect: 'none', lineHeight: 1 }}>
          {emojiGlyph}
        </span>
      </div>
    );
  }

  if (group) {
    return (
      <div style={circleStyle}>
        <I.Users size={Math.round(size * 0.52)} color={bg === t.surface2 ? t.accent : '#fff'} />
      </div>
    );
  }

  if (seed) {
    // The identicon sits on a t.surface2 background. Never pass that same
    // surface color as the identicon tint — the cells would collapse into the
    // background and the avatar would look empty. When no DISTINCT tint is
    // provided, let Identicon derive a visible seed-based hue.
    const tint = color && color !== t.surface2 ? color : undefined;
    return (
      <div style={{ ...circleStyle, backgroundColor: t.surface2 }}>
        <Identicon seed={seed} size={size} color={tint} />
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
