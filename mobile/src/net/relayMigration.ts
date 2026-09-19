/**
 * relayMigration — changing our home relay (federation F5b,
 * docs/FEDERATION-DESIGN.md D4).
 *
 * Model (SimpleX-style, no relay-to-relay protocol): the client registers
 * itself on the new relay, tells every contact the new address inside the
 * E2EE profile (`profile_update.mailboxRelay`) and switches its home. The OLD
 * relay keeps our identity and our mailbox for a GRACE window, so a contact
 * who has not opened the app yet still reaches us there — the client drains
 * that copy on every connect until the window ends, then deletes its identity
 * from the old relay.
 *
 * Order matters (nothing is switched until the new relay has confirmed us):
 *   1. verify the target (`GET /relay/info` + `/health` over Tor)      — no side effect
 *   2. register identity + prekeys on the target (PoW)                  — additive
 *   3. announce `mailboxRelay` to every contact over the CURRENT home    — additive
 *   4. persist the setting: home = target, previous = { old, until }    — the switch
 *   5. reconnect the identity + mailbox sockets to the new home
 * A failure in 1–3 leaves the setting untouched (rollback = nothing to undo:
 * an extra registration on a relay we never adopted is harmless and expires
 * with its prekeys). Only step 4 changes where we live.
 *
 * "Back to the official relay" is the same migration with target = null.
 */
import { logger } from '../utils/logger';
import type { Identity } from '../crypto/identity';
import { SERVER_URL } from '../config';
import { relayFetch } from './relayHttp';
import { isTorAvailable } from './tor';
import { canonicalRelay, isOfficialRelay } from './officialRelay';
import { sameRelay, type RelayRef } from './relayRef';
import { getHomeRelay, getHomeRelaySetting, setHomeRelay } from './homeRelay';

/** How long the old home keeps receiving for us after a migration (D4). */
export const MIGRATION_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/** What `GET /relay/info` publishes (server/src/routes/relayInfo.ts). */
export interface RelayInfo {
  name?: string;
  version?: string;
  protocol?: number;
  minClient?: string;
  features: string[];
  maxBlobBytes?: number;
}

/** A relay must serve these to host an identity + mailbox (D5). */
export const REQUIRED_RELAY_FEATURES = ['mailbox', 'prekeys'] as const;

export type VerifyRelayResult =
  | { ok: true; info: RelayInfo }
  | { ok: false; error: 'tor_unavailable' | 'unreachable' | 'not_a_relay' | 'missing_features' };

export function relayBaseFor(ref: RelayRef | null): string {
  return ref ? `http://${ref.onion}` : SERVER_URL;
}

/**
 * Vet a relay before adopting it: reachable over Tor, answers `/relay/info`
 * with the features we need, and is healthy. Pure read; safe to call from the
 * settings screen's "Verify" button.
 */
