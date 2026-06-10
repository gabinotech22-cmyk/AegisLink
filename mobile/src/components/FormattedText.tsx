/**
 * FormattedText — Markdown-lite renderer for chat bubbles.
 *
 * Supported syntax:
 *   *text*        → bold
 *   _text_        → italic
 *   ~text~        → strikethrough
 *   `text`        → monospace with subtle background
 *   https://...   → tappable link (t.accent color)
 *   @aegisId      → mention highlight (t.accent color)
 */

import { Text, Pressable } from 'react-native';
import { Linking } from 'react-native';
import type { TextStyle } from 'react-native';
import type { Theme } from '../theme/vault';

interface Props {
  body: string;
  t: Theme;
  style?: TextStyle;
  selectable?: boolean;
}

type Segment =
  | { kind: 'plain'; text: string }
  | { kind: 'bold'; text: string }
  | { kind: 'italic'; text: string }
  | { kind: 'strike'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'url'; text: string; href: string }
  | { kind: 'mention'; text: string };

// Combined regex: order matters — code first (avoids greedy overlap), then url, mention, bold, italic, strike.
// aegislink:// is linkified ONLY for group invites (group/v1/): other scheme
// URLs — notably aegislink://panic, which remote-wipes the device — must
// never become tappable from a message body an attacker controls.
const TOKEN_RE =
  /(`[^`]+`)|(\bhttps?:\/\/[^\s<>"')\]]+|\baegislink:\/\/group\/v1\/[^\s<>"')\]]+)|((?:^|\s)@[A-Za-z0-9_-]{3,})|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)/g;

function parse(body: string): Segment[] {
  const segments: Segment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  TOKEN_RE.lastIndex = 0;

  while ((match = TOKEN_RE.exec(body)) !== null) {
    const [full, code, url, mention, bold, italic, strike] = match;

    // Push preceding plain text
    if (match.index > lastIndex) {
      segments.push({ kind: 'plain', text: body.slice(lastIndex, match.index) });
    }

    if (code) {
      segments.push({ kind: 'code', text: full.slice(1, -1) });
    } else if (url) {
      segments.push({ kind: 'url', text: url, href: url });
    } else if (mention) {
      // The mention group may have a leading space — preserve it as plain text
      const trimmed = full.trimStart();
      const leading = full.slice(0, full.length - trimmed.length);
      if (leading) segments.push({ kind: 'plain', text: leading });
      segments.push({ kind: 'mention', text: trimmed });
    } else if (bold) {
      segments.push({ kind: 'bold', text: full.slice(1, -1) });
    } else if (italic) {
      segments.push({ kind: 'italic', text: full.slice(1, -1) });
    } else if (strike) {
      segments.push({ kind: 'strike', text: full.slice(1, -1) });
    }

    lastIndex = match.index + full.length;
  }

  if (lastIndex < body.length) {
    segments.push({ kind: 'plain', text: body.slice(lastIndex) });
  }

  return segments;
}

export function FormattedText({ body, t, style, selectable }: Props) {
  const segments = parse(body);

  return (
    <Text selectable={selectable} style={style}>
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'plain':
            return <Text key={i}>{seg.text}</Text>;

          case 'bold':
            return (
              <Text key={i} style={{ fontWeight: '700' }}>
                {seg.text}
              </Text>
            );

          case 'italic':
            return (
              <Text key={i} style={{ fontStyle: 'italic' }}>
                {seg.text}
              </Text>
            );

          case 'strike':
            return (
              <Text key={i} style={{ textDecorationLine: 'line-through' }}>
                {seg.text}
              </Text>
            );

          case 'code':
            return (
              <Text
                key={i}
                style={{
                  fontFamily: t.fontMono,
                  backgroundColor: t.surface2,
                  borderRadius: 3,
                  // paddingHorizontal on inline Text is not supported on RN;
                  // we approximate the inset with letter spacing.
                  letterSpacing: 0.2,
                }}
              >
                {'​'}{seg.text}{'​'}
              </Text>
            );

          case 'url':
            return (
              <Text
                key={i}
                style={{ color: t.accent, textDecorationLine: 'underline' }}
                accessibilityRole="link"
                accessibilityLabel={seg.href}
                onPress={() => Linking.openURL(seg.href).catch(() => {})}
              >
                {seg.text}
              </Text>
            );

          case 'mention':
            return (
              <Text key={i} style={{ color: t.accent, fontWeight: '600' }}>
                {seg.text}
              </Text>
            );

          default:
            return null;
        }
      })}
    </Text>
  );
}
