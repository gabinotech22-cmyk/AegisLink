/**
 * relayMigration — federation F5b (docs/FEDERATION-DESIGN.md D4).
 *
 * Pins the order and the rollback guarantee of a home-relay migration:
 *   - verify → register → announce → switch → reconnect, in that order;
 *   - a failed verify or registration changes NOTHING (setting untouched, no
 *     announce, no reconnect); a failed announce still switches (the old home
 *     keeps receiving for the grace window);
 *   - the switch records the old home as `previous` with a 7-day deadline;
 *   - "back to official" is the same migration with target null; same relay → no-op;
 *   - housekeeping drains the previous home while the window is open and
 *     retires it (signed delete) once it has passed, retrying a failed delete;
 *   - verifyRelay: unreachable / not a relay / missing features / no Tor.
 */
const mockStore = new Map<string, string>();
jest.mock('../../utils/secureStore', () => ({
  __esModule: true,
  ss: {
    get: jest.fn(async (k: string) => mockStore.get(k) ?? null),
    set: jest.fn(async (k: string, v: string) => { mockStore.set(k, v); }),
    delete: jest.fn(async (k: string) => { mockStore.delete(k); }),
  },
}));
jest.mock('../../db/core', () => ({ __esModule: true, getActiveDbSlot: () => 'self' }));
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'https://relay.example', ONION_URL: 'http://' + 'o'.repeat(56) + '.onion', MAILBOX_ENABLED: true }));
const mockTor = { available: true };
const mockRelayFetch = jest.fn<Promise<{ ok: boolean; json: () => Promise<unknown> }>, [string]>();
jest.mock('../tor', () => ({ __esModule: true, isTorAvailable: () => mockTor.available }));
jest.mock('../relayHttp', () => ({ __esModule: true, relayFetch: (url: string) => mockRelayFetch(url) }));

import type { Identity } from '../../crypto/identity';
import { hydrateHomeRelay, getHomeRelay, getHomeRelaySetting, setHomeRelay, resetHomeRelay } from '../homeRelay';
import { migrateHomeRelay, runMigrationHousekeeping, verifyRelay, MIGRATION_GRACE_MS, type MigrationDeps } from '../relayMigration';

const OFFICIAL_ONION = 'http://' + 'o'.repeat(56) + '.onion';
const MINE = 'm'.repeat(56) + '.onion';
const OTHER = 'x'.repeat(56) + '.onion';
const identity = { aegisId: 'ABC-DEFG-HJKL' } as Identity;
const T0 = 1_800_000_000_000;

function okFetch(body: unknown) { return { ok: true, json: async () => body }; }

function deps(overrides: Partial<MigrationDeps> = {}) {
  const calls: string[] = [];
  const d: MigrationDeps = {
    verify: jest.fn(async () => { calls.push('verify'); return { ok: true as const, info: { features: ['mailbox', 'prekeys'] } }; }),
    register: jest.fn(async (_i, base) => { calls.push(`register:${base}`); return { ok: true }; }),
    announce: jest.fn(async () => { calls.push('announce'); }),
    reconnect: jest.fn(() => { calls.push('reconnect'); }),
    deleteAt: jest.fn(async (_i, base) => { calls.push(`delete:${base}`); return { ok: true }; }),
    now: () => T0,
    ...overrides,
  };
  return { d, calls };
}

