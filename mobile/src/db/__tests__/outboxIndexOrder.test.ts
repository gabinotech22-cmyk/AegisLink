/**
 * Regression test for the "no such column: next_attempt_at" brick.
 *
 * Symptom (shipped iOS build, 2026-09): the onboarding screen failed with
 *   Impossibile generare l'identita
 *   Calling the 'execAsync' function has failed -> no such column: next_attempt_at
 *
 * Root cause: the base CREATE-TABLE execAsync batch also created the outbox
 * indexes `idx_outbox_due` (ON next_attempt_at, schema v13) and
 * `idx_outbox_bubble` (ON bubble_id, v14). On any DB whose `outbox` table
 * predated those columns (installs from v5-v12), `CREATE TABLE IF NOT EXISTS
 * outbox` is a no-op so the columns did not exist yet, and the CREATE INDEX
 * threw. Because that single batch also creates identity/contacts/messages,
 * initSchema aborted and EVERY DB op failed -- including identity generation,
 * which is why a messaging bug presented as "cannot create an account".
 *
 * Two invariants keep it dead, and this file asserts both:
 *   1. The batch that creates `outbox` must not create an index on a column
 *      added by a later migration.
 *   2. Both indexes (and both columns) must be (re)applied unconditionally
 *      after the migrations, so recovery never depends on user_version being
 *      an honest account of which columns actually exist.
 *
 * Uses the expo-sqlite string-capture mock: no real SQLite engine needed.
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

/** Strip SQL line comments so assertions match real statements, not prose. */
function sqlOnly(batch: string): string {
  return batch
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');
}

/** Drive initSchema with a mocked DB reporting `userVersion`; capture the SQL. */
async function captureSchemaSql(userVersion: number): Promise<string[]> {
  const execCalls: string[] = [];
  const mockDb = {
    execAsync: jest.fn().mockImplementation((sql: string) => {
      execCalls.push(sql);
      return Promise.resolve(undefined);
    }),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    getFirstAsync: jest.fn().mockResolvedValue({ user_version: userVersion }),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
  (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

  // Any DB-touching op triggers db() -> openAndInit -> initSchema.
  const { saveContact } = require('../local') as typeof import('../local');
  await saveContact({
    aegisId: 'IDX-001',
    publicKeyB64: 'pk',
    name: 'IdxTest',
    verified: false,
    addedAt: 1_000_000,
  });
  return execCalls;
}

describe('initSchema - outbox index ordering (no such column regression)', () => {
  it('never indexes a migration-added column in the batch that creates outbox', async () => {
    // user_version 5 = an OLD install whose outbox predates next_attempt_at
    // (v13) and bubble_id (v14): the exact cohort that used to brick.
    const execCalls = await captureSchemaSql(5);

    const baseBatchIdx = execCalls.findIndex((s) =>
      s.includes('CREATE TABLE IF NOT EXISTS outbox'),
    );
    expect(baseBatchIdx).toBeGreaterThanOrEqual(0);

    // Comments are stripped: the batch legitimately *documents* these indexes,
    // and a naive substring check would pass/fail on the prose instead of SQL.
    const baseSql = sqlOnly(execCalls[baseBatchIdx]);
    expect(baseSql).not.toContain('idx_outbox_due');
    expect(baseSql).not.toContain('idx_outbox_bubble');

    // Both must be created by a LATER call, once the columns are guaranteed.
    const dueIdx = execCalls.findIndex(
      (s) => s.includes('idx_outbox_due') && s.includes('ON outbox(next_attempt_at)'),
    );
    const bubbleIdx = execCalls.findIndex(
      (s) => s.includes('idx_outbox_bubble') && s.includes('ON outbox(bubble_id)'),
    );
    expect(dueIdx).toBeGreaterThan(baseBatchIdx);
    expect(bubbleIdx).toBeGreaterThan(baseBatchIdx);
  });

  it('re-applies outbox columns and indexes even when user_version says v14', async () => {
    // The dangerous case the version gates alone cannot cover: a DB claiming to
    // be fully migrated while the columns are absent. Recovery must not depend
    // on the version counter being truthful.
    const execCalls = await captureSchemaSql(14);
    const joined = execCalls.join('\n');

    expect(joined).toContain('ADD COLUMN next_attempt_at');
    expect(joined).toContain('ADD COLUMN bubble_id');
    expect(joined).toContain('idx_outbox_due');
    expect(joined).toContain('idx_outbox_bubble');
  });
});
