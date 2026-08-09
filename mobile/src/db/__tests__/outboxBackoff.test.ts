/**
 * Outbox retry schedule — regression tests.
 *
 * WHY THESE EXIST
 * ---------------
 * Before this, `attempts` was incremented on every failure and never read back:
 * no backoff, no cap, no terminal state. A job that failed while the socket
 * stayed up waited for the next reconnect — on a stable connection, indefinitely
 * — while the chat bubble rendered as if the message had been sent.
 *
 * These tests pin the three properties the drain relies on:
 *   1. the delay grows with attempts, so a persistently failing job backs off
 *   2. it is capped, so a job is never parked for hours
 *   3. jitter stays inside a known band, so the schedule is still predictable
 *      and clients coming back together do not retry in lockstep
 * plus the 24 h window after which a job is declared failed (Signal's model).
 */

import {
  nextOutboxDelayMs,
  isOutboxJobExpired,
  OUTBOX_BASE_DELAY_MS,
  OUTBOX_MAX_DELAY_MS,
  OUTBOX_MAX_AGE_MS,
} from '../outboxBackoff';

describe('nextOutboxDelayMs', () => {
  // rand() === 1 removes jitter, exposing the raw exponential curve.
  const noJitter = () => 1;

  it('grows exponentially with the attempt count', () => {
    expect(nextOutboxDelayMs(0, noJitter)).toBe(OUTBOX_BASE_DELAY_MS);
    expect(nextOutboxDelayMs(1, noJitter)).toBe(OUTBOX_BASE_DELAY_MS * 2);
    expect(nextOutboxDelayMs(2, noJitter)).toBe(OUTBOX_BASE_DELAY_MS * 4);
    expect(nextOutboxDelayMs(3, noJitter)).toBe(OUTBOX_BASE_DELAY_MS * 8);
  });

  it('never exceeds the ceiling, however many attempts have failed', () => {
    for (const attempts of [10, 50, 1000, Number.MAX_SAFE_INTEGER]) {
      expect(nextOutboxDelayMs(attempts, noJitter)).toBe(OUTBOX_MAX_DELAY_MS);
    }
  });

  it('never returns NaN or Infinity for an absurd attempt count', () => {
    // 2 ** 1024 is Infinity: the exponent must be clamped BEFORE the shift, or a
    // job that somehow failed thousands of times gets parked until the heat death
    // of the universe instead of retrying.
    const d = nextOutboxDelayMs(5000, noJitter);
    expect(Number.isFinite(d)).toBe(true);
    expect(d).toBe(OUTBOX_MAX_DELAY_MS);
  });

  it('applies jitter within [50%, 100%] of the scheduled delay', () => {
    expect(nextOutboxDelayMs(0, () => 0)).toBe(OUTBOX_BASE_DELAY_MS / 2);
    expect(nextOutboxDelayMs(0, () => 1)).toBe(OUTBOX_BASE_DELAY_MS);
    // Real randomness stays inside the band for every attempt level.
    for (let attempts = 0; attempts < 12; attempts++) {
      const d = nextOutboxDelayMs(attempts);
      const ceiling = Math.min(OUTBOX_BASE_DELAY_MS * 2 ** attempts, OUTBOX_MAX_DELAY_MS);
      expect(d).toBeGreaterThanOrEqual(Math.floor(ceiling * 0.5));
      expect(d).toBeLessThanOrEqual(ceiling);
    }
  });

  it('always waits at least a moment — a retry must never be a hot loop', () => {
    for (let attempts = 0; attempts < 20; attempts++) {
      expect(nextOutboxDelayMs(attempts, () => 0)).toBeGreaterThan(0);
    }
  });

  it('treats a negative or non-finite attempt count as zero', () => {
    expect(nextOutboxDelayMs(-5, noJitter)).toBe(OUTBOX_BASE_DELAY_MS);
    expect(nextOutboxDelayMs(NaN, noJitter)).toBe(OUTBOX_BASE_DELAY_MS);
  });
});

describe('isOutboxJobExpired', () => {
  const now = 1_000_000_000_000;

  it('keeps a job inside the retry window', () => {
    expect(isOutboxJobExpired(now, now)).toBe(false);
    expect(isOutboxJobExpired(now - OUTBOX_MAX_AGE_MS + 1, now)).toBe(false);
  });

  it('gives up once the window has fully elapsed', () => {
    expect(isOutboxJobExpired(now - OUTBOX_MAX_AGE_MS, now)).toBe(true);
    expect(isOutboxJobExpired(now - OUTBOX_MAX_AGE_MS * 2, now)).toBe(true);
  });

  it('uses a 24 h window, matching the Signal retry model', () => {
    expect(OUTBOX_MAX_AGE_MS).toBe(24 * 60 * 60 * 1000);
  });
});