describe('migrateHomeRelay (F5b)', () => {
  beforeEach(async () => { mockStore.clear(); resetHomeRelay(); await hydrateHomeRelay(); mockTor.available = true; mockRelayFetch.mockReset(); });

  it('official → self-hosted: verify, register at the target, announce over the current home, switch with a 7-day previous, reconnect', async () => {
    const { d, calls } = deps();
    expect(await migrateHomeRelay({ onion: MINE }, identity, d)).toEqual({ ok: true });
    expect(calls).toEqual(['verify', `register:http://${MINE}`, 'announce', 'reconnect']);
    expect(getHomeRelay()).toEqual({ onion: MINE });
    expect(getHomeRelaySetting()).toEqual({ relay: { onion: MINE }, since: T0, previous: { relay: null, until: T0 + MIGRATION_GRACE_MS } });
    expect(JSON.parse(mockStore.get('aegis.homeRelay')!)).toEqual({ onion: MINE, since: T0, previous: { onion: null, until: T0 + MIGRATION_GRACE_MS } });
  });

  it('a failed verify or registration changes nothing: no announce, no switch, no reconnect', async () => {
    const bad = deps({ verify: jest.fn(async () => ({ ok: false as const, error: 'not_a_relay' as const })) });
    expect(await migrateHomeRelay({ onion: MINE }, identity, bad.d)).toEqual({ ok: false, error: 'not_a_relay' });
    expect(bad.d.verify).toHaveBeenCalledTimes(1);
    expect(bad.calls).toEqual([]); // nothing after verify
    expect(getHomeRelay()).toBeNull();
    expect(mockStore.size).toBe(0);

    const noReg = deps({ register: jest.fn(async () => ({ ok: false, error: 'HTTP 429' })) });
    expect(await migrateHomeRelay({ onion: MINE }, identity, noReg.d)).toEqual({ ok: false, error: 'register_failed', detail: 'HTTP 429' });
    expect(noReg.d.register).toHaveBeenCalledWith(identity, `http://${MINE}`);
    expect(noReg.calls).toEqual(['verify']); // nothing after the failed registration
    expect(getHomeRelay()).toBeNull();
  });

  it('a failed announce still switches (the old home keeps receiving for the grace window)', async () => {
    const { d } = deps({ announce: jest.fn(async () => { throw new Error('socket down'); }) });
    expect(await migrateHomeRelay({ onion: MINE }, identity, d)).toEqual({ ok: true });
    expect(getHomeRelay()).toEqual({ onion: MINE });
    expect(d.reconnect).toHaveBeenCalled();
  });

  it('back to the official relay: no verify, register at SERVER_URL, previous = the self-hosted home; same relay is a no-op', async () => {
    await setHomeRelay({ relay: { onion: MINE }, since: 1, previous: null });
    const { d, calls } = deps();
    expect(await migrateHomeRelay(null, identity, d)).toEqual({ ok: true });
    expect(calls).toEqual(['register:https://relay.example', 'announce', 'reconnect']);
    expect(getHomeRelaySetting()).toEqual({ relay: null, since: T0, previous: { relay: { onion: MINE }, until: T0 + MIGRATION_GRACE_MS } });

    const again = deps();
    expect(await migrateHomeRelay(null, identity, again.d)).toEqual({ ok: false, error: 'same_relay' });
    expect(again.calls).toEqual([]);
  });

  it('migrating again inside the grace window retires the still-open previous home first', async () => {
    await setHomeRelay({ relay: { onion: MINE }, since: 1, previous: { relay: null, until: T0 + 1000 } });
    const { d, calls } = deps();
    expect(await migrateHomeRelay({ onion: OTHER }, identity, d)).toEqual({ ok: true });
    expect(calls).toEqual(['verify', `register:http://${OTHER}`, 'announce', 'delete:https://relay.example', 'reconnect']);
    expect(getHomeRelaySetting().previous).toEqual({ relay: { onion: MINE }, until: T0 + MIGRATION_GRACE_MS });
  });
});

