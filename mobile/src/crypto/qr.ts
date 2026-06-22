/**
 * QR payload format for sharing an identity:
 *   aegislink://v1/<AEGIS_ID>/<PUBLIC_KEY_BASE64>
 *
 * `aegislink://` doubles as a deep-link scheme so the app can be opened
 * directly from a scanned URL on iOS/Android.
 */

import { keyMatchesAegisId } from './aegisId';

/**
 * decodeURIComponent throws a URIError on a malformed percent-escape (a lone
 * `%`, `%g`, a truncated `%c0`, …). These parsers run on attacker-controlled
 * input (a scanned QR / pasted link), so a throw here would crash the scan
 * handler. Fail soft: a malformed escape means the payload is not a valid link.
 */
function safeDecodeURIComponent(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;
const SCHEME = 'aegislink://v1/';
const GROUP_SCHEME = 'aegislink://group/v1/';

// ─── Universal (https) links — clickable in ANY app ──────────────────────────
// The relay serves /g and /a as Android App Links landings. The payload
// travels in the URL FRAGMENT (#…): browsers never send fragments to the
// server, so the relay sees only "GET /g" — no group id, name, admin or
// contact id ever reaches it (zero metadata). Android App Links deliver the
// full URI (fragment included) to the app.
export const UNIVERSAL_LINK_HOST = 'https://aegislink.duckdns.org';
const UNIVERSAL_GROUP_PREFIX = `${UNIVERSAL_LINK_HOST}/g#`;
const UNIVERSAL_CONTACT_PREFIX = `${UNIVERSAL_LINK_HOST}/a#`;

/**
 * Map a universal link to its aegislink:// scheme equivalent, or null when
 * the URL is not one of ours. There is deliberately NO universal form for
 * aegislink://panic — the wipe trigger must never be reachable from an https
 * link someone else can dress up.
 */
export function universalToScheme(url: string): string | null {
  if (typeof url !== 'string') return null;
  if (url.startsWith(UNIVERSAL_GROUP_PREFIX)) {
    return 'aegislink://group/' + url.slice(UNIVERSAL_GROUP_PREFIX.length);
  }
  if (url.startsWith(UNIVERSAL_CONTACT_PREFIX)) {
    return 'aegislink://' + url.slice(UNIVERSAL_CONTACT_PREFIX.length);
  }
  return null;
}

export function encodeIdentityQR(aegisId: string, publicKeyB64: string): string {
  return `${SCHEME}${aegisId}/${encodeURIComponent(publicKeyB64)}`;
}

/** https form of the identity link — clickable outside AegisLink. */
export function encodeIdentityLink(aegisId: string, publicKeyB64: string): string {
  return `${UNIVERSAL_CONTACT_PREFIX}v1/${aegisId}/${encodeURIComponent(publicKeyB64)}`;
}

export interface ParsedIdentityQR {
  aegisId: string;
  publicKeyB64: string;
}

export function parseIdentityQR(raw: string): ParsedIdentityQR | null {
  if (typeof raw !== 'string') return null;
  const normalized = universalToScheme(raw) ?? raw;
  if (!normalized.startsWith(SCHEME)) return null;
  const rest = normalized.slice(SCHEME.length);
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const aegisId = rest.slice(0, slash).trim().toUpperCase();
  const decodedKey = safeDecodeURIComponent(rest.slice(slash + 1));
  if (decodedKey === null) return null;
  const publicKeyB64 = decodedKey.trim();
  if (!AEGIS_ID_RE.test(aegisId)) return null;
  // base64-encoded 32-byte Curve25519 key is exactly 44 chars.
  if (publicKeyB64.length !== 44) return null;
  // Cryptographically bind the ID to the key. The Aegis ID is derived from the
  // public key, so a payload pairing an ID with a non-matching key is malformed
  // or tampered (e.g. someone's ID shown over a different key) — reject it. A
  // legitimate QR, generated via encodeIdentityQR from a real identity, always
  // passes because there aegisId === deriveAegisId(publicKey) by construction.
  if (!keyMatchesAegisId(publicKeyB64, aegisId)) return null;
  return { aegisId, publicKeyB64 };
}

// ─── Group invite links ───────────────────────────────────────────────────────
// Format: aegislink://group/v1/<groupId>/<groupName>/<adminId>
// Each segment is URI-encoded. groupId and adminId are opaque identifiers;
// groupName is display-only and not cryptographically bound to the group.

export interface ParsedGroupInvite {
  groupId: string;
  groupName: string;
  adminId: string;
}

export function encodeGroupInviteLink(
  groupId: string,
  groupName: string,
  adminId: string,
): string {
  return (
    GROUP_SCHEME +
    encodeURIComponent(groupId) +
    '/' +
    encodeURIComponent(groupName) +
    '/' +
    encodeURIComponent(adminId)
  );
}

/** https form of the group invite — clickable outside AegisLink. */
export function encodeGroupInviteLinkUniversal(
  groupId: string,
  groupName: string,
  adminId: string,
): string {
  return (
    `${UNIVERSAL_GROUP_PREFIX}v1/` +
    encodeURIComponent(groupId) +
    '/' +
    encodeURIComponent(groupName) +
    '/' +
    encodeURIComponent(adminId)
  );
}

export function parseGroupInviteLink(url: string): ParsedGroupInvite | null {
  if (typeof url !== 'string') return null;
  const normalized = universalToScheme(url) ?? url;
  if (!normalized.startsWith(GROUP_SCHEME)) return null;
  const rest = normalized.slice(GROUP_SCHEME.length);
  const parts = rest.split('/');
  if (parts.length < 3) return null;
  const groupId = safeDecodeURIComponent(parts[0])?.trim();
  const groupName = safeDecodeURIComponent(parts[1])?.trim();
  const adminId = safeDecodeURIComponent(parts[2])?.trim();
  if (!groupId || !groupName || !adminId) return null;
  return { groupId, groupName, adminId };
}
