/**
 * Regression tests for the withDb NullPointerException retry wrapper.
 *
 * Core scenarios verified:
 *   1. Normal path: fn() is called once, result is returned, no retry.
 *   2. NPE retry: error containing "NullPointerException" causes dbPromise reset
 *      and exactly one retry with a fresh handle.
 *   3. No second retry: if the retry itself throws NPE the error propagates.
 *   4. Non-NPE errors are re-thrown immediately without retry.
 *   5. saveMessage (encrypt + runAsync inside callback) retries on NPE.
 *   6. loadMessagesByChat retries on NPE and returns results from fresh db.
 *   7. saveRatchetSession (encrypt inside callback) retries on NPE.
 *   8. setMessageDeleted (encrypt empty string inside callback) retries on NPE.
 *   9. saveContact (no encrypt) retries on NPE.
 *  10. loadContacts (no encrypt) retries on NPE and returns results from fresh db.
 *  11. After an NPE retry the resolved db2 is reused for subsequent calls.
 *
 * Implementation note:
 *   local.ts keeps dbPromise as module-level state. We use jest.resetModules()
 *   + require() inside each test to start with a fresh module instance (clean
 *   dbPromise = null). Top-level jest.mock() calls are hoisted by Babel and
 *   register the mock factories; individual tests then configure the mocks with
 *   mockImplementation / mockResolvedValueOnce before require-ing local.ts.
 */

// ─── Top-level mock registrations (Babel-hoisted) ────────────────────────────

// Prefixed with "mock" so Babel allows the reference inside jest.mock() factories.
const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

jest.mock('expo-sqlite', () => ({
  // openDatabaseAsync is configured per-test via openDbMock.mockImplementation.
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
}));

jest.mock('../../utils/secureStore', () => ({
  ss: {
    // Returns a fixed 32-byte key so nacl.secretbox succeeds.
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
    "Call to function 'NativeDatabase.prepareAsync' has been rejected.\nCaused by: java.lang.NullPointerException: java.lang.NullPointerException"
  );
}

// ─── Per-test module reset ────────────────────────────────────────────────────
// Each test calls jest.resetModules() so local.ts is re-evaluated with a fresh
// dbPromise = null. The mocks remain registered (jest.mock() is not cleared),
// but their implementations are cleared to prevent cross-test pollution.

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  // Re-apply the stable mock for ss.get (cleared by clearAllMocks).
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock; set: jest.Mock; delete: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

// Convenience: require local.ts inside a test after mocks are configured.
function requireLocal() {
  return require('../local') as typeof import('../local');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('withDb — NullPointerException retry wrapper', () => {

  it('1. normal path: returns without retry', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { saveContact } = requireLocal();

    await saveContact({
      aegisId: 'ALICE-001',
      publicKeyB64: 'pubkey',
      name: 'Alice',
      verified: true,
      addedAt: 1_000_000,
    });

    // openDatabaseAsync called once (no retry).
    expect(openMock).toHaveBeenCalledTimes(1);
    // runAsync called twice: once for the schema-init expired-message purge,
    // once for the actual saveContact insert.
    expect(mockDb.runAsync).toHaveBeenCalledTimes(2);
  });

  it('2. NPE on first call: resets dbPromise and retries once with fresh handle', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    db1.runAsync.mockRejectedValueOnce(makeNpeError());

    const { saveContact } = requireLocal();

    await saveContact({
      aegisId: 'BOB-002',
      publicKeyB64: 'pubkey2',
      name: 'Bob',
      verified: false,
      addedAt: 1_000_001,
    });

    // db1 initial + db2 retry = 2 opens.
    expect(openMock).toHaveBeenCalledTimes(2);
    // db2 runAsync: once for schema-init expired purge, once for saveContact.
    expect(db2.runAsync).toHaveBeenCalledTimes(2);
  });

  it('3. NPE that persists across every retry: propagates without infinite loop', async () => {
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    // Every connection fails with NPE — simulates a device where the JSI handle
    // never recovers within the cold-start window. withDb must give up after a
    // bounded number of attempts (no infinite loop) and surface the NPE.
    const makeFailingDb = () => {
      const d = makeMockDb();
      d.runAsync.mockRejectedValue(makeNpeError());
      return d;
    };
    openMock.mockImplementation(() => Promise.resolve(makeFailingDb()));

    const { saveContact } = requireLocal();

    await expect(
      saveContact({
        aegisId: 'CAROL-003',
        publicKeyB64: 'pk3',
        name: 'Carol',
        verified: false,
        addedAt: 1_000_002,
      })
    ).rejects.toThrow('NullPointerException');

    // initial attempt + MAX_RETRIES(3) = 4 total opens, then it gives up.
    expect(openMock).toHaveBeenCalledTimes(4);
  });

  it('4. non-NPE error is re-thrown immediately without retry', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const domainError = new Error('UNIQUE constraint failed: contacts.aegis_id');
    mockDb.runAsync.mockRejectedValueOnce(domainError);

    const { saveContact } = requireLocal();

    await expect(
      saveContact({
        aegisId: 'DUP-004',
        publicKeyB64: 'pk4',
        name: 'Dup',
        verified: false,
        addedAt: 1_000_003,
      })
    ).rejects.toThrow('UNIQUE constraint failed');

    // Only one open — retry was never triggered.
    expect(openMock).toHaveBeenCalledTimes(1);
    expect(mockDb.runAsync).toHaveBeenCalledTimes(1);
  });

  it('5. saveMessage: NPE from runAsync retries (encrypt is inside callback)', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    db1.runAsync.mockRejectedValueOnce(makeNpeError());

    const { saveMessage } = requireLocal();

    await saveMessage({
      id: 'msg-001',
      chatId: 'chat-alice',
      direction: 'out',
      body: 'Hello from test',
      createdAt: 1_000_004,
    });

    expect(openMock).toHaveBeenCalledTimes(2);
    // db2: schema-init purge + saveMessage insert.
    expect(db2.runAsync).toHaveBeenCalledTimes(2);
  });

  it('6. loadMessagesByChat: NPE retries and returns empty array from fresh db', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    db1.getAllAsync.mockRejectedValueOnce(makeNpeError());
    db2.getAllAsync.mockResolvedValueOnce([]);

    const { loadMessagesByChat } = requireLocal();

    const result = await loadMessagesByChat('chat-alice');

    expect(result).toEqual([]);
    expect(openMock).toHaveBeenCalledTimes(2);
    expect(db2.getAllAsync).toHaveBeenCalledTimes(1);
  });

  it('7. saveRatchetSession: NPE retries (encrypt inside callback)', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    db1.runAsync.mockRejectedValueOnce(makeNpeError());

    const { saveRatchetSession } = requireLocal();

    await saveRatchetSession('ALICE-001', JSON.stringify({ DHs: null, Ns: 0 }));

    expect(openMock).toHaveBeenCalledTimes(2);
    // db2: schema-init purge + saveRatchetSession insert.
    expect(db2.runAsync).toHaveBeenCalledTimes(2);
  });

  it('8. setMessageDeleted: NPE retries (encryptBody inside callback)', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    db1.runAsync.mockRejectedValueOnce(makeNpeError());

    const { setMessageDeleted } = requireLocal();

    await setMessageDeleted('msg-to-delete');

    expect(openMock).toHaveBeenCalledTimes(2);
    // db2: schema-init purge + setMessageDeleted UPDATE.
    expect(db2.runAsync).toHaveBeenCalledTimes(2);
  });

  it('9. saveContact (no encrypt): NPE retries successfully', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    db1.runAsync.mockRejectedValueOnce(makeNpeError());

    const { saveContact } = requireLocal();

    await saveContact({
      aegisId: 'EVE-009',
      publicKeyB64: 'pk9',
      name: 'Eve',
      verified: true,
      addedAt: 1_000_008,
    });

    expect(openMock).toHaveBeenCalledTimes(2);
    // db2: schema-init purge + saveContact insert.
    expect(db2.runAsync).toHaveBeenCalledTimes(2);
  });

  it('10. loadContacts (no encrypt): NPE retries and returns empty array', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    db1.getAllAsync.mockRejectedValueOnce(makeNpeError());
    db2.getAllAsync.mockResolvedValueOnce([]);

    const { loadContacts } = requireLocal();

    const result = await loadContacts();

    expect(result).toEqual([]);
    expect(openMock).toHaveBeenCalledTimes(2);
  });
});

