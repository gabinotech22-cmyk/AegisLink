/**
 * wipeDatabase — panic-wipe completeness tests.
 *
 * Panic mode's entire promise is that ONE call removes every trace. These
 * tests lock in:
 *   1. Every SQLite table is deleted and VACUUM runs afterwards (freed pages
 *      zeroed so forensic reads of the raw file find nothing).
 *   2. All SecureStore key material is purged: identity secret keys, the
 *      at-rest DB encryption key, X3DH prekey secrets (SPK + every OPK id in
 *      the stored list), slot bookkeeping, the forensic remnants
 *      (panic config, preferences) whose mere existence would reveal that a
 *      panic-enabled account lived on the device, AND the app-lock PIN hash
 *      + salt — otherwise the old PIN keeps gating the lock screen after a
 *      wipe/re-onboarding, and its survival would itself prove an app-lock
 *      was configured.
 *   3. Lock.tsx duress (coercion) flow is HIDE + REVERSIBLE and never calls
 *      wipeDatabase — only the lock-screen gestures, the remote wipe deep
 *      link, auto-wipe-on-max-attempts, and the manual Panic button may
 *      destroy data (source-order regression, same style as
 *      audit-regression.test.ts).
 */
import fs from 'node:fs';
import path from 'node:path';

jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  SQLiteDatabase: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///test/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  moveAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(mockFixedKeyB64),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

function makeMockDb() {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    withTransactionAsync: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

type MockDb = ReturnType<typeof makeMockDb>;

const EXPECTED_TABLES = [
  'identity', 'messages', 'contacts', 'groups', 'ratchet_sessions',
  'chat_state', 'call_history', 'polls', 'scheduled_messages', 'prekey_secrets',
];

async function runWipe(opts?: { opkIds?: number[] }): Promise<{ db: MockDb; deletedKeys: string[] }> {
  jest.resetModules();
  jest.clearAllMocks();

  const sqlite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
  const db = makeMockDb();
  sqlite.openDatabaseAsync.mockResolvedValue(db);

  const SecureStore = require('expo-secure-store') as {
    getItemAsync: jest.Mock;
    deleteItemAsync: jest.Mock;
  };
  SecureStore.getItemAsync.mockImplementation((key: string) => {
    if (key === 'aegis.opkIds.json' && opts?.opkIds) return Promise.resolve(JSON.stringify(opts.opkIds));
    return Promise.resolve(null);
  });

  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);

  const { wipeDatabase } = require('../local') as typeof import('../local');
  await wipeDatabase();

  const deletedKeys = SecureStore.deleteItemAsync.mock.calls.map((c: string[]) => c[0]);
  return { db, deletedKeys };
}

describe('wipeDatabase — SQLite', () => {
  it('deletes every table and VACUUMs afterwards', async () => {
    const { db } = await runWipe();
    const execCalls = db.execAsync.mock.calls.map((c) => String(c[0]));
    const deleteBatch = execCalls.find((sql) => sql.includes('DELETE FROM identity'));
    expect(deleteBatch).toBeDefined();
    for (const table of EXPECTED_TABLES) {
      expect(deleteBatch).toContain(`DELETE FROM ${table}`);
    }
    // VACUUM must run AFTER the deletes so the freed pages are overwritten.
    const deleteIdx = execCalls.findIndex((sql) => sql.includes('DELETE FROM identity'));
    const vacuumIdx = execCalls.findIndex((sql) => sql.includes('VACUUM'));
    expect(vacuumIdx).toBeGreaterThan(deleteIdx);
  });
});

describe('wipeDatabase — SecureStore key material', () => {
  it('purges identity keys, DB encryption key, slot bookkeeping and forensic remnants', async () => {
    const { deletedKeys } = await runWipe();
    const core = require('../core') as typeof import('../core');
    // Identity + at-rest encryption keys for the active slot.
    expect(deletedKeys).toContain(core.getSecretKeySlot());
    expect(deletedKeys).toContain(core.getSignSecretKeySlot());
    expect(deletedKeys).toContain(core.getDbEncKeySlot());
    // Multi-profile bookkeeping.
    expect(deletedKeys).toContain('aegis.slotsList');
    expect(deletedKeys).toContain('aegis.activeSlotId');
    // Forensic remnants: without these deletions, post-wipe analysis could
    // prove a panic-enabled account existed on the device.
    expect(deletedKeys).toContain('aegis.panic.v1');
    expect(deletedKeys).toContain('aegis.preferences.v1');
    expect(deletedKeys).toContain('aegis.polls.v1');
    // The decoy blob itself: surviving it would prove duress mode existed.
    expect(deletedKeys).toContain('aegis.duress.decoy.v1');
    // App-lock PIN material: a surviving hash/salt keeps the old PIN gating
    // the lock screen post-wipe and proves an app-lock existed (forensic leak).
    expect(deletedKeys).toContain('aegis.pin.hash');
    expect(deletedKeys).toContain('aegis.pin.salt.v2');
    // Legacy v1 lock-settings blob (still present on upgraded devices).
    expect(deletedKeys).toContain('aegis.lockSettings');
  });

  it('purges the SPK and every OPK secret listed in aegis.opkIds.json', async () => {
    const { deletedKeys } = await runWipe({ opkIds: [3, 17] });
    expect(deletedKeys).toContain('aegis.opkSecret.3');
    expect(deletedKeys).toContain('aegis.opkSecret.17');
    expect(deletedKeys).toContain('aegis.spkSecret.3');
    expect(deletedKeys).toContain('aegis.spkSecret.17');
    expect(deletedKeys).toContain('aegis.opkIds.json');
    expect(deletedKeys).toContain('aegis.spkSecret.b64');
    expect(deletedKeys).toContain('aegis.spk.keyId');
  });
});

describe('Lock.tsx duress flow — hide-and-reversible, never destructive (source regression)', () => {
  it('the duress branch does NOT call wipeDatabase before (or as part of) flagging duressActive', () => {
    // Product model: the duress PIN HIDES the real account behind a decoy and
    // is fully REVERSIBLE — it must never wipe real data. Only the lock-screen
    // gestures, the remote wipe deep link, auto-wipe-on-max-attempts, and the
    // manual Panic button are allowed to call wipeDatabase().
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'screens', 'Lock.tsx'),
      'utf8',
    );
    const decoyIdx = src.indexOf('duressActive: true');
    expect(decoyIdx).toBeGreaterThan(-1);

    // Find the duress branch: from the duressPin config check up to the next
    // top-level PIN check (the real-PIN branch starts at "const ok = hasPIN").
    const duressBranchStart = src.indexOf('if (config.duressPin');
    const duressBranchEnd = src.indexOf('const ok = hasPIN ? await verifyPIN');
    expect(duressBranchStart).toBeGreaterThan(-1);
    expect(duressBranchEnd).toBeGreaterThan(duressBranchStart);

    const duressBranch = src.slice(duressBranchStart, duressBranchEnd);
    expect(duressBranch).not.toContain('wipeDatabase()');
    expect(duressBranch).toContain('duressActive: true');
  });

  it('wipeDatabase remains present for the real destructive paths (auto-wipe on max attempts)', () => {
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'screens', 'Lock.tsx'),
      'utf8',
    );
    // Two legitimate call sites: biometric auto-wipe and PIN auto-wipe.
    const matches = src.match(/await wipeDatabase\(\)/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});
