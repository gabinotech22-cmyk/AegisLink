/**
 * homeRelay — federation F5 (docs/FEDERATION-DESIGN.md D2/D4). Desktop twin of
 * mobile/src/net/__tests__/homeRelay.test.ts (vitest, window.aegis storage).
 *
 * The per-slot home-relay setting and everything that keys off it:
 *   - persisted JSON round-trips; anything malformed = official relay;
 *   - `getHomeRelay()` answers from memory, hydrated per slot from SecureStore;
 *   - base URLs: official → clearnet SERVER_URL / ONION_URL; self-hosted →
 *     `http://<onion>` for BOTH (HTTP and the Tor-only transports);
 *   - `isForeign` is relative to the home: on a self-hosted home the official
 *     relay's contacts are the foreign ones;
 *   - a profile switch never leaks the previous slot's relay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  store: new Map<string, string>(),
  slot: 'self',
  failNextGet: false,
}));
vi.mock('../../db/local', () => ({ getActiveDbSlot: () => h.slot }));
vi.mock('../../config', () => ({ RELAY_URL: 'https://relay.example', ONION_URL: 'http://' + 'o'.repeat(56) + '.onion' }));
(globalThis as unknown as { window: unknown }).window = {
  aegis: {
    secureStorage: {
      get: async (k: string) => { if (h.failNextGet) { h.failNextGet = false; throw new Error('storage down'); } return h.store.get(k) ?? null; },
      set: async (k: string, v: string) => { h.store.set(k, v); },
      delete: async (k: string) => { h.store.delete(k); },
    },
  },
};
const mockStore = h.store;
const mockSlot = h;

import {
  parseHomeRelaySetting, hydrateHomeRelay, setHomeRelay, getHomeRelay, getHomeRelaySetting,
  isCustomHome, homeRelayBaseUrl, homeRelayOnionUrl, isForeign, relayFor, resolveRelay, resetHomeRelay,
} from '../homeRelay';

const OFFICIAL = 'o'.repeat(56) + '.onion';
const MINE = 'm'.repeat(56) + '.onion';
const THEIRS = 't'.repeat(56) + '.onion';

describe('homeRelay (F5)', () => {
  beforeEach(() => { mockStore.clear(); mockSlot.slot = 'self'; resetHomeRelay(); });

  it('parses a persisted setting and treats anything malformed as the official relay', () => {
    expect(parseHomeRelaySetting(null)).toEqual({ relay: null, since: 0, previous: null });
    expect(parseHomeRelaySetting('garbage')).toEqual({ relay: null, since: 0, previous: null });
    expect(parseHomeRelaySetting(JSON.stringify({ onion: 'evil.example.com', since: 5 }))).toEqual({ relay: null, since: 5, previous: null });
    // Naming the official onion explicitly is still "official" (canonical null).
    expect(parseHomeRelaySetting(JSON.stringify({ onion: OFFICIAL, since: 5 })).relay).toBeNull();
    const s = parseHomeRelaySetting(JSON.stringify({ onion: MINE.toUpperCase(), since: 7, previous: { onion: null, until: 99 } }));
    expect(s).toEqual({ relay: { onion: MINE }, since: 7, previous: { relay: null, until: 99 } });
    // previous naming the CURRENT relay, or with no deadline, is meaningless → dropped
    expect(parseHomeRelaySetting(JSON.stringify({ onion: MINE, since: 7, previous: { onion: MINE, until: 99 } })).previous).toBeNull();
    expect(parseHomeRelaySetting(JSON.stringify({ onion: MINE, since: 7, previous: { onion: THEIRS, until: 0 } })).previous).toBeNull();
    expect(parseHomeRelaySetting(JSON.stringify({ onion: null, since: 0, previous: { onion: MINE, until: 5 } })).previous).toEqual({ relay: { onion: MINE }, until: 5 });
  });

  it('defaults to the official relay: base URLs and foreign-ness exactly as before F5', async () => {
    await hydrateHomeRelay();
    expect(getHomeRelay()).toBeNull();
    expect(isCustomHome()).toBe(false);
    expect(homeRelayBaseUrl()).toBe('https://relay.example');
    expect(homeRelayOnionUrl()).toBe(`http://${OFFICIAL}`);
    expect(isForeign({ relayOnion: null })).toBe(false);
    expect(isForeign({ relayOnion: OFFICIAL })).toBe(false);
    expect(isForeign({ relayOnion: THEIRS })).toBe(true);
  });

  it('a self-hosted home persists per slot, hydrates, and flips every base URL to http://<onion>', async () => {
    await setHomeRelay({ relay: { onion: MINE }, since: 123, previous: { relay: null, until: 456 } });
    expect(mockStore.get('aegis.homeRelay')).toBe(JSON.stringify({ onion: MINE, since: 123, previous: { onion: null, until: 456 } }));
    expect(getHomeRelay()).toEqual({ onion: MINE });
    expect(isCustomHome()).toBe(true);
    expect(homeRelayBaseUrl()).toBe(`http://${MINE}`);
    expect(homeRelayOnionUrl()).toBe(`http://${MINE}`);
    expect(getHomeRelaySetting().previous).toEqual({ relay: null, until: 456 });

    // Foreign-ness is relative to the home: official-relay contacts are now foreign,
    // a contact on MY relay is local.
    expect(isForeign({ relayOnion: null })).toBe(true);
    expect(isForeign({ relayOnion: MINE })).toBe(false);
    expect(isForeign({ relayOnion: THEIRS })).toBe(true);
    expect(relayFor({ relayOnion: MINE })).toEqual({ onion: MINE });
    // F7 regression: from a self-hosted home, a contact on the OFFICIAL relay is
    // foreign and the transport needs the official onion, not null.
    expect(relayFor({ relayOnion: null })).toBeNull();
    expect(resolveRelay({ relayOnion: null })).toEqual({ onion: OFFICIAL });
    expect(resolveRelay({ relayOnion: THEIRS })).toEqual({ onion: THEIRS });

    resetHomeRelay();
    expect(getHomeRelay()).toBeNull();
    await hydrateHomeRelay();
    expect(getHomeRelay()).toEqual({ onion: MINE });
  });

  it('setting the official relay back stores null and the slot key is per profile', async () => {
    mockSlot.slot = 'ABC-1234-WXYZ';
    await setHomeRelay({ relay: { onion: MINE }, since: 1, previous: null });
    expect(mockStore.has('aegis.homeRelay.ABC-1234-WXYZ')).toBe(true);
    expect(mockStore.has('aegis.homeRelay')).toBe(false);
    await setHomeRelay({ relay: null, since: 2, previous: { relay: { onion: MINE }, until: 9 } });
    expect(getHomeRelay()).toBeNull();
    expect(JSON.parse(mockStore.get('aegis.homeRelay.ABC-1234-WXYZ')!)).toEqual({ onion: null, since: 2, previous: { onion: MINE, until: 9 } });
    // Another slot does not see it.
    mockSlot.slot = 'self';
    resetHomeRelay();
    await hydrateHomeRelay();
    expect(getHomeRelay()).toBeNull();
  });

  it('a failing storage read never blocks startup: official relay assumed', async () => {
    h.failNextGet = true;
    await expect(hydrateHomeRelay()).resolves.toEqual({ relay: null, since: 0, previous: null });
  });
});
