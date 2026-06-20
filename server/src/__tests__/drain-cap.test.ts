/**
 * drain-cap.test.ts — security roadmap Ola 12 regressions
 *
 *   B-1: the per-message drain cap is no longer a fixed 2. It scales to the
 *        recipient's device count (1 primary + active linked devices) so a user
 *        with >2 devices does not lose a queued message before every device
 *        pulls it. The old fixed cap of 2 is kept only as a floor, so the change
 *        can never shorten a row's life → never causes under-delivery.
 *
 *   M-3: `drained_by` is JSON-in-TEXT with no DB-level shape guarantee. A
 *        corrupted / non-array payload must degrade to an empty list instead of
 *        throwing on the downstream `.includes()` / `.push()`.
 *
 * Self-contained, repo-level harness (no socket layer) so it runs scoped under
 * --runInBand without sharing state with sibling suites.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import {
  initDb,
  messageRepo,
  devicesRepo,
  parseDrainedBy,
  type LinkedDeviceRow,
} from '../db/client.js';

let seq = 0;
function enqueueMsg(recipient: string): Promise<{ ok: boolean }> {
  seq += 1;
  return messageRepo.enqueue({
    id: `msg-drain-${seq}`,
    recipient,
    ciphertext_b64: 'Y2lwaGVy',
    nonce_b64: 'bm9uY2U=',
    created_at: Date.now(),
    expires_at: 0,
  });
}

function linkDevice(aegisId: string, deviceId: string): Promise<void> {
  const row: Omit<LinkedDeviceRow, 'revoked'> = {
    device_id: deviceId,
    aegis_id: aegisId,
    device_pub_key: 'cHVi',
    device_name: 'Test Device',
    platform: 'desktop',
    linked_at: Date.now(),
  };
  return devicesRepo.upsert(row);
}

beforeAll(async () => {
  await initDb();
});

describe('M-3 — parseDrainedBy validates the JSON-in-TEXT shape', () => {
  it('returns the device list for a well-formed array', () => {
    expect(parseDrainedBy('["dev-a","dev-b"]')).toEqual(['dev-a', 'dev-b']);
  });

  it('degrades malformed / non-array payloads to an empty list (never throws)', () => {
    expect(parseDrainedBy('')).toEqual([]);
    expect(parseDrainedBy(null)).toEqual([]);
    expect(parseDrainedBy(undefined)).toEqual([]);
    expect(parseDrainedBy('not json')).toEqual([]);
    expect(parseDrainedBy('42')).toEqual([]);
    expect(parseDrainedBy('{"dev":"a"}')).toEqual([]);
    expect(parseDrainedBy('null')).toEqual([]);
  });

  it('drops non-string array elements', () => {
    expect(parseDrainedBy('["dev-a",1,null,{"x":1},"dev-b"]')).toEqual(['dev-a', 'dev-b']);
  });
});

describe('B-1 — drain cap scales to the recipient device count', () => {
  it('floors at 2 for a single-device recipient (no regression)', async () => {
    const R = 'AAA-BBBB-CCCC';
    await enqueueMsg(R);
    const id = `msg-drain-${seq}`;

    // First device drains → row survives (1 < floor 2).
    await messageRepo.delete(id, 'dev-1');
    expect((await messageRepo.drainFor(R, 'dev-2')).some((r) => r.id === id)).toBe(true);

    // Second device drains → cap (2) reached → row deleted.
    await messageRepo.delete(id, 'dev-2');
    expect((await messageRepo.drainFor(R, 'dev-3')).some((r) => r.id === id)).toBe(false);
  });

  it('survives past 2 drains when the recipient has 3 devices (the fix)', async () => {
    const R = 'DDD-EEEE-FFFF';
    // 2 linked devices → total 3 (1 primary + 2 linked) → cap = max(2, 3) = 3.
    await linkDevice(R, 'dev-b');
    await linkDevice(R, 'dev-c');

    await enqueueMsg(R);
    const id = `msg-drain-${seq}`;

    await messageRepo.delete(id, 'dev-a');
    await messageRepo.delete(id, 'dev-b');
    // Under the OLD fixed cap of 2 the row would be gone here, and dev-c would
    // never receive it. With the dynamic cap it must still be pending for dev-c.
    expect((await messageRepo.drainFor(R, 'dev-c')).some((r) => r.id === id)).toBe(true);

    // Third (final) device drains → cap (3) reached → row deleted.
    await messageRepo.delete(id, 'dev-c');
    expect((await messageRepo.drainFor(R, 'dev-c')).some((r) => r.id === id)).toBe(false);
  });

  it('revoked linked devices do not inflate the cap', async () => {
    const R = 'GGG-HHHH-JJJJ';
    await linkDevice(R, 'dev-x');
    await devicesRepo.revoke('dev-x', R); // back to 0 active → cap = floor 2

    await enqueueMsg(R);
    const id = `msg-drain-${seq}`;

    await messageRepo.delete(id, 'dev-1');
    await messageRepo.delete(id, 'dev-2');
    expect((await messageRepo.drainFor(R, 'dev-3')).some((r) => r.id === id)).toBe(false);
  });
});
