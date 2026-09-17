/**
 * QR payload format for sharing an identity:
 *   v1: aegislink://v1/<AEGIS_ID>/<PUBLIC_KEY_BASE64>            (official relay)
 *   v2: aegislink://v2/<AEGIS_ID>/<PUBLIC_KEY_BASE64>/<ONION>/<MAILBOX_ROOT_BASE64>
 *
 * Parity with mobile/src/crypto/qr.ts (federation F1 brought the desktop copy up
 * to date: universal https links, malformed-escape safety, ID↔key binding and
 * the v2 relay segment — docs/FEDERATION-DESIGN.md D1). Keep the two in sync.
 */

import { decodeBase64 } from 'tweetnacl-util';
import { deriveAegisId } from './identity';
import { relayRefFromOnion, type RelayRef } from '../net/relayRef';

/**
 * decodeURIComponent throws a URIError on a malformed percent-escape. These
 * parsers run on attacker-controlled input (a scanned / pasted link), so a
 * throw here would crash the handler. Fail soft: a malformed escape means the
 * payload is not a valid link.
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

// ─── Universal (https) links — clickable in ANY app ──────────────────────────
// The payload travels in the URL FRAGMENT (#…): browsers never send fragments
// to the server, so the relay sees only "GET /a" (zero metadata).
export const UNIVERSAL_LINK_HOST = 'https://aegislink.duckdns.org';
const UNIVERSAL_CONTACT_PREFIX = `${UNIVERSAL_LINK_HOST}/a#`;
const UNIVERSAL_GROUP_PREFIX = `${UNIVERSAL_LINK_HOST}/g#`;

/** Map a universal contact/group link to its aegislink:// equivalent, or null. */
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

/** Never throws — malformed input returns false. */
export function keyMatchesAegisId(publicKeyB64: string, aegisId: string): boolean {
  try {
    return deriveAegisId(decodeBase64(publicKeyB64)) === aegisId.trim().toUpperCase();
  } catch {
    return false;
  }
}

/** `relay` null/undefined = official relay → v1; a custom relay → v2. */
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
  // Bind the ID to the key: the Aegis ID is derived from the public key, so a
  // payload pairing an ID with a non-matching key is malformed or tampered.
  if (!keyMatchesAegisId(publicKeyB64, aegisId)) return null;
  return { aegisId, publicKeyB64, relay, mailboxRootB64 };
}
