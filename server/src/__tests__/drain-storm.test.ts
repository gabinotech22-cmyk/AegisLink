/**
 * drain-storm.test.ts — audit 2026-08-08
 *
 * Deletion of a queued message is ack-driven on purpose: deleting on emit lost
 * messages over Tor (see relay/handler.ts). The cost nobody bounded is that a row
 * the recipient can NEVER ack — permanently undecryptable envelope, ratchet state
 * gone after a reinstall — was handed back out on every single reconnect. The
 * recipient re-grinds that backlog through the ratchet before the genuinely new
 * message lands, which is the "the notification arrives but the message takes
 * 10-15 s to show up" report (iOS reconnects constantly; Android keeps the process
 * resident via the call-wake service, so it never re-drained and never showed it).
 *
 * Two independent leaks, one regression suite:
 *
 *   1. `expires_at = 0` (rows predating the expires_at migration) meant "never
 *      expires" to BOTH drainFor and purgeExpired — immortal rows, replayed for
 *      the life of the deployment. 730 of them were sitting on the live relay.
 *   2. Nothing counted hand-outs, so a never-acked row had no upper bound at all
 *      within its TTL.
 *
 * The guard must NOT regress at-least-once delivery: a row still survives a
 * failed/lost delivery and is re-offered, and a row already drained by a device
 * is never re-offered to that same device (so a normal ack cycle never burns
 * attempts).
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import { messageRepo, devicesRepo } from '../db/client';
import { MESSAGE_TTL_MS, MAX_DELIVERY_ATTEMPTS } from '../db/types';
import { getSqlite } from '../db/sqlite';

const RECIPIENT = 'AEGIS-STORM01';
const DEVICE = 'device-a';

function enqueueRaw(id: string, createdAt: number, expiresAt: number): void {
  getSqlite()
    .prepare(
      `INSERT INTO messages (id, recipient, ciphertext_b64, nonce_b64, created_at, expires_at, drained_by)
       VALUES (?, ?, 'ct', 'nn', ?, ?, '[]')`
    )
    .run(id, RECIPIENT, createdAt, expiresAt);
}

function attemptsOf(id: string): number {
  const row = getSqlite()
    .prepare(`SELECT delivery_attempts AS n FROM messages WHERE id = ?`)
    .get(id) as { n: number } | undefined;
  return row?.n ?? -1;
}

afterEach(() => {
  getSqlite().prepare(`DELETE FROM messages WHERE recipient = ?`).run(RECIPIENT);
});

describe('queued-message drain storm', () => {
  it('stops handing out a row nobody ever acks', async () => {
    await messageRepo.enqueue({
      id: 'poison-1',
      recipient: RECIPIENT,
      ciphertext_b64: 'ct',
      nonce_b64: 'nn',
      created_at: Date.now(),
      expires_at: 0,
    });

    // Every reconnect re-drains an un-acked row (at-least-once). That is correct
    // up to the cap — past it the row is poison and must stop costing bandwidth
    // and recipient CPU on every single cold start.
    for (let i = 1; i <= MAX_DELIVERY_ATTEMPTS; i++) {
      const rows = await messageRepo.drainFor(RECIPIENT, DEVICE);
      expect(rows.map((r) => r.id)).toContain('poison-1');
      expect(attemptsOf('poison-1')).toBe(i);
    }

    expect(await messageRepo.drainFor(RECIPIENT, DEVICE)).toEqual([]);
    expect(await messageRepo.purgeExpired()).toBeGreaterThan(0);
    expect(attemptsOf('poison-1')).toBe(-1); // row gone
  });

  it('keeps at-least-once: a row survives and is re-offered until acked', async () => {
    await messageRepo.enqueue({
      id: 'transient-1',
      recipient: RECIPIENT,
      ciphertext_b64: 'ct',
      nonce_b64: 'nn',
      created_at: Date.now(),
      expires_at: 0,
    });

    // First delivery is lost (no ack) — the row must come back.
    expect((await messageRepo.drainFor(RECIPIENT, DEVICE)).map((r) => r.id)).toEqual(['transient-1']);
    expect((await messageRepo.drainFor(RECIPIENT, DEVICE)).map((r) => r.id)).toEqual(['transient-1']);

    // The client acks → the recipient has one device, so the row is done and
    // freed immediately rather than lingering for its whole TTL.
    await messageRepo.delete('transient-1', DEVICE);
    expect(await messageRepo.drainFor(RECIPIENT, DEVICE)).toEqual([]);
    expect(attemptsOf('transient-1')).toBe(-1);
  });

  it('a healthy ack cycle never burns attempts on a second device', async () => {
    // Two devices → the row outlives the first ack, which is the only case where
    // an already-acked row is still around to be re-offered. It must be filtered
    // out for the device that acked, so the poison cap can never fire on a
    // device that is working perfectly.
    await devicesRepo.upsert({
      device_id: 'device-b',
      aegis_id: RECIPIENT,
      device_pub_key: 'cHVi',
      device_name: 'Second',
      platform: 'desktop',
      linked_at: Date.now(),
    });
    await messageRepo.enqueue({
      id: 'twodev-1',
      recipient: RECIPIENT,
      ciphertext_b64: 'ct',
      nonce_b64: 'nn',
      created_at: Date.now(),
      expires_at: 0,
    });

    await messageRepo.drainFor(RECIPIENT, DEVICE);
    await messageRepo.delete('twodev-1', DEVICE); // acked by device A, still pending for B
    const afterAck = attemptsOf('twodev-1');
    expect(afterAck).toBeGreaterThan(0);

    // Device A reconnects repeatedly: the row is filtered out for it every time,
    // so no amount of reconnecting can push it over MAX_DELIVERY_ATTEMPTS.
    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS + 2; i++) {
      expect(await messageRepo.drainFor(RECIPIENT, DEVICE)).toEqual([]);
    }
    expect(attemptsOf('twodev-1')).toBe(afterAck);

    // Device B finally shows up and still gets it.
    expect((await messageRepo.drainFor(RECIPIENT, 'device-b')).map((r) => r.id)).toEqual(['twodev-1']);
    await messageRepo.delete('twodev-1', 'device-b');
    expect(attemptsOf('twodev-1')).toBe(-1); // both devices acked → freed

    await devicesRepo.revoke('device-b', RECIPIENT);
  });

  it('ages out legacy expires_at=0 rows instead of replaying them forever', async () => {
    const now = Date.now();
    // Written before the expires_at migration: 0 used to mean "immortal".
    enqueueRaw('legacy-old', now - MESSAGE_TTL_MS - 60_000, 0);
    enqueueRaw('legacy-fresh', now - 60_000, 0);

    const ids = (await messageRepo.drainFor(RECIPIENT, DEVICE)).map((r) => r.id);
    expect(ids).toContain('legacy-fresh'); // still inside the TTL → still delivered
    expect(ids).not.toContain('legacy-old'); // past the TTL → no longer replayed

    await messageRepo.purgeExpired();
    expect(attemptsOf('legacy-old')).toBe(-1);
    expect(attemptsOf('legacy-fresh')).toBeGreaterThanOrEqual(0);
  });

  it('still honours a real expires_at', async () => {
    const now = Date.now();
    enqueueRaw('expired-1', now - 10_000, now - 1_000);
    enqueueRaw('live-1', now - 10_000, now + MESSAGE_TTL_MS);

    const ids = (await messageRepo.drainFor(RECIPIENT, DEVICE)).map((r) => r.id);
    expect(ids).toEqual(['live-1']);

    await messageRepo.purgeExpired();
    expect(attemptsOf('expired-1')).toBe(-1);
  });
});