describe('runMigrationHousekeeping (F5b)', () => {
  const onEnvelope = jest.fn();
  beforeEach(async () => { mockStore.clear(); resetHomeRelay(); await hydrateHomeRelay(); });

  it('no previous home → idle', async () => {
    const drain = jest.fn(async () => 0);
    expect(await runMigrationHousekeeping(identity, onEnvelope, { drainPrevious: drain, now: () => T0 })).toBe('idle');
    expect(drain).not.toHaveBeenCalled();
  });

  it('window open → drains the previous home (its onion; the official one via ONION_URL) and keeps it', async () => {
    await setHomeRelay({ relay: { onion: MINE }, since: T0, previous: { relay: null, until: T0 + MIGRATION_GRACE_MS } });
    const drain = jest.fn(async () => 2);
    const del = jest.fn(async () => ({ ok: true }));
    expect(await runMigrationHousekeeping(identity, onEnvelope, { drainPrevious: drain, deleteAt: del, now: () => T0 + 1000 })).toBe('drained');
    expect(drain).toHaveBeenCalledWith(OFFICIAL_ONION);
    expect(del).not.toHaveBeenCalled();
    expect(getHomeRelaySetting().previous).not.toBeNull();

    await setHomeRelay({ relay: null, since: T0, previous: { relay: { onion: MINE }, until: T0 + MIGRATION_GRACE_MS } });
    drain.mockClear();
    await runMigrationHousekeeping(identity, onEnvelope, { drainPrevious: drain, deleteAt: del, now: () => T0 + 1000 });
    expect(drain).toHaveBeenCalledWith(`http://${MINE}`);
  });

  it('window over → last drain, signed delete at the previous home, previous forgotten; a failed delete is retried next time', async () => {
    await setHomeRelay({ relay: null, since: T0, previous: { relay: { onion: MINE }, until: T0 + MIGRATION_GRACE_MS } });
    const drain = jest.fn(async () => 0);
    const failDel = jest.fn(async () => ({ ok: false }));
    expect(await runMigrationHousekeeping(identity, onEnvelope, { drainPrevious: drain, deleteAt: failDel, now: () => T0 + MIGRATION_GRACE_MS + 1 })).toBe('retire_failed');
    expect(failDel).toHaveBeenCalledWith(identity, `http://${MINE}`);
    expect(getHomeRelaySetting().previous).not.toBeNull(); // retried on the next connect

    const del = jest.fn(async () => ({ ok: true }));
    expect(await runMigrationHousekeeping(identity, onEnvelope, { drainPrevious: drain, deleteAt: del, now: () => T0 + MIGRATION_GRACE_MS + 1 })).toBe('retired');
    expect(getHomeRelaySetting().previous).toBeNull();
    expect(JSON.parse(mockStore.get('aegis.homeRelay')!).previous).toBeNull();
  });
});

describe('verifyRelay (F5b)', () => {
  beforeEach(() => { mockTor.available = true; mockRelayFetch.mockReset(); });

  it('a healthy relay with the required features verifies; info is returned', async () => {
    mockRelayFetch.mockImplementation(async (url) => url.endsWith('/relay/info')
      ? okFetch({ name: 'mine', features: ['mailbox', 'prekeys', 'ntfy', 7], maxBlobBytes: 1 })
      : okFetch({ ok: true }));
    const r = await verifyRelay({ onion: MINE });
    expect(r).toEqual({ ok: true, info: { name: 'mine', features: ['mailbox', 'prekeys', 'ntfy'], maxBlobBytes: 1 } });
    expect(mockRelayFetch.mock.calls.map((c) => c[0])).toEqual([`http://${MINE}/relay/info`, `http://${MINE}/health`]);
  });

  it('rejects: no Tor, unreachable, not a relay, missing features, unhealthy', async () => {
    mockTor.available = false;
    expect(await verifyRelay({ onion: MINE })).toEqual({ ok: false, error: 'tor_unavailable' });
    mockTor.available = true;
    mockRelayFetch.mockRejectedValueOnce(new Error('relay_unreachable'));
    expect(await verifyRelay({ onion: MINE })).toEqual({ ok: false, error: 'unreachable' });
    mockRelayFetch.mockResolvedValueOnce({ ok: false, json: async () => null });
    expect(await verifyRelay({ onion: MINE })).toEqual({ ok: false, error: 'not_a_relay' });
    mockRelayFetch.mockResolvedValueOnce(okFetch({ hello: 'world' }));
    expect(await verifyRelay({ onion: MINE })).toEqual({ ok: false, error: 'not_a_relay' });
    mockRelayFetch.mockResolvedValueOnce(okFetch({ features: ['mailbox'] }));
    expect(await verifyRelay({ onion: MINE })).toEqual({ ok: false, error: 'missing_features' });
    mockRelayFetch.mockResolvedValueOnce(okFetch({ features: ['mailbox', 'prekeys'] })).mockResolvedValueOnce({ ok: false, json: async () => null });
    expect(await verifyRelay({ onion: MINE })).toEqual({ ok: false, error: 'unreachable' });
  });
});
