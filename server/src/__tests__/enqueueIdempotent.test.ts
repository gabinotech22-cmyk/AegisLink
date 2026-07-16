/**
 * enqueueIdempotent.test.ts — regression for the 2026-07-16 production
 * crash-loop.
 *
 * Senders retry envelope delivery after reconnects, so the relay can receive
 * the SAME envelope id twice. The old `INSERT INTO messages` threw
 * `UNIQUE constraint failed: messages.id`, which escaped as an
 * unhandledRejection and killed the process on every client retry (relay
 * stuck in a Docker restart loop, nginx served 502). enqueue must treat a
 * duplicate id as success (the message IS queued) and never throw.
 *
 * Self-contained repo-level harness, same pattern as drain-cap.test.ts.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import { initDb, messageRepo } from '../db/client.js';

function row(id: string, recipient: string) {
  return {
    id,
    recipient,
    ciphertext_b64: 'Y2lwaGVy',
    nonce_b64: 'bm9uY2U=',
    created_at: Date.now(),
    expires_at: 0,
  };
}

beforeAll(async () => {
  await initDb();
});

describe('messageRepo.enqueue idempotency', () => {
  it('re-enqueueing the same envelope id resolves ok instead of throwing', async () => {
    const first = await messageRepo.enqueue(row('msg-dup-1', 'recipient-a'));
    expect(first.ok).toBe(true);

    // The retry path: same id again. Must NOT reject (the old behavior threw
    // ERR_SQLITE_ERROR 1555 here) and must report success.
    const retry = await messageRepo.enqueue(row('msg-dup-1', 'recipient-a'));
    expect(retry.ok).toBe(true);
  });

  it('a retried duplicate still resolves ok when the recipient queue is full', async () => {
    const recipient = 'recipient-full';
    const dupId = 'msg-dup-full';
    expect((await messageRepo.enqueue(row(dupId, recipient))).ok).toBe(true);
    // Fill the queue to the cap (the duplicate above counts as one).
    const { MAX_QUEUED_PER_RECIPIENT } = await import('../db/client.js');
    for (let i = 1; i < MAX_QUEUED_PER_RECIPIENT; i++) {
      await messageRepo.enqueue(row(`msg-fill-${i}`, recipient));
    }
    // A genuinely NEW message is rejected...
    const fresh = await messageRepo.enqueue(row('msg-overflow', recipient));
    expect(fresh).toEqual({ ok: false, reason: 'queue_full' });
    // ...but the retry of an already-queued id must still be success.
    const retry = await messageRepo.enqueue(row(dupId, recipient));
    expect(retry.ok).toBe(true);
  });

  it('the duplicate does not create a second queued copy', async () => {
    await messageRepo.enqueue(row('msg-dup-2', 'recipient-b'));
    await messageRepo.enqueue(row('msg-dup-2', 'recipient-b'));

    const drained = await messageRepo.drainFor('recipient-b');
    expect(drained.filter((m) => m.id === 'msg-dup-2')).toHaveLength(1);
  });
});
