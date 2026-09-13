/**
 * Regression test for the "no such column: next_attempt_at" brick.
 *
 * Root cause: the base CREATE-TABLE execAsync batch used to also create the
 * outbox indexes `idx_outbox_due` (ON next_attempt_at, added in schema v13) and
 * `idx_outbox_bubble` (ON bubble_id, added in v14). On any DB whose `outbox`
 * table predated those columns (any install from schema v5–v12), the
 * `CREATE TABLE IF NOT EXISTS outbox` in that batch is a no-op, so the columns
 * did not exist yet — and `CREATE INDEX ... ON outbox(next_attempt_at)` threw
 * `no such column: next_attempt_at`, failing the ENTIRE execAsync batch. Because
 * that batch also creates identity/contacts/messages, initSchema aborted and
 * EVERY DB op (including identity generation) failed with exactly:
 *   Calling the 'execAsync' function has failed → Caused by: no such column: next_attempt_at
 *
 * Fix: create those two indexes as separate execAsync calls at the very end of
 * initSchema — after every CREATE TABLE and every column-adding migration — so
 * the columns are guaranteed to exist on every path (fresh install via CREATE
 * TABLE, upgrade via addColumn).
 *
 * This test asserts the ORDERING invariant using the expo-sqlite string-capture
 * mock (no real SQLite engine needed): the base batch that creates `outbox` must
 * NOT contain either outbox index, and both indexes must be issued by a LATER
 * execAsync call.
 */

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

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const ss = require('expo-secure-store') as { getItemAsync: jest.Mock };
  ss.getItemAsync.mockResolvedValue(mockFixedKeyB64);
  const utils = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  utils.ss.get.mockResolvedValue(mockFixedKeyB64);
});

function requireLocal() {
  return require('../local') as typeof import('../local');
}

describe('initSchema — outbox index ordering (no such column regression)', () => {
  it('does not create outbox indexes in the same batch as CREATE TABLE outbox, and creates them after', async () => {
    // user_version = 5 simulates an OLD install whose outbox table predates
    // next_attempt_at (v13) / bubble_id (v14): the exact cohort that used to brick.
    const execCalls: string[] = [];
    const mockDb = {
      execAsync: jest.fn().mockImplementation((sql: string) => {
        execCalls.push(sql);
        return Promise.resolve(undefined);
      }),
      runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
      getAllAsync: jest.fn().mockResolvedValue([]),
      getFirstAsync: jest.fn().mockResolvedValue({ user_version: 5 }),
      closeAsync: jest.fn().mockResolvedValue(undefined),
    };
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

    // Any DB-touching op triggers db() → openAndInit → initSchema.
    const { saveContact } = requireLocal();
    await saveContact({
      aegisId: 'IDX-001',
      publicKeyB64: 'pk',
      name: 'IdxTest',
      verified: false,
      addedAt: 1_000_000,
    });

    // The base batch is the single execAsync that creates the outbox table.
    const baseBatchIdx = execCalls.findIndex(
      (s) => s.includes('CREATE TABLE IF NOT EXISTS outbox'),
    );
    expect(baseBatchIdx).toBeGreaterThanOrEqual(0);
    const baseBatch = execCalls[baseBatchIdx];

    // The batch that creates the table must NOT create either index on a
    // migration-added column — that is what threw "no such column" on old DBs.
    expect(baseBatch).not.toContain('idx_outbox_due');
    expect(baseBatch).not.toContain('idx_outbox_bubble');

    // Both indexes must be created by a LATER execAsync call (after migrations,
    // where the columns are guaranteed to exist).
    const dueIdx = execCalls.findIndex(
      (s) => s.includes('idx_outbox_due') && s.includes('ON outbox(next_attempt_at)'),
    );
    const bubbleIdx = execCalls.findIndex(
      (s) => s.includes('idx_outbox_bubble') && s.includes('ON outbox(bubble_id)'),
    );
    expect(dueIdx).toBeGreaterThan(baseBatchIdx);
    expect(bubbleIdx).toBeGreaterThan(baseBatchIdx);
  });
});