describe('withDb — dbPromise post-retry reuse', () => {
  it('11. after NPE retry, resolved db2 is reused for subsequent calls', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const db3 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2)
      .mockResolvedValueOnce(db3);

    db1.runAsync.mockRejectedValueOnce(makeNpeError());

    const { saveContact, loadContacts } = requireLocal();

    // First call: NPE on db1, retries on db2 — db2 is now cached as dbPromise.
    await saveContact({
      aegisId: 'FRANK-011',
      publicKeyB64: 'pk11',
      name: 'Frank',
      verified: false,
      addedAt: 1_000_010,
    });

    // Second call: should reuse db2, NOT open db3.
    await loadContacts();

    // db3 was never needed — db2 was reused.
    expect(db3.getAllAsync).not.toHaveBeenCalled();
    // db2 handled the getAllAsync for loadContacts.
    expect(db2.getAllAsync).toHaveBeenCalledTimes(1);
    // Total opens: db1 + db2 = 2 (db3 never opened).
    expect(openMock).toHaveBeenCalledTimes(2);
  });
});

describe('withDb — serialized access (FIFO queue)', () => {
  it('12. never runs two DB operations concurrently on the handle', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    let active = 0;
    let maxConcurrent = 0;
    // Each runAsync holds the handle briefly; the queue must prevent overlap.
    mockDb.runAsync.mockImplementation(async () => {
      active += 1;
      maxConcurrent = Math.max(maxConcurrent, active);
      await new Promise<void>((r) => setTimeout(r, 5));
      active -= 1;
      return { lastInsertRowId: 1, changes: 1 };
    });

    const { saveContact } = requireLocal();

    // Fire several operations WITHOUT awaiting between them — they would race
    // on the native handle if access were not serialized.
    await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        saveContact({
          aegisId: `USER-01${i}`,
          publicKeyB64: `pk${i}`,
          name: `User ${i}`,
          verified: false,
          addedAt: 1_000_100 + i,
        }),
      ),
    );

    // The whole point of the fix: at most one operation touches the DB at a time.
    expect(maxConcurrent).toBe(1);
  });
});
