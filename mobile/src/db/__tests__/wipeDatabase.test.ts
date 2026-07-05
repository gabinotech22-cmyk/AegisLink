/**
 * wipeDatabase — panic-wipe completeness tests.
 *
 * Panic mode's entire promise is that ONE call removes every trace. These
 * tests lock in:
 *   1. Every SQLite table is deleted and VACUUM runs afterwards (freed pages
 *      zeroed so forensic reads of the raw file find nothing).
 *   2. All SecureStore key material is purged: identity secret keys, the
 *      at-rest DB encryption key, X3DH prekey secrets (SPK + every OPK id in
 *      the stored list), slot bookkeeping, and the forensic remnants
 *      (panic config, preferences) whose mere existence would reveal that a
 *      panic-enabled account lived on the device.
 *   3. Lock.tsx duress flow wipes BEFORE flagging decoy mode (source-order
 *      regression, same style as audit-regression.test.ts).
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

describe('Lock.tsx duress flow — wipe-before-decoy ordering (source regression)', () => {
  it('the duress branch calls wipeDatabase BEFORE flagging duressActive', () => {
    // If interrupted mid-flow (battery pull, force-close) the REAL data must
    // already be gone; showing the decoy is only ever the second step.
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'screens', 'Lock.tsx'),
      'utf8',
    );
    const wipeIdx = src.indexOf('await wipeDatabase()');
    const decoyIdx = src.indexOf('duressActive: true');
    expect(wipeIdx).toBeGreaterThan(-1);
    expect(decoyIdx).toBeGreaterThan(-1);
    expect(wipeIdx).toBeLessThan(decoyIdx);
  });
});
