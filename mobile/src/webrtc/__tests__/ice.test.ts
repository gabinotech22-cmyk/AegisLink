/**
 * Tests for the ICE/TURN credential cache in ice.ts.
 *
 * We mock global fetch to verify:
 *   1. fetchTurnConfig calls the relay on a cache miss.
 *   2. A second call within the TTL uses the cache (fetch not called again).
 *   3. clearTurnCache forces a fresh fetch.
 *   4. A failed fetch falls back to the static STUN config.
 */

import { fetchTurnConfig, clearTurnCache, rtcConfig } from '../ice';

const FAKE_USERNAME = 'test-user';
const FAKE_PASSWORD = 'test-pass';

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

describe('fetchTurnConfig', () => {
  it('calls relay on first fetch and returns ICE config with STUN', async () => {
    makeFetchOk();
    const config = await fetchTurnConfig('aegis-id-1');
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(config.iceServers.length).toBeGreaterThanOrEqual(1);
    // Must always include STUN
    const stunEntry = config.iceServers.find(
      (s) => Array.isArray(s.urls) && (s.urls as string[]).some((u) => u.startsWith('stun:')),
    );
    expect(stunEntry).toBeDefined();
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
});
