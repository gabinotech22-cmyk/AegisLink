/**
 * homeRelay — which relay hosts OUR identity and mailbox (federation,
 * docs/FEDERATION-DESIGN.md D2/D4).
 *
 * The setting is per profile slot and lives in SecureStore
 * (`aegis.homeRelay[.<slot>]`, JSON `{ onion, since }`); `null`/absent = the
 * official relay, so every existing install behaves exactly as today. It is
 * read synchronously everywhere (`getHomeRelay()`) from an in-memory copy that
 * `hydrateHomeRelay()` fills at startup and on profile switch — BEFORE the
 * socket connects, so the very first connection already targets the right
 * relay. `setHomeRelay()` (migration, F5b) updates both.
 *
 * Every home is reached over Tor (Tor always-on): a custom home is `.onion`-only
 * (D1), and the official home is reached at its onion (`ONION_URL`) too — the
 * identity socket, every HTTP call (PoW, registration, prekeys, TURN
 * credentials, blobs, push bindings) and the mailbox all target
 * `http://<onion>` over the embedded Tor — see `homeRelayBaseUrl()` /
 * `net/relayHttp.ts` / `socket/client.ts`. The clearnet `SERVER_URL` is used
 * only by dev builds without an onion (config.ts refuses a production build
 * without one).
 *
 * `previousRelay` is the grace-period record of a migration (D4): the old
 * home keeps receiving until `until` so contacts that have not yet learnt the
 * new address still reach us.
 *
 * `relayFor(contact)` / `isForeign(contact)` are the ONLY way code decides where a
 * contact lives — never compare `relayOnion` strings by hand.
 */
import { logger } from '../utils/logger';
import { ss } from '../utils/secureStore';
import { SERVER_URL, ONION_URL } from '../config';
import { canonicalRelay, OFFICIAL_RELAY } from './officialRelay';
import { relayRefFromOnion, sameRelay, type RelayRef } from './relayRef';

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
  // Lazy require: db/core pulls expo-sqlite, which not every importer of this
  // module (pure helpers, tests) can load.
  const { getActiveDbSlot } = require('../db/core') as { getActiveDbSlot: () => string };
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
    if (__DEV__) logger.warn('[homeRelay] hydrate failed — official relay assumed', (e as Error).message);
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
 * Base URL for HTTP against the OFFICIAL relay: its onion over the embedded Tor.
 * `SERVER_URL` (clearnet) only when no onion is configured — dev builds and a
 * release against a loopback dev relay (config.ts guards production).
 */
export function officialRelayBaseUrl(): string {
  return ONION_URL || SERVER_URL;
}

/**
 * Base URL for HTTP against OUR relay. Custom home → `http://<onion>`; official
 * → its onion (`officialRelayBaseUrl`). Both ride the embedded Tor via
 * net/relayHttp.
 */
export function homeRelayBaseUrl(): string {
  return current.relay ? `http://${current.relay.onion}` : officialRelayBaseUrl();
}

/**
 * Onion URL of OUR relay for the Tor-only transports (mailbox socket, ntfy
 * subscription). Custom home → its onion; official → the configured
 * ONION_URL (null in builds without one, which keeps mailbox mode fail-closed
 * as today).
 */
export function homeRelayOnionUrl(): string | null {
  return current.relay ? `http://${current.relay.onion}` : ONION_URL || null;
}

/** Where a contact's mailbox lives. null = official relay. */
export function relayFor(contact: { relayOnion?: string | null } | null | undefined): RelayRef | null {
  if (!contact?.relayOnion) return null;
  return canonicalRelay(relayRefFromOnion(contact.relayOnion));
}

/**
 * The CONCRETE relay a contact's mailbox lives on — the official one included
 * (unlike `relayFor`, whose null means "official"). This is what a transport
 * needs to reach a foreign contact: when OUR home is a self-hosted relay, a
 * contact on the official relay is foreign and must be reached through the
 * pool on the official onion. null only when no official onion is configured
 * (a build without ONION_URL cannot reach anyone off its home). Found in the
 * F7 device test: `deliverToForeignRelay` treated that null as "no relay" and
 * every message from a self-hosted home to the official relay failed.
 */
export function resolveRelay(contact: { relayOnion?: string | null } | null | undefined): RelayRef | null {
  return relayFor(contact) ?? OFFICIAL_RELAY;
}

/**
 * A contact is "foreign" when its mailbox lives on a relay other than our home.
 * Foreign contacts are reached only through the relay pool (disposable mailbox
 * socket on their relay); there is no aegisId transport to them at all.
 */
export function isForeign(contact: { relayOnion?: string | null } | null | undefined): boolean {
  return !sameRelay(relayFor(contact), getHomeRelay());
}
