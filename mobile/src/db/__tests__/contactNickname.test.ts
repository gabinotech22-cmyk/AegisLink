/**
 * contacts.nickname — the local nickname has its own column: it round-trips,
 * column `name` keeps the announced profile name, the read-back `name` is the
 * effective display name, and an existing DB gains the column by migration.
 * Same mocked expo-sqlite harness as contactRelayOnion.test.ts.
 */

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn(), SQLiteDatabase: jest.fn() }));
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
  ss: { get: jest.fn().mockResolvedValue(mockFixedKeyB64), set: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) },
}));

import type { StoredContact } from '../contacts';

function makeMockDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const execAsync = jest.fn().mockResolvedValue(undefined);
  return {
    rows,
    execAsync,
    runAsync: jest.fn().mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('INTO contacts')) {
        const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        rows.set(String(row['aegis_id']), row);
      }
      return { lastInsertRowId: 1, changes: 1 };
    }),
    getAllAsync: jest.fn().mockResolvedValue([]),
    getFirstAsync: jest.fn().mockImplementation(async (_sql: string, aegisId: string) => rows.get(aegisId) ?? null),
    withTransactionAsync: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

const ID = 'ABC-DEFG-HJKM';
function makeContact(overrides: Partial<StoredContact> = {}): StoredContact {
  return { aegisId: ID, publicKeyB64: 'A'.repeat(43) + '=', name: 'Alice', verified: true, addedAt: 1_700_000_000_000, ...overrides };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

describe('contacts.nickname', () => {
  it('nickname and announced name live in separate columns and read back as the effective name', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveContact, getContact } = require('../contacts') as typeof import('../contacts');

    await saveContact(makeContact({ name: 'Mamá', nickname: 'Mamá', profileName: 'Carmen García' }));
    const row = db.rows.get(ID)!;
    expect(row['name']).toBe('Carmen García');
    expect(row['nickname']).toBe('Mamá');

    const back = await getContact(ID);
    expect(back?.name).toBe('Mamá');
    expect(back?.nickname).toBe('Mamá');
    expect(back?.profileName).toBe('Carmen García');
  });

  it('a legacy contact (no nickname) persists NULL and shows its stored name', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveContact, getContact } = require('../contacts') as typeof import('../contacts');

    await saveContact(makeContact());
    expect(db.rows.get(ID)?.['nickname']).toBeNull();
    const back = await getContact(ID);
    expect(back?.name).toBe('Alice');
    expect(back?.profileName).toBe('Alice');
    expect(back?.nickname).toBeNull();
  });

  it('the schema migration adds nickname to an existing contacts table', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveContact } = require('../contacts') as typeof import('../contacts');
    await saveContact(makeContact());
    const ddl = db.execAsync.mock.calls.map((c) => String(c[0]));
    expect(ddl.some((s) => /ALTER TABLE contacts ADD COLUMN nickname TEXT/.test(s))).toBe(true);
  });
});
