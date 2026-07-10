/**
 * Tests for the ICE/TURN credential cache in ice.ts.
 *
 * We mock global fetch to verify:
 *   1. fetchTurnConfig calls the relay on a cache miss.
 *   2. A second call within the TTL uses the cache (fetch not called again).
 *   3. clearTurnCache forces a fresh fetch.
 *   4. A failed fetch falls back to the static STUN config.
 */

// fetchTurnConfig now signs the request with the active identity's Ed25519 key
// (A-7 TURN auth). Provide a fake identity so the signing path runs and the
// relay fetch is attempted; without one it correctly falls back to STUN.
jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({
      identity: { aegisId: 'AEG-TEST-AEGI', signingSecretKey: new Uint8Array(64) },
    }),
  },
}));

import { fetchTurnConfig, clearTurnCache, rtcConfig } from '../ice';
import type { RTCConfigShape } from '../ice';

const FAKE_USERNAME = 'test-user';
const FAKE_PASSWORD = 'test-pass';

// Hostnames that must NEVER appear in any iceServers entry: querying a third-party
// STUN leaks "this AegisLink user is calling now, from this IP" to an outside party.
const THIRD_PARTY_STUN = ['google.com', 'cloudflare.com', 'stun.l.google', 'stun1.l.google'];

function assertNoThirdPartyStun(config: RTCConfigShape): void {
  for (const server of config.iceServers) {
    const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
    for (const url of urls) {
      for (const bad of THIRD_PARTY_STUN) {
        expect(url).not.toContain(bad);
      }
    }
  }
}

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

// AbortSignal.timeout may not exist in jsdom — polyfill it
if (!('timeout' in AbortSignal)) {
  (AbortSignal as unknown as { timeout: (ms: number) => AbortSignal }).timeout = () =>
    new AbortController().signal;
}

beforeEach(() => {
  mockFetch.mockReset();
  clearTurnCache();
});

function makeFetchOk() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ username: FAKE_USERNAME, password: FAKE_PASSWORD, ttl: 3600 }),
  });
}

// Success response where the relay advertises its OWN coturn (STUN + TURN on the
// same host), exactly as server/src/routes/turn.ts now builds `urls`.
function makeFetchOkWithOwnUrls() {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => ({
      username: FAKE_USERNAME,
      credential: FAKE_PASSWORD,
      urls: [
        'stun:relay.aegis.internal:3478',
        'turn:relay.aegis.internal:3478?transport=udp',
        'turn:relay.aegis.internal:3478?transport=tcp',
      ],
      ttl: 3600,
    }),
  });
}

describe('fetchTurnConfig', () => {
  it('uses the relay-supplied STUN (our own host), never a third-party STUN', async () => {
    makeFetchOkWithOwnUrls();
    const config = await fetchTurnConfig('aegis-id-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    // The STUN entry, when present, must point at OUR host — never Google/Cloudflare.
    const allUrls = config.iceServers.flatMap((s) =>
      Array.isArray(s.urls) ? s.urls : [s.urls],
    );
    const stunUrls = allUrls.filter((u) => u.startsWith('stun:'));
    expect(stunUrls).toContain('stun:relay.aegis.internal:3478');
    for (const u of stunUrls) expect(u).toContain('relay.aegis.internal');
    assertNoThirdPartyStun(config);
  });

  it('returns cached result on second call without hitting fetch again', async () => {
    makeFetchOk();
    await fetchTurnConfig('aegis-id-2');
    await fetchTurnConfig('aegis-id-2');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('uses separate cache entries per aegisId', async () => {
    makeFetchOk();
    makeFetchOk();
    await fetchTurnConfig('id-A');
    await fetchTurnConfig('id-B');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('forces fresh fetch after clearTurnCache()', async () => {
    makeFetchOk();
    makeFetchOk();
    await fetchTurnConfig('aegis-id-3');
    clearTurnCache();
    await fetchTurnConfig('aegis-id-3');
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('falls back to static rtcConfig() on network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const config = await fetchTurnConfig('aegis-id-4');
    const fallback = rtcConfig();
    expect(config.iceServers).toEqual(fallback.iceServers);
  });

  it('falls back to static rtcConfig() on non-2xx response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 503 });
    const config = await fetchTurnConfig('aegis-id-5');
    const fallback = rtcConfig();
    expect(config.iceServers).toEqual(fallback.iceServers);
  });

  it('A-7 auth: with NO active identity, falls back to STUN and never calls the relay', async () => {
    // Cannot sign the request → must not mint TURN creds. STUN-only, no fetch.
    const { useIdentity } = require('../../store/identity') as typeof import('../../store/identity');
    const spy = jest.spyOn(useIdentity, 'getState').mockReturnValueOnce({ identity: null } as never);
    const config = await fetchTurnConfig('aegis-id-noid');
    expect(mockFetch).not.toHaveBeenCalled();
    expect(config.iceServers).toEqual(rtcConfig().iceServers);
    spy.mockRestore();
  });
});

describe('no third-party STUN (metadata leak guard)', () => {
  it('rtcConfig() never lists Google/Cloudflare STUN', () => {
    assertNoThirdPartyStun(rtcConfig());
    assertNoThirdPartyStun(rtcConfig(false));
  });

  it('with no TURN configured, rtcConfig() has NO STUN entry (host candidates only, not a public fallback)', () => {
    // In the test env EXPO_PUBLIC_TURN_URL is unset and __DEV__ derives '' → no
    // TURN, therefore no derivable STUN. The correct result is an empty list,
    // NOT a fallback to a public STUN server.
    const config = rtcConfig();
    const stunUrls = config.iceServers
      .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
      .filter((u) => u.startsWith('stun:'));
    expect(stunUrls).toHaveLength(0);
  });

  it('fetchTurnConfig() with a relay that returns no urls yields no third-party STUN', async () => {
    makeFetchOk(); // legacy response: username/password only, no urls array
    const config = await fetchTurnConfig('aegis-id-nostun');
    assertNoThirdPartyStun(config);
    // No TURN configured + relay gave no urls → no STUN entry at all.
    const stunUrls = config.iceServers
      .flatMap((s) => (Array.isArray(s.urls) ? s.urls : [s.urls]))
      .filter((u) => u.startsWith('stun:'));
    expect(stunUrls).toHaveLength(0);
  });
});
