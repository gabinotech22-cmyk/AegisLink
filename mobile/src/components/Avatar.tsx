import { View, Text, Image } from 'react-native';
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

/**
 * Circular avatar with an initial or actual photo/image URI support.
 */
export function Avatar({ t, name, color, size = 44, photoUri, group, seed }: Props) {
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

  if (uri) {
    return (
      <Image
        source={{ uri }}
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
        }}
      />
    );
  }

  if (group) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <I.Users size={Math.round(size * 0.52)} color={bg === t.surface2 ? t.accent : '#fff'} />
      </View>
    );
  }

  if (seed) {
    return (
      <View
        style={{
          width: size,
          height: size,
          borderRadius: size / 2,
          backgroundColor: t.surface2,
          alignItems: 'center',
          justifyContent: 'center',
          overflow: 'hidden',
        }}
      >
        <Identicon seed={seed} size={size} color={color} />
      </View>
    );
  }

  const initialChar = Array.from(safeName)[0] ?? '?';
  const isEmojiChar = (initialChar.codePointAt(0) ?? 0) > 255;
  const initial = isEmojiChar ? initialChar : initialChar.toUpperCase();
  const fontSize = isEmojiChar ? Math.round(size * 0.5) : Math.round(size * 0.42);
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: bg,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          fontFamily: isEmojiChar ? undefined : t.fontDisplay,
          fontWeight: '600',
          fontSize,
          color: bg === t.surface2 ? t.accent : '#fff',
          letterSpacing: isEmojiChar ? 0 : -0.4,
        }}
      >
        {initial}
      </Text>
    </View>
  );
}
