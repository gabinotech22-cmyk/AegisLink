/**
 * Regression test — upgrading from a pre-v13/v14 DB must not crash with
 * "no such column: next_attempt_at" / "no such column: bubble_id".
 *
 * Root cause: initSchema's unconditional CREATE TABLE batch used to also
 * unconditionally CREATE INDEX idx_outbox_due ON outbox(next_attempt_at) and
 * idx_outbox_bubble ON outbox(bubble_id). CREATE TABLE IF NOT EXISTS is a
 * no-op when the outbox table already exists from an older install, but
 * CREATE INDEX is NOT gated on the table being newly created — it ran
 * anyway, against columns that only get added later by the v13/v14
 * migrations. Real users hit this as "Impossibile generare l'identità" /
 * execAsync failing on first launch after updating the app.
 *
 * This mock simulates a real SQLite engine closely enough to catch that
 * ordering bug: it tracks which columns the (pre-existing) outbox table
 * actually has, and throws "no such column" if a CREATE INDEX statement
 * references a column that hasn't been added via ALTER TABLE yet.
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
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

function requireLocal() {
  return require('../local') as typeof import('../local');
}

/** Fake SQLite engine that only understands the handful of statement shapes
 * initSchema emits, and models a pre-existing "outbox" table (an install
 * that predates the v13/v14 migrations) missing next_attempt_at/bubble_id. */
function makeUpgradingDb() {
  const outboxColumns = new Set([
    'job_id', 'msg_id', 'recipient_aegis_id', 'recipient_pubkey_b64',
    'payload', 'kind', 'group_id', 'created_at', 'attempts',
  ]);
  const tablesThatAlreadyExist = new Set(['outbox']);

  const execAsync = jest.fn(async (sql: string) => {
    const statements = sql.split(';').map((s) => s.trim()).filter(Boolean);
    for (const stmt of statements) {
      const createTable = stmt.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      if (createTable) {
        tablesThatAlreadyExist.add(createTable[1]);
        continue;
      }

      const createIndex = stmt.match(/CREATE INDEX IF NOT EXISTS \w+ ON (\w+)\((\w+)\)/i);
      if (createIndex) {
        const [, table, column] = createIndex;
        if (table === 'outbox' && !outboxColumns.has(column)) {
          throw new Error(
            `Calling the 'execAsync' function has failed\n→ Caused by: no such column: ${column}`,
          );
        }
        continue;
      }

      const alterAddColumn = stmt.match(/ALTER TABLE (\w+) ADD COLUMN (\w+)/i);
      if (alterAddColumn) {
        const [, table, column] = alterAddColumn;
        if (table === 'outbox') outboxColumns.add(column);
        continue;
      }
      // PRAGMA / DELETE / other statements — no-op.
    }
  });

  return {
    execAsync,
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    // Simulate an install that upgraded through v12 (pre-outbox-retry-schedule).
    getFirstAsync: jest.fn().mockResolvedValue({ user_version: 12 }),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

describe('schema — outbox index creation on upgrade', () => {
  it('does not throw "no such column" when opening a pre-v13 DB', async () => {
    const mockDb = makeUpgradingDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { saveContact } = requireLocal();

    await expect(
      saveContact({
        aegisId: 'UPGRADE-001',
        publicKeyB64: 'pk',
        name: 'Upgrader',
        verified: false,
        addedAt: 1_000_000,
      }),
    ).resolves.toBeUndefined();

    // The version-gated migration must have actually run the ALTER TABLE.
    const alterCalls = (mockDb.execAsync.mock.calls as string[][])
      .map((c) => c[0])
      .filter((s) => s.includes('ALTER TABLE outbox ADD COLUMN next_attempt_at'));
    expect(alterCalls.length).toBeGreaterThan(0);
  });
});
