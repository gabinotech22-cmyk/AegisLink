/**
 * homeRelay — which relay hosts OUR identity and mailbox (federation,
 * docs/FEDERATION-DESIGN.md D2/D4).
 *
 * Parity with mobile/src/net/homeRelay.ts. The setting is per profile slot and
 * lives in the main-process secure storage
 * (`aegis.homeRelay[.<slot>]`, JSON `{ onion, since }`); `null`/absent = the
 * official relay, so every existing install behaves exactly as today. It is
 * read synchronously everywhere (`getHomeRelay()`) from an in-memory copy that
 * `hydrateHomeRelay()` fills at startup and on profile switch — BEFORE the
 * socket connects, so the very first connection already targets the right
 * relay. `setHomeRelay()` (migration, F5b) updates both.
 *
 * A custom home is `.onion`-only (D1): the identity socket, every HTTP call
 * (PoW, registration, prekeys, TURN credentials, blobs) and the mailbox all
 * target `http://<onion>` — on desktop the whole session already rides the
 * embedded Tor (main process SOCKS proxy), so `io()` / `fetch()` at the onion
 * just work; only the base URL changes (`homeRelayBaseUrl()`).
 *
 * `previousRelay` is the grace-period record of a migration (D4): the old
 * home keeps receiving until `until` so contacts that have not yet learnt the
 * new address still reach us.
 *
 * `relayFor(contact)` / `isForeign(contact)` are the ONLY way code decides where a
 * contact lives — never compare `relayOnion` strings by hand.
 */
import { logger } from '../utils/logger';
import { RELAY_URL, ONION_URL } from '../config';
import { getActiveDbSlot } from '../db/local';
import { canonicalRelay } from './officialRelay';
import { relayRefFromOnion, sameRelay, type RelayRef } from './relayRef';

const DEV = import.meta.env.DEV;

/** Same channel as identity secrets / mailbox roots (main-process safeStorage). */
const secureStorage = (): Window['aegis']['secureStorage'] => window.aegis.secureStorage;
const ss = {
  get: (key: string) => secureStorage().get(key),
  set: (key: string, value: string) => secureStorage().set(key, value),
};

export interface HomeRelaySetting {
  /** Custom home, or null = official. */
  relay: RelayRef | null;
  /** When the current home was adopted (0 for the official default). */
  since: number;
  /** Old home still receiving during the migration grace window (D4); relay null = official. */
  previous: { relay: RelayRef | null; until: number } | null;
}

const DEFAULT: HomeRelaySetting = { relay: null, since: 0, previous: null };

let current: HomeRelaySetting = DEFAULT;

function storageKey(): string {
  const slot = getActiveDbSlot();
  return `aegis.homeRelay${slot && slot !== 'self' ? `.${slot}` : ''}`;
}

/** Parse a persisted setting; anything malformed falls back to the official relay. */
export function parseHomeRelaySetting(raw: string | null): HomeRelaySetting {
  if (!raw) return DEFAULT;
  try {
    const p = JSON.parse(raw) as { onion?: unknown; since?: unknown; previous?: { onion?: unknown; until?: unknown } | null };
    const relay = canonicalRelay(relayRefFromOnion(p.onion));
    const since = typeof p.since === 'number' && p.since > 0 ? p.since : 0;
    let previous: HomeRelaySetting['previous'] = null;
    if (p.previous && typeof p.previous === 'object') {
      const until = typeof p.previous.until === 'number' ? p.previous.until : 0;
      // The official relay can be a "previous" home too (onion null = official);
      // a malformed onion is not a relay we can still drain from → dropped.
      const prevRelay = p.previous.onion === null ? null : canonicalRelay(relayRefFromOnion(p.previous.onion));
      const valid = p.previous.onion === null || prevRelay !== null;
      if (valid && until > 0 && !sameRelay(prevRelay, relay)) previous = { relay: prevRelay, until };
    }
    return { relay, since, previous };
  } catch {
    return DEFAULT;
  }
}

function serialize(s: HomeRelaySetting): string {
  return JSON.stringify({
    onion: s.relay?.onion ?? null,
    since: s.since,
    previous: s.previous ? { onion: s.previous.relay?.onion ?? null, until: s.previous.until } : null,
  });
}

/** Load the active slot's setting into memory. Idempotent; call before connect(). */
export async function hydrateHomeRelay(): Promise<HomeRelaySetting> {
  try {
    current = parseHomeRelaySetting(await ss.get(storageKey()));
  } catch (e) {
    if (DEV) logger.warn('[homeRelay] hydrate failed — official relay assumed', (e as Error).message);
    current = DEFAULT;
  }
  return current;
}

/** Persist + apply a new setting (migration, F5b). `relay` null = official. */
export async function setHomeRelay(next: HomeRelaySetting): Promise<void> {
  const normalized: HomeRelaySetting = { ...next, relay: canonicalRelay(next.relay) };
  await ss.set(storageKey(), serialize(normalized));
  current = normalized;
}

/**
 * Drop the in-memory copy (profile switch, tests): reads answer "official"
 * until the new slot is hydrated, never the previous profile's relay.
 */
export function resetHomeRelay(): void {
  current = DEFAULT;
}

/** The relay our identity is registered on and our mailbox binds to. null = official. */
export function getHomeRelay(): RelayRef | null {
  return current.relay;
}

/** Full setting (since / previous) for the settings screen and the migration. */
export function getHomeRelaySetting(): HomeRelaySetting {
  return current;
}

/** True when the home is a self-hosted (.onion) relay rather than the official one. */
export function isCustomHome(): boolean {
  return current.relay !== null;
}

/**
 * Base URL for HTTP against OUR relay. Custom home → `http://<onion>` (the
 * session proxies it through Tor); official → RELAY_URL exactly as before F5.
 */
export function homeRelayBaseUrl(): string {
  return current.relay ? `http://${current.relay.onion}` : RELAY_URL;
}

/**
 * Onion URL of OUR relay for the Tor-only transports (mailbox socket, ntfy
 * subscription). Custom home → its onion; official → the configured
 * ONION_URL (null in builds without one, which keeps mailbox mode fail-closed
 * as today).
 */
export function homeRelayOnionUrl(): string | null {
  return current.relay ? `http://${current.relay.onion}` : ONION_URL;
}

/** Where a contact's mailbox lives. null = official relay. */
export function relayFor(contact: { relayOnion?: string | null } | null | undefined): RelayRef | null {
  if (!contact?.relayOnion) return null;
  return canonicalRelay(relayRefFromOnion(contact.relayOnion));
}

/**
 * A contact is "foreign" when its mailbox lives on a relay other than our home.
 * Foreign contacts are reached only through the relay pool (disposable mailbox
 * socket on their relay); there is no aegisId transport to them at all.
 */
export function isForeign(contact: { relayOnion?: string | null } | null | undefined): boolean {
  return !sameRelay(relayFor(contact), getHomeRelay());
}
