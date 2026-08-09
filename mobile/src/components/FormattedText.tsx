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
  /**
   * True when this text is rendered on the OUTGOING (accent-colored) bubble.
   * There, links/mentions painted with t.accent are invisible because the
   * bubble background IS t.accent (bubbleOut === accent in the Vault theme).
   * When set, links/mentions inherit the bubble's text color instead (still
   * underlined/bold so they read as links), fixing the "blank own bubble" bug.
   */
  onAccent?: boolean;
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
//
// aegislink:// is linkified against an ALLOW-LIST, never a deny-list: group
// invites (group/v1/), contact links (v1/) and channel invites (channel/).
// Everything else stays plain text — notably aegislink://panic, which
// remote-wipes the device and must never become tappable from a message body an
// attacker controls. Adding a new link type here means adding it to
// handleDeepLink in App.tsx too, behind a confirmation step; a link someone
// else sent must never act on a single tap.
//
// Channel invites were missing (audit 2026-08-08) and rendered as dead text
// while group invites right next to them were tappable. Format:
// aegislink://channel/<b32 id>/<b32 pub>[?k=…][&p=1] — no `v1` segment, which
// is why the old pattern skipped it.
const TOKEN_RE =
  /(`[^`]+`)|(\bhttps?:\/\/[^\s<>"')\]]+|\baegislink:\/\/(?:(?:group\/)?v1|channel)\/[^\s<>"')\]]+)|((?:^|\s)@[A-Za-z0-9_-]{3,})|(\*[^*\n]+\*)|(_[^_\n]+_)|(~[^~\n]+~)/g;

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

export function FormattedText({ body, t, style, selectable, onAccent }: Props) {
  const segments = parse(body);
  // On the accent bubble, let links/mentions inherit the bubble text color
  // (undefined → inherits from the parent <Text style={style}>); elsewhere use
  // the accent color as the link/mention highlight.
  const highlightColor = onAccent ? undefined : t.accent;

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
                style={{ color: highlightColor, textDecorationLine: 'underline' }}
                accessibilityRole="link"
                accessibilityLabel={seg.href}
                onPress={() => {
                  // Our own universal links open in-app directly (via their
                  // scheme equivalent) instead of bouncing through the browser.
                  const { universalToScheme } = require('../crypto/qr') as typeof import('../crypto/qr');
                  void Linking.openURL(universalToScheme(seg.href) ?? seg.href).catch(() => {});
                }}
              >
                {seg.text}
              </Text>
            );

          case 'mention':
            return (
              <Text key={i} style={{ color: highlightColor, fontWeight: '600' }}>
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
