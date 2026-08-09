// ─── Outbox retry schedule (pure — no DB, no RN, unit-testable) ──────────────
//
// WHY THIS EXISTS
// ---------------
// The outbox used to increment `attempts` and never read it back: no backoff,
// no cap, no terminal state. A job that failed while the socket stayed up sat
// there until the next reconnect — on a stable connection, potentially forever,
// while the chat bubble rendered as if the message had been sent.
//
// This is the Signal model: keep retrying for a bounded window (24 h) with an
// exponential backoff and jitter, then give up and mark the message failed so
// the user can see it and retry by hand. Signal-Android reached the same design
// in signalapp/Signal-Android#7914 (24 h retry window) and later added jitter to
// the backoff so a fleet of clients coming back online does not synchronise into
// a thundering herd against the relay.
//
// Privacy: this is purely local scheduling state. Nothing here is sent to the
// relay, and no timing information about it is ever persisted beyond the job's
// own retry bookkeeping.

/** First retry delay. Short enough that a transient blip self-heals fast. */
export const OUTBOX_BASE_DELAY_MS = 2_000;

/** Ceiling for a single wait, so a long backoff never parks a job for hours. */
export const OUTBOX_MAX_DELAY_MS = 5 * 60_000;

/**
 * How long we keep trying before declaring a job failed. Matches Signal's
 * 24 h window: long enough to cover a night with no connectivity, short enough
 * that the user is not shown a "sending" message from last week.
 */
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Delay before the next attempt, given how many have already failed.
 *
 * Exponential (base × 2^attempts) capped at OUTBOX_MAX_DELAY_MS, then full
 * jitter in [50 %, 100 %] of that value. Jitter is what stops every client that
 * lost the same relay from retrying in lockstep.
 *
 * @param attempts how many attempts have already failed (0 = none yet)
 * @param rand     injectable randomness so tests are deterministic
 */
export function nextOutboxDelayMs(attempts: number, rand: () => number = Math.random): number {
  const safeAttempts = Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 0;
  // Cap the exponent before shifting: 2 ** 1024 is Infinity, and a job that has
  // somehow failed thousands of times must still land on the ceiling, not NaN.
  const exponent = Math.min(safeAttempts, 32);
  const uncapped = OUTBOX_BASE_DELAY_MS * 2 ** exponent;
  const capped = Math.min(uncapped, OUTBOX_MAX_DELAY_MS);
  const jitterFactor = 0.5 + rand() * 0.5; // [0.5, 1.0]
  return Math.round(capped * jitterFactor);
}

/**
 * True once a job has been pending longer than the retry window and should be
 * given up on (deleted from the outbox, its message marked `failed`).
 */
export function isOutboxJobExpired(createdAt: number, now: number): boolean {
  return now - createdAt >= OUTBOX_MAX_AGE_MS;
}
