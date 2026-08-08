/**
 * envelopeDedupe.test.ts — one-open-per-envelope guard.
 *
 * The stateless mailbox drain now runs ALONGSIDE the mailbox socket instead of
 * being dead code, so the same queued row routinely reaches handleIncomingV2
 * twice. Opening it twice consumes the ratchet message key on the first pass and
 * then fails on the second, which drags the session into desync recovery over a
 * message already persisted. This guard is what makes racing the two paths safe.
 *
 * The invariant that must NOT break in the other direction: a delivery that
 * FAILED is never recorded, so the relay's re-drain is still processed
 * (at-least-once, audit 2026-07-24).
 */

import {
  isEnvelopeAlreadyPersisted,
  markEnvelopePersisted,
  resetEnvelopeDedupe,
  RECENT_ENVELOPE_CAP,
} from '../envelopeDedupe';

beforeEach(() => resetEnvelopeDedupe());

describe('envelope dedupe', () => {
  it('lets the first delivery through and suppresses the racing duplicate', () => {
    expect(isEnvelopeAlreadyPersisted('env-1')).toBe(false);
    markEnvelopePersisted('env-1'); // socket path persisted it
    expect(isEnvelopeAlreadyPersisted('env-1')).toBe(true); // stateless drain arrives second
  });

  it('does not suppress a retry of a delivery that failed', () => {
    // handleIncomingV2 throws before marking → the id was never recorded, so the
    // relay's re-drain must be processed normally rather than dropped.
    expect(isEnvelopeAlreadyPersisted('env-failed')).toBe(false);
    expect(isEnvelopeAlreadyPersisted('env-failed')).toBe(false);
  });

  it('keeps distinct envelopes independent', () => {
    markEnvelopePersisted('env-a');
    expect(isEnvelopeAlreadyPersisted('env-b')).toBe(false);
  });

  it('ignores empty ids instead of collapsing them into one entry', () => {
    markEnvelopePersisted('');
    expect(isEnvelopeAlreadyPersisted('')).toBe(false);
  });

  it('holds a full relay-side queue (500 rows) without evicting its own head', () => {
    // MAX_QUEUED_PER_RECIPIENT is 500 server-side; a single drain must never be
    // large enough to push its earliest ids out and re-admit them as "new".
    for (let i = 0; i < 500; i++) markEnvelopePersisted(`env-${i}`);
    expect(isEnvelopeAlreadyPersisted('env-0')).toBe(true);
    expect(isEnvelopeAlreadyPersisted('env-499')).toBe(true);
  });

  it('evicts oldest-first once past the cap, and stays bounded', () => {
    for (let i = 0; i < RECENT_ENVELOPE_CAP + 10; i++) markEnvelopePersisted(`env-${i}`);
    expect(isEnvelopeAlreadyPersisted('env-0')).toBe(false); // oldest evicted
    expect(isEnvelopeAlreadyPersisted(`env-${RECENT_ENVELOPE_CAP + 9}`)).toBe(true); // newest kept
  });

  it('does not let a repeated id refresh its position and starve the FIFO', () => {
    markEnvelopePersisted('env-old');
    for (let i = 0; i < RECENT_ENVELOPE_CAP; i++) {
      markEnvelopePersisted('env-old'); // repeats must not renew it
      markEnvelopePersisted(`env-${i}`);
    }
    expect(isEnvelopeAlreadyPersisted('env-old')).toBe(false);
  });

  it('forgets everything on reset (test isolation helper)', () => {
    markEnvelopePersisted('env-1');
    resetEnvelopeDedupe();
    expect(isEnvelopeAlreadyPersisted('env-1')).toBe(false);
  });
});
