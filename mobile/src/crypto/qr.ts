/**
 * QR payload format for sharing an identity:
 *   v1: aegislink://v1/<AEGIS_ID>/<PUBLIC_KEY_BASE64>            (official relay)
 *   v2: aegislink://v2/<AEGIS_ID>/<PUBLIC_KEY_BASE64>/<ONION>/<MAILBOX_ROOT_BASE64>
 *
 * v2 carries the relay that hosts the contact's mailbox (docs/FEDERATION-DESIGN.md
 * D1). A v1 payload means "official relay" and is emitted whenever the sharer
 * is on it, so nothing changes for today's users; v2 is emitted only for a
 * custom relay. `aegislink://` doubles as a deep-link scheme so the app can be
 * opened directly from a scanned URL on iOS/Android.
 */

import { decodeBase64 } from 'tweetnacl-util';
import { keyMatchesAegisId } from './aegisId';
import { relayRefFromOnion, type RelayRef } from '../net/relayRef';

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
const SCHEME_V2 = 'aegislink://v2/';
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

/**
 * QR payload for an identity. `relay` null/undefined = official relay → v1 (the
 * form every shipped client understands); a custom relay → v2.
 */
/**
 * A v2 (custom relay) address ALSO carries the owner's mailbox root (F3b): a
 * stranger on another relay has no other way to derive the mailbox to write
 * the very first message to (the SimpleX model — the address includes the
 * queue). Throws if a relay is given without the root: a v2 link that cannot
 * be written to must never be emitted.
 */
export function encodeIdentityQR(aegisId: string, publicKeyB64: string, relay?: RelayRef | null, mailboxRootB64?: string | null): string {
  if (relay) {
    if (!mailboxRootB64) throw new Error('encodeIdentityQR: a custom relay address needs the mailbox root');
    return `${SCHEME_V2}${aegisId}/${encodeURIComponent(publicKeyB64)}/${relay.onion}/${encodeURIComponent(mailboxRootB64)}`;
  }
  return `${SCHEME}${aegisId}/${encodeURIComponent(publicKeyB64)}`;
}

/** https form of the identity link — clickable outside AegisLink. */
export function encodeIdentityLink(aegisId: string, publicKeyB64: string, relay?: RelayRef | null, mailboxRootB64?: string | null): string {
  if (relay) {
    if (!mailboxRootB64) throw new Error('encodeIdentityLink: a custom relay address needs the mailbox root');
    return `${UNIVERSAL_CONTACT_PREFIX}v2/${aegisId}/${encodeURIComponent(publicKeyB64)}/${relay.onion}/${encodeURIComponent(mailboxRootB64)}`;
  }
  return `${UNIVERSAL_CONTACT_PREFIX}v1/${aegisId}/${encodeURIComponent(publicKeyB64)}`;
}

export interface ParsedIdentityQR {
  aegisId: string;
  publicKeyB64: string;
  /** null = official relay (every v1 payload; a v2 payload always names one). */
  relay: RelayRef | null;
  /** Owner's mailbox root (base64, 32 bytes) — present on every v2 payload, null on v1. */
  mailboxRootB64: string | null;
}

export function parseIdentityQR(raw: string): ParsedIdentityQR | null {
  if (typeof raw !== 'string') return null;
  const normalized = universalToScheme(raw) ?? raw;
  let rest: string;
  let v2: boolean;
  if (normalized.startsWith(SCHEME)) { rest = normalized.slice(SCHEME.length); v2 = false; }
  else if (normalized.startsWith(SCHEME_V2)) { rest = normalized.slice(SCHEME_V2.length); v2 = true; }
  else return null;
  const slash = rest.indexOf('/');
  if (slash < 0) return null;
  const aegisId = rest.slice(0, slash).trim().toUpperCase();
  let keyPart = rest.slice(slash + 1);
  let relay: RelayRef | null = null;
  let mailboxRootB64: string | null = null;
  if (v2) {
    // v2 = <key>/<onion>/<root>; the onion is validated strictly and the root
    // must decode to exactly 32 bytes — a v2 payload missing either is rejected
    // outright, never downgraded to "official".
    const segs = keyPart.split('/');
    if (segs.length !== 3) return null;
    relay = relayRefFromOnion(segs[1]);
    if (!relay) return null;
    const decodedRoot = safeDecodeURIComponent(segs[2]);
    if (decodedRoot === null) return null;
    try {
      if (decodeBase64(decodedRoot).length !== 32) return null;
    } catch {
      return null;
    }
    mailboxRootB64 = decodedRoot;
    keyPart = segs[0];
  } else if (keyPart.includes('/')) {
    return null; // v1 has exactly two segments
  }
  const decodedKey = safeDecodeURIComponent(keyPart);
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
  return { aegisId, publicKeyB64, relay, mailboxRootB64 };
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
