/**
 * RelayRef — the relay half of a contact address (docs/FEDERATION-DESIGN.md D1).
 *
 * A user's address is `aegisId` (identity, the brand) + the relay that hosts
 * their mailbox. Relays are identified ONLY by their Tor v3 onion host: the
 * onion address *is* the server's public key, so there is no CA, no DNS, no
 * pin set and no IP to leak. `null` means "the official AegisLink relay".
 *
 * Pure module: no config, no I/O. Byte-identical copy in
 * desktop/src/renderer/net/relayRef.ts — both suites assert the same
 * known-answer vectors so the two parsers can never drift apart.
 */

export interface RelayRef {
  /** Lowercase `<56 base32 chars>.onion`, no scheme, no port, no path. */
  onion: string;
}

/** Tor v3 hidden-service host: 56 chars of base32 (a–z, 2–7) + `.onion`. */
export const ONION_V3_RE = /^[a-z2-7]{56}\.onion$/;

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * Normalize user/QR input into a canonical onion host, or null if it is not a
 * valid v3 onion. Tolerates a scheme (`http://`, `https://`, `ws://`), a port,
 * a trailing slash/path and mixed case — the canonical form drops all of them.
 * Never throws.
 */
export function normalizeOnion(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  let s = raw.trim().toLowerCase();
  if (s.length === 0 || s.length > 512) return null;
  s = s.replace(/^[a-z]+:\/\//, '');
  const slash = s.indexOf('/');
  if (slash >= 0) s = s.slice(0, slash);
  const colon = s.indexOf(':');
  if (colon >= 0) s = s.slice(0, colon);
  return ONION_V3_RE.test(s) ? s : null;
}

/** Build a RelayRef from any onion spelling; null when not a valid v3 onion. */
export function relayRefFromOnion(raw: unknown): RelayRef | null {
  const onion = normalizeOnion(raw);
  return onion ? { onion } : null;
}

/** Two refs (or nulls = official) name the same relay. */
export function sameRelay(a: RelayRef | null | undefined, b: RelayRef | null | undefined): boolean {
  return (a?.onion ?? null) === (b?.onion ?? null);
}

/**
 * Short, human-scannable label for a relay: `abcdef…uvwxyz.onion`. The full
 * onion is always available on tap/copy; this is for lists and captions.
 */
export function shortOnion(onion: string): string {
  const host = onion.endsWith('.onion') ? onion.slice(0, -'.onion'.length) : onion;
  if (host.length <= 14) return onion;
  return `${host.slice(0, 6)}…${host.slice(-6)}.onion`;
}

export interface ContactAddress {
  aegisId: string;
  /** null = official relay. */
  relay: RelayRef | null;
}

/**
 * Parse a typed contact address: `ABC-DEFG-HJKL` (official relay) or
 * `ABC-DEFG-HJKL@<onion>`. Case-insensitive on both halves. Null on anything
 * else — including a valid id with an INVALID relay (fail closed: we never
 * silently fall back to the official relay when the user named another one).
 */
export function parseContactAddress(raw: unknown): ContactAddress | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (s.length === 0 || s.length > 256) return null;
  const at = s.indexOf('@');
  const idPart = (at >= 0 ? s.slice(0, at) : s).trim().toUpperCase();
  if (!AEGIS_ID_RE.test(idPart)) return null;
  if (at < 0) return { aegisId: idPart, relay: null };
  const relay = relayRefFromOnion(s.slice(at + 1));
  if (!relay) return null;
  return { aegisId: idPart, relay };
}

/** Inverse of parseContactAddress: `ID` for the official relay, `ID@onion` otherwise. */
export function formatContactAddress(aegisId: string, relay: RelayRef | null | undefined): string {
  return relay ? `${aegisId}@${relay.onion}` : aegisId;
}
