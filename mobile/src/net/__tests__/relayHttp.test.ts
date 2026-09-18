/**
 * relayHttp — federation F5: relay HTTP dispatched by URL.
 *   - a .onion URL rides the embedded Tor (torHttpRequest), every verb, and is
 *     shaped like a Response for the callers; fail-closed without Tor;
 *   - anything else is the global fetch, untouched (clearnet HTTPS + pins).
 */
const mockTor = { available: true, request: jest.fn(async (..._a: unknown[]): Promise<{ status: number; body: string } | null> => ({ status: 200, body: '{"ok":true}' })) };
jest.mock('../tor', () => ({
  __esModule: true,
  isTorAvailable: () => mockTor.available,
  torHttpRequest: (...a: unknown[]) => mockTor.request(...a),
}));

import { relayFetch, isOnionUrl } from '../relayHttp';

const ONION = 'http://' + 'a'.repeat(56) + '.onion';

describe('relayHttp (F5)', () => {
  const realFetch = global.fetch;
  beforeEach(() => { mockTor.available = true; mockTor.request.mockClear(); });
  afterEach(() => { global.fetch = realFetch; });

  it('recognises v3 onion hosts only', () => {
    expect(isOnionUrl(`${ONION}/identity`)).toBe(true);
    expect(isOnionUrl(`${ONION}:80/x`)).toBe(true);
    expect(isOnionUrl('https://relay.example/identity')).toBe(false);
    expect(isOnionUrl('http://short.onion/x')).toBe(false);
    expect(isOnionUrl('https://evil.example/' + 'a'.repeat(56) + '.onion')).toBe(false);
  });

  it('a .onion URL goes through Tor with the verb, headers and body, shaped like a Response', async () => {
    const res = await relayFetch(`${ONION}/identity/X`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: '{"sig":"s"}' });
    expect(mockTor.request).toHaveBeenCalledWith(`${ONION}/identity/X`, 'DELETE', '{"sig":"s"}', { 'content-type': 'application/json' });
    expect(res.ok).toBe(true);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(res.headers.get('Retry-After')).toBeNull();

    mockTor.request.mockResolvedValueOnce({ status: 429, body: '{"retryAfterMs":5}' });
    const busy = await relayFetch(`${ONION}/prekeys`, { method: 'POST', body: '{}' });
    expect(busy.ok).toBe(false);
    expect(busy.status).toBe(429);
    expect(await busy.text()).toBe('{"retryAfterMs":5}');
  });

  it('fails closed: no Tor → rejects, transport failure → rejects, never a clearnet fetch', async () => {
    const fetchSpy = jest.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;
    mockTor.available = false;
    await expect(relayFetch(`${ONION}/health`)).rejects.toThrow('tor_unavailable');
    mockTor.available = true;
    mockTor.request.mockResolvedValueOnce(null);
    await expect(relayFetch(`${ONION}/health`)).rejects.toThrow('relay_unreachable');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a clearnet URL is the global fetch, untouched', async () => {
    const fake = { ok: true, status: 200 };
    const fetchSpy = jest.fn(async () => fake);
    global.fetch = fetchSpy as unknown as typeof fetch;
    const init = { method: 'POST' as const, body: '{}' };
    const res = await relayFetch('https://relay.example/identity', init);
    expect(fetchSpy).toHaveBeenCalledWith('https://relay.example/identity', init);
    expect(res).toBe(fake);
    expect(mockTor.request).not.toHaveBeenCalled();
  });
});
