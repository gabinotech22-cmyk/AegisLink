/**
 * socketRateLimits.unit.test.ts — regression for the audit 2026-06 socket-path
 * rate limiters. The HTTP prekeys route was already throttled; the SOCKET path
 * (prekeys:upload / prekeys:fetch) and the unauthenticated device:link request
 * were not. Each limiter is keyed by an authenticated/target identity (no IP).
 */
import {
  checkPrekeysUploadRateLimit,
  checkPrekeysFetchRateLimit,
  checkDeviceLinkRateLimit,
} from '../relay/rateLimits.js';

describe('socket-path rate limiters (audit 2026-06)', () => {
  it('prekeys:upload allows 20 then blocks (20 / 10 min)', () => {
    const id = 'rl-test-upload';
    for (let i = 0; i < 20; i++) expect(checkPrekeysUploadRateLimit(id)).toBe(true);
    expect(checkPrekeysUploadRateLimit(id)).toBe(false);
  });

  it('prekeys:fetch allows 60 then blocks (60 / min)', () => {
    const id = 'rl-test-fetch';
    for (let i = 0; i < 60; i++) expect(checkPrekeysFetchRateLimit(id)).toBe(true);
    expect(checkPrekeysFetchRateLimit(id)).toBe(false);
  });

  it('device:link allows 3 per target then blocks (3 / 15 min)', () => {
    const id = 'rl-test-devicelink';
    for (let i = 0; i < 3; i++) expect(checkDeviceLinkRateLimit(id)).toBe(true);
    expect(checkDeviceLinkRateLimit(id)).toBe(false);
  });

  it('buckets are independent per identity (no cross-victim reset)', () => {
    // Exhaust one identity's device:link bucket…
    const victim = 'rl-test-victim';
    for (let i = 0; i < 3; i++) checkDeviceLinkRateLimit(victim);
    expect(checkDeviceLinkRateLimit(victim)).toBe(false);
    // …a different identity still has a full, independent bucket.
    expect(checkDeviceLinkRateLimit('rl-test-other')).toBe(true);
  });
});
