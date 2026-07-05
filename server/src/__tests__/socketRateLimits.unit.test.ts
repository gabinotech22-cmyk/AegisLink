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
  checkPubchannelApplyRateLimit,
} from '../relay/rateLimits.js';

describe('socket-path rate limiters (audit 2026-06)', () => {
  it('prekeys:upload allows 20 then blocks (20 / 10 min)', async () => {
    const id = 'rl-test-upload';
    for (let i = 0; i < 20; i++) expect(await checkPrekeysUploadRateLimit(id)).toBe(true);
    expect(await checkPrekeysUploadRateLimit(id)).toBe(false);
  });

  it('prekeys:fetch allows 60 then blocks (60 / min)', async () => {
    const id = 'rl-test-fetch';
    for (let i = 0; i < 60; i++) expect(await checkPrekeysFetchRateLimit(id)).toBe(true);
    expect(await checkPrekeysFetchRateLimit(id)).toBe(false);
  });

  it('device:link allows 3 per target then blocks (3 / 15 min)', async () => {
    const id = 'rl-test-devicelink';
    for (let i = 0; i < 3; i++) expect(await checkDeviceLinkRateLimit(id)).toBe(true);
    expect(await checkDeviceLinkRateLimit(id)).toBe(false);
  });

  it('pubchannel:apply allows 20 per channel then blocks (20 / min) — audit delta 2026-07-03', async () => {
    // Regression: apply is anonymous (no signature) and was the only
    // pubchannel event with NO limiter — a tight loop could fill a channel's
    // 256-slot pending-join queue instantly, locking out legitimate applicants.
    const channelId = 'rl-test-apply-channel';
    for (let i = 0; i < 20; i++) expect(await checkPubchannelApplyRateLimit(channelId)).toBe(true);
    expect(await checkPubchannelApplyRateLimit(channelId)).toBe(false);
    // Independent bucket per channel — throttling one channel never starves another.
    expect(await checkPubchannelApplyRateLimit('rl-test-apply-other')).toBe(true);
  });

  it('buckets are independent per identity (no cross-victim reset)', async () => {
    // Exhaust one identity's device:link bucket…
    const victim = 'rl-test-victim';
    for (let i = 0; i < 3; i++) await checkDeviceLinkRateLimit(victim);
    expect(await checkDeviceLinkRateLimit(victim)).toBe(false);
    // …a different identity still has a full, independent bucket.
    expect(await checkDeviceLinkRateLimit('rl-test-other')).toBe(true);
  });
});
