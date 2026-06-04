/**
 * saveGroup — regression tests for the "No se pudo crear el grupo" NPE bug.
 *
 * The fix was wrapping saveGroup (and the store's createGroup) in withDb so
 * that an Android NullPointerException on the first db call triggers an
 * automatic retry with a fresh db handle.
 *
 * Covers:
 * 1. Normal path: saveGroup inserts without error, openDatabaseAsync called once
 * 2. NPE on first attempt: retries with fresh db handle (openDatabaseAsync × 2)
 * 3. Non-NPE error propagates immediately without retry
 * 4. members array is serialised as a JSON string in the db call
 * 5. After NPE retry the resolved db2 is reused for subsequent calls
 *
 * Implementation note: mirrors the jest.resetModules() + requireLocal() pattern
 * from withDb.test.ts. Each test gets a clean module instance (dbPromise = null).
 */

// ─── Top-level mock registrations (Babel-hoisted) ────────────────────────────

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

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
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  copyAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(mockFixedKeyB64),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

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

function makeNpeError(): Error {
  return new Error(
    "Call to function 'NativeDatabase.prepareAsync' has been rejected.\nCaused by: java.lang.NullPointerException: java.lang.NullPointerException",
  );
}

import type { StoredGroup } from '../local';

function makeGroup(overrides: Partial<StoredGroup> = {}): StoredGroup {
  return {
    id: 'group-abc-001',
    name: 'Secret Ops',
    members: ['alice-001', 'bob-002', 'carol-003'],
    createdAt: 1_700_000_000_000,
    avatarColor: '#00FF88',
    ...overrides,
  };
}

// ─── Per-test module reset ────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as {
    ss: { get: jest.Mock; set: jest.Mock; delete: jest.Mock };
  };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

function requireLocal() {
  return require('../local') as typeof import('../local');
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('saveGroup', () => {
  // ── 1. Normal path ──────────────────────────────────────────────────────────

  it('inserts without error on the normal path, opening the db exactly once', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { saveGroup } = requireLocal();

    await saveGroup(makeGroup());

    // db opened once — no retry triggered
    expect(openMock).toHaveBeenCalledTimes(1);
    // runAsync: schema-init purge + saveGroup INSERT OR REPLACE
    expect(mockDb.runAsync).toHaveBeenCalledTimes(2);
  });

  // ── 2. NPE on first attempt retries with fresh db handle ───────────────────

  it('retries with a fresh db handle when the first runAsync throws NullPointerException', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    // schema-init runs fine; the saveGroup INSERT throws NPE
    db1.runAsync.mockRejectedValueOnce(makeNpeError());

    const { saveGroup } = requireLocal();

    await saveGroup(makeGroup());

    // db1 initial open + db2 retry = 2 total opens
    expect(openMock).toHaveBeenCalledTimes(2);
    // db2: schema-init purge + saveGroup INSERT on retry
    expect(db2.runAsync).toHaveBeenCalledTimes(2);
    // db1 runAsync was only called once before NPE
    expect(db1.runAsync).toHaveBeenCalledTimes(1);
  });

  // ── 3. Non-NPE error propagates immediately without retry ──────────────────

  it('propagates a non-NPE error immediately without retrying', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const domainError = new Error('UNIQUE constraint failed: groups.id');
    mockDb.runAsync.mockRejectedValueOnce(domainError);

    const { saveGroup } = requireLocal();

    await expect(saveGroup(makeGroup())).rejects.toThrow('UNIQUE constraint failed');

    // Only one open — no retry
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  // ── 4. members array is serialised as JSON string in the db call ───────────

  it('serialises the members array to a JSON string when calling runAsync', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { saveGroup } = requireLocal();
    const group = makeGroup({ members: ['alice-001', 'bob-002', 'carol-003'] });

    await saveGroup(group);

    // Find the INSERT OR REPLACE call among all runAsync calls
    const insertCall = (mockDb.runAsync.mock.calls as unknown[][]).find(
      (args) => typeof args[0] === 'string' && (args[0] as string).includes('INSERT OR REPLACE INTO groups'),
    );
    expect(insertCall).toBeDefined();
    // Fourth positional argument is the members column value
    // SQL columns: (id, name, members, ...) → args[1]=id, args[2]=name, args[3]=members
    const membersArg = insertCall![3];
    expect(membersArg).toBe(JSON.stringify(['alice-001', 'bob-002', 'carol-003']));
  });

  // ── 5. After NPE retry, resolved db2 is reused for subsequent calls ────────

  it('reuses db2 (not db3) for calls made after a successful NPE retry', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const db3 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2)
      .mockResolvedValueOnce(db3);

    db1.runAsync.mockRejectedValueOnce(makeNpeError());

    const { saveGroup, loadGroups } = requireLocal();

    // First call: NPE on db1 → retries on db2 → db2 is now cached as dbPromise
    await saveGroup(makeGroup({ id: 'grp-first' }));

    // Second call: should reuse db2, NOT open db3
    await loadGroups();

    expect(db3.getAllAsync).not.toHaveBeenCalled();
    expect(db2.getAllAsync).toHaveBeenCalledTimes(1);
    // Total opens: db1 + db2 = 2
    expect(openMock).toHaveBeenCalledTimes(2);
  });
});
