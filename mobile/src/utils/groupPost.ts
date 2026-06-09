/**
 * Scheduled group post wire-format helpers.
 *
 * A scheduled post travels as a normal E2EE group message whose TEXT portion
 * starts with a compact marker:
 *
 *     [post:<flags>]Texto del anuncio
 *
 * flags (subset, order-independent):
 *   g — published "as the group" (announcement authored by the group identity)
 *   p — pinned/highlighted on publish
 *   s — silent: receivers skip the local notification banner
 *   r — replies discouraged (rendered as read-only announcement)
 *
 * Image posts keep the existing media pipeline prefix FIRST, then the marker
 * in the caption portion: `[image:data:…][post:gp]Texto`. Receivers already
 * split the image prefix off (client.ts), so bubble/notification code only
 * ever sees the `[post:…]Texto` part.
 *
 * Unknown flags are ignored (forward-compatible). A body without the marker
 * is a regular message — parse returns isPost:false and the text untouched.
 */

export interface GroupPostMeta {
  asGroup: boolean;
  pinned: boolean;
  silent: boolean;
  repliesOff: boolean;
}

export interface ParsedGroupPost extends GroupPostMeta {
  isPost: boolean;
  /** Body with the marker stripped (or the original body when not a post). */
  text: string;
}

const MARKER_PREFIX = '[post:';

export function buildGroupPostBody(text: string, meta: GroupPostMeta): string {
  let flags = '';
  if (meta.asGroup) flags += 'g';
  if (meta.pinned) flags += 'p';
  if (meta.silent) flags += 's';
  if (meta.repliesOff) flags += 'r';
  return `${MARKER_PREFIX}${flags}]${text}`;
}

export function parseGroupPostMarker(body: string): ParsedGroupPost {
  const none: ParsedGroupPost = {
    isPost: false, asGroup: false, pinned: false, silent: false, repliesOff: false, text: body,
  };
  if (!body.startsWith(MARKER_PREFIX)) return none;
  const close = body.indexOf(']');
  if (close === -1) return none;
  const flags = body.slice(MARKER_PREFIX.length, close);
  // Flags must be short and alphabetic — anything else is regular text that
  // merely looks like a marker (e.g. user typed "[post:algo]").
  if (flags.length > 8 || !/^[a-z]*$/.test(flags)) return none;
  return {
    isPost: true,
    asGroup: flags.includes('g'),
    pinned: flags.includes('p'),
    silent: flags.includes('s'),
    repliesOff: flags.includes('r'),
    text: body.slice(close + 1),
  };
}

/** Strip the marker for places that only need display text (previews, notifications). */
export function stripGroupPostMarker(body: string): string {
  return parseGroupPostMarker(body).text;
}
