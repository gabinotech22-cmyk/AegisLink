/**
 * Tests for the openAndInit() retry logic introduced to fix the BlueStacks
 * NullPointerException on first launch (expo-sqlite JSI + New Architecture).
 *
 * Scenarios covered:
 *   1. NPE on a post-WAL execAsync (CREATE TABLE batch) — openAndInit retries
 *      and succeeds on attempt 2.
 *   2. WAL PRAGMA fails with any error — falls back to TRUNCATE journal mode
 *      without throwing, without retrying the open.
 *   3. Non-NPE error during init — propagates immediately, does NOT exhaust
 *      MAX_ATTEMPTS.
 *   4. Persistent NPE across all 8 attempts — propagates after MAX_ATTEMPTS.
 *
 * Design note:
 *   openAndInit is not exported; we exercise it through saveContact which routes
 *   db() → openAndInit().  Each test uses jest.resetModules() so local.ts starts
 *   with a clean dbPromise = null.
 *
 *   The WAL try/catch inside initSchema catches WAL errors and falls back to
 *   TRUNCATE; this is independent of openAndInit's retry loop.  For openAndInit
 *   to retry, an NPE must escape initSchema — which happens when a later execAsync
 *   (e.g. the CREATE TABLE batch, PRAGMA user_version) throws NPE.
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
    "Call to function 'NativeDatabase.execAsync' has been rejected.\nCaused by: java.lang.NullPointerException: java.lang.NullPointerException",
  );
}

// ─── Per-test module reset ────────────────────────────────────────────────────

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  jest.useFakeTimers();
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

afterEach(() => {
  jest.useRealTimers();
});

function requireLocal() {
  return require('../local') as typeof import('../local');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('openAndInit — retry logic', () => {
  /**
   * 1. NPE on a post-WAL execAsync (the CREATE TABLE batch, which is the 3rd
   *    execAsync call: WAL ok → foreign_keys ok → CREATE TABLE batch throws NPE).
   *    openAndInit must catch this, close db1, wait the backoff, then open db2
   *    which succeeds completely.
   */
  it('1. NPE on post-WAL execAsync retries and succeeds on attempt 2', async () => {
    const db1 = makeMockDb();
    const db2 = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock
      .mockResolvedValueOnce(db1)
      .mockResolvedValueOnce(db2);

    // execAsync call sequence on db1:
    //   call 1 → PRAGMA WAL           (resolves)
    //   call 2 → PRAGMA foreign_keys  (resolves)
    //   call 3 → CREATE TABLE batch   (throws NPE)
    // openAndInit catches the NPE → closes db1 → opens db2 → db2 succeeds.
    db1.execAsync
      .mockResolvedValueOnce(undefined)  // WAL
      .mockResolvedValueOnce(undefined)  // foreign_keys
      .mockRejectedValueOnce(makeNpeError()); // CREATE TABLE — triggers openAndInit retry

    const { saveContact } = requireLocal();

    const savePromise = saveContact({
      aegisId: 'TEST-001',
      publicKeyB64: 'pubkey',
      name: 'Test',
      verified: false,
      addedAt: 1_000_000,
    });
    // Drain the 100 ms backoff for attempt 1.
    await jest.advanceTimersByTimeAsync(100);
    await savePromise;

    // openDatabaseAsync called twice: db1 failed initSchema, db2 succeeded.
    expect(openMock).toHaveBeenCalledTimes(2);
    // db1's partial handle was closed before retrying.
    expect(db1.closeAsync).toHaveBeenCalledTimes(1);
    // db2 ran all execAsync calls without error.
    expect(db2.execAsync).toHaveBeenCalled();
  });

  /**
   * 2. The journal-mode PRAGMA is DELETE (never WAL — WAL's shared-memory VFS is
   *    the source of the execAsync NPE on x86 emulators / BlueStacks). A failure
   *    setting the journal mode is non-fatal: initSchema swallows it (DELETE is
   *    already the SQLite default) and continues. The open is NOT retried for it.
   */
  it('2. journal_mode is DELETE and a journal-PRAGMA failure is non-fatal', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    // First execAsync (journal_mode = DELETE) throws — must be swallowed by
    // initSchema's try/catch; the rest of init proceeds and succeeds.
    const journalError = new Error('unable to open database file: shared memory');
    mockDb.execAsync
      .mockRejectedValueOnce(journalError)  // journal pragma fails → caught
      .mockResolvedValue(undefined);        // foreign_keys + all subsequent succeed

    const { saveContact } = requireLocal();

    // Must resolve without error — the journal-mode failure was swallowed.
    await saveContact({
      aegisId: 'WAL-002',
      publicKeyB64: 'pk2',
      name: 'WalTest',
      verified: false,
      addedAt: 2_000_000,
    });

    // Only one open — the failure is swallowed inside initSchema, not a reopen.
    expect(openMock).toHaveBeenCalledTimes(1);
    // The journal-mode PRAGMA we attempt is DELETE, and WAL is never used.
    const calls = (mockDb.execAsync.mock.calls as string[][]).map((c) => c[0]);
    expect(calls.some((s) => s.includes('journal_mode = DELETE'))).toBe(true);
    expect(calls.some((s) => s.includes('WAL'))).toBe(false);
  });

  /**
   * 3. A non-NPE error during initSchema propagates immediately.
   *    openAndInit must NOT exhaust MAX_ATTEMPTS — it should throw on attempt 1.
   */
  it('3. non-NPE error propagates immediately without exhausting MAX_ATTEMPTS', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    // WAL succeeds, foreign_keys succeeds, CREATE TABLE batch throws a disk I/O error.
    const ioError = new Error('disk I/O error');
    mockDb.execAsync
      .mockResolvedValueOnce(undefined)  // WAL
      .mockResolvedValueOnce(undefined)  // foreign_keys
      .mockRejectedValueOnce(ioError);   // CREATE TABLE batch

    const { saveContact } = requireLocal();

    await expect(
      saveContact({
        aegisId: 'IO-003',
        publicKeyB64: 'pk3',
        name: 'IoTest',
        verified: false,
        addedAt: 3_000_000,
      }),
    ).rejects.toThrow('disk I/O error');

    // Only one open — non-NPE errors do not trigger openAndInit retry.
    expect(openMock).toHaveBeenCalledTimes(1);
  });

  /**
   * 4. Persistent NPE across all MAX_ATTEMPTS (8).
   *    openAndInit must propagate the error after the 8th failed attempt.
   *    The NPE is injected on the 3rd execAsync call (CREATE TABLE batch) so that
   *    journal_mode = DELETE and foreign_keys succeed on every attempt before the
   *    NPE fires (journal_mode is itself wrapped in try/catch, so it must NOT throw
   *    here or the count of survived execAsync calls would shift).
   */
  it('4. persistent NPE across all 8 attempts propagates after MAX_ATTEMPTS', async () => {
    const MAX_ATTEMPTS = 8;
    const dbs = Array.from({ length: MAX_ATTEMPTS }, () => makeMockDb());
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    for (const d of dbs) {
      openMock.mockResolvedValueOnce(d);
      // journal_mode = DELETE and foreign_keys succeed; the CREATE TABLE batch
      // always throws NPE.
      d.execAsync
        .mockResolvedValueOnce(undefined) // PRAGMA journal_mode = DELETE
        .mockResolvedValueOnce(undefined) // PRAGMA foreign_keys = ON
        .mockRejectedValue(makeNpeError()); // CREATE TABLE batch — persistent NPE
    }

    const { saveContact } = requireLocal();

    // Attach the rejection handler BEFORE advancing timers so that the promise
    // is never in an "unhandled rejection" state (which would cause Node to fire
    // `unhandledRejection` and Jest to fail the test prematurely).
    const rejectAssertion = expect(
      saveContact({
        aegisId: 'FAIL-004',
        publicKeyB64: 'pk4',
        name: 'FailTest',
        verified: false,
        addedAt: 4_000_000,
      }),
    ).rejects.toThrow('NullPointerException');

    // Drain all 7 growing backoffs between the 8 attempts:
    // 100 + 200 + 300 + 400 + 500 + 600 + 700 = 2800 ms.
    await jest.advanceTimersByTimeAsync(2800);

    // Confirm the rejection assertion (throws if it didn't reject as expected).
    await rejectAssertion;

    // Exactly MAX_ATTEMPTS = 8 opens were attempted.
    expect(openMock).toHaveBeenCalledTimes(MAX_ATTEMPTS);
    // Each of the first 7 failed handles was closed before the next attempt.
    for (let i = 0; i < MAX_ATTEMPTS - 1; i++) {
      expect(dbs[i].closeAsync).toHaveBeenCalledTimes(1);
    }
    // The 8th handle is NOT closed by openAndInit (it re-throws instead).
    expect(dbs[MAX_ATTEMPTS - 1].closeAsync).not.toHaveBeenCalled();
  });
});