export async function verifyRelay(ref: RelayRef): Promise<VerifyRelayResult> {
  if (!isTorAvailable()) return { ok: false, error: 'tor_unavailable' };
  const base = relayBaseFor(ref);
  let info: RelayInfo;
  try {
    const res = await relayFetch(`${base}/relay/info`);
    if (!res.ok) return { ok: false, error: 'not_a_relay' };
    const body = (await res.json()) as { features?: unknown } & Partial<RelayInfo>;
    if (!body || !Array.isArray(body.features)) return { ok: false, error: 'not_a_relay' };
    info = { ...body, features: body.features.filter((f): f is string => typeof f === 'string') };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  if (!REQUIRED_RELAY_FEATURES.every((f) => info.features.includes(f))) {
    return { ok: false, error: 'missing_features' };
  }
  try {
    const health = await relayFetch(`${base}/health`);
    if (!health.ok) return { ok: false, error: 'unreachable' };
  } catch {
    return { ok: false, error: 'unreachable' };
  }
  return { ok: true, info };
}

export type MigrateError =
  | 'same_relay' | 'tor_unavailable' | 'unreachable' | 'not_a_relay' | 'missing_features' | 'register_failed';
export type MigrateResult = { ok: true } | { ok: false; error: MigrateError; detail?: string };

/** Seams so the migration can be driven without sockets/PoW in tests. */
export interface MigrationDeps {
  verify: (ref: RelayRef) => Promise<VerifyRelayResult>;
  register: (identity: Identity, relayBaseUrl: string) => Promise<{ ok: boolean; error?: string }>;
  announce: (identity: Identity) => Promise<void>;
  reconnect: (identity: Identity) => Promise<void> | void;
  /** Retire a still-open previous home when migrating again inside its grace window. */
  deleteAt: (identity: Identity, relayBaseUrl: string) => Promise<{ ok: boolean }>;
  now: () => number;
}

function defaultDeps(): MigrationDeps {
  return {
    verify: verifyRelay,
    deleteAt: (identity, relayBaseUrl) => {
      const { deleteAccountOnRelay } = require('../crypto/accountDeletion') as typeof import('../crypto/accountDeletion');
      return deleteAccountOnRelay(identity, { relayBaseUrl });
    },
    register: async (identity, relayBaseUrl) => {
      const { ensureRegistered } = require('../crypto/ensureRegistered') as typeof import('../crypto/ensureRegistered');
      return ensureRegistered(identity, { relayBaseUrl });
    },
    announce: async (identity) => {
      const { broadcastProfileUpdate } = require('../socket/client') as typeof import('../socket/client');
      await broadcastProfileUpdate(identity, { force: true });
    },
    reconnect: (identity) => {
      const { disconnect, connect } = require('../socket/client') as typeof import('../socket/client');
      disconnect();
      connect(identity);
    },
    now: () => Date.now(),
  };
}

/**
 * Move our home to `target` (null = the official relay). See the module doc for
 * the order and the rollback guarantee. Resolves `{ ok: false }` with a coded
 * error instead of throwing.
 */
export async function migrateHomeRelay(
  target: RelayRef | null,
  identity: Identity,
  deps: Partial<MigrationDeps> = {},
): Promise<MigrateResult> {
  const d: MigrationDeps = { ...defaultDeps(), ...deps };
  const next = canonicalRelay(target);
  const current = getHomeRelay();
  if (sameRelay(next, current)) return { ok: false, error: 'same_relay' };

  // 1. Verify (a self-hosted target only — the official relay is trusted by construction).
  if (next) {
    const v = await d.verify(next);
    if (!v.ok) return { ok: false, error: v.error };
  }

  // 2. Register on the target. Nothing about us has changed yet.
  const reg = await d.register(identity, relayBaseFor(next));
  if (!reg.ok) return { ok: false, error: 'register_failed', detail: reg.error };

  // 3. Announce the new address over the CURRENT transport, while every contact
  //    can still be reached the way they are reached today.
  try {
    await d.announce(identity);
  } catch (e) {
    if (__DEV__) logger.warn('[relayMigration] announce failed:', (e as Error).message);
    // Not fatal: the profile (with mailboxRelay) is re-announced on every
    // reconnect / first message, and the old home keeps receiving for the
    // grace window. Proceed with the switch.
  }

  // 4. The switch — the only step with lasting effect. Migrating again while a
  //    previous home is still in its grace window retires that one now (best
  //    effort): a single `previous` slot never silently leaks a registration.
  const stale = getHomeRelaySetting().previous;
  if (stale && !sameRelay(stale.relay, next)) {
    try { await d.deleteAt(identity, relayBaseFor(stale.relay)); } catch { /* best effort */ }
  }
  const now = d.now();
  await setHomeRelay({
    relay: next,
    since: now,
    previous: { relay: current, until: now + MIGRATION_GRACE_MS },
  });

  // 5. Reconnect to the new home (identity + mailbox sockets, ntfy).
  try {
    await d.reconnect(identity);
  } catch (e) {
    if (__DEV__) logger.warn('[relayMigration] reconnect failed (will retry on next connect):', (e as Error).message);
  }
  return { ok: true };
}

/** Seams for the housekeeping (tests). */
export interface HousekeepingDeps {
  drainPrevious: (onionUrl: string) => Promise<number>;
  deleteAt: (identity: Identity, relayBaseUrl: string) => Promise<{ ok: boolean }>;
  now: () => number;
}

function defaultHousekeepingDeps(
  onEnvelope: (env: import('../socket/mailboxSocket').IncomingMailboxEnvelope) => void | Promise<void>,
): HousekeepingDeps {
  return {
    drainPrevious: (onionUrl) => {
      const { fetchMailboxOverTor } = require('../socket/mailboxSocket') as typeof import('../socket/mailboxSocket');
      return fetchMailboxOverTor(onEnvelope, { onionUrl });
    },
    deleteAt: (identity, relayBaseUrl) => {
      const { deleteAccountOnRelay } = require('../crypto/accountDeletion') as typeof import('../crypto/accountDeletion');
      return deleteAccountOnRelay(identity, { relayBaseUrl });
    },
    now: () => Date.now(),
  };
}

/**
 * Grace-window housekeeping, run on every authenticated connect:
 *   - window open  → drain the previous home's copy of our mailbox (a contact
 *                    who has not learnt the new address may still write there);
 *   - window over  → delete our identity from the previous home (signed) and
 *                    forget it. A failed delete is retried on the next connect.
 * The official relay as a previous home is drained via its onion only when one
 * is configured (mailbox mode); its identity queue was already drained by the
 * old socket before the switch.
 */
export async function runMigrationHousekeeping(
  identity: Identity,
  onEnvelope: (env: import('../socket/mailboxSocket').IncomingMailboxEnvelope) => void | Promise<void>,
  deps: Partial<HousekeepingDeps> = {},
): Promise<'idle' | 'drained' | 'retired' | 'retire_failed'> {
  const d: HousekeepingDeps = { ...defaultHousekeepingDeps(onEnvelope), ...deps };
  const setting = getHomeRelaySetting();
  const prev = setting.previous;
  if (!prev) return 'idle';
  const { ONION_URL } = require('../config') as typeof import('../config');
  const prevOnionUrl = prev.relay ? `http://${prev.relay.onion}` : ONION_URL;

  if (d.now() < prev.until) {
    if (prevOnionUrl) {
      try { await d.drainPrevious(prevOnionUrl); } catch (e) {
        if (__DEV__) logger.warn('[relayMigration] previous-home drain failed:', (e as Error).message);
      }
    }
    return 'drained';
  }

  // Window over: one last drain, then retire the old registration.
  if (prevOnionUrl) {
    try { await d.drainPrevious(prevOnionUrl); } catch { /* best effort */ }
  }
  const base = prev.relay ? `http://${prev.relay.onion}` : SERVER_URL;
  let deleted = false;
  try { deleted = (await d.deleteAt(identity, base)).ok; } catch { deleted = false; }
  if (!deleted) return 'retire_failed';
  await setHomeRelay({ ...setting, previous: null });
  return 'retired';
}

/** Human-facing summary for the settings screen. */
export function describeHome(): { official: boolean; onion: string | null; since: number; previous: { onion: string | null; until: number } | null } {
  const s = getHomeRelaySetting();
  return {
    official: isOfficialRelay(s.relay),
    onion: s.relay?.onion ?? null,
    since: s.since,
    previous: s.previous ? { onion: s.previous.relay?.onion ?? null, until: s.previous.until } : null,
  };
}
