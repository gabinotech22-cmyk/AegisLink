/**
 * contacts.relay_onion — federation F1 (docs/FEDERATION-DESIGN.md D2).
 *
 * A contact's relay must survive the DB round-trip, an existing DB must gain
 * the column via the ADD COLUMN migration, and a contact on the official relay
 * must persist NULL (so nothing changes for today's users). Mocked expo-sqlite,
 * same harness as saveGroup.test.ts.
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

import type { StoredContact } from '../contacts';

const ONION = 'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd.onion';

function makeMockDb() {
  const rows = new Map<string, Record<string, unknown>>();
  const execAsync = jest.fn().mockResolvedValue(undefined);
  return {
    rows,
    execAsync,
    runAsync: jest.fn().mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('INTO contacts')) {
        // Column list order in the INSERT is what the row mapping relies on;
        // capture by position so a reordered column would fail the test.
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

function makeContact(overrides: Partial<StoredContact> = {}): StoredContact {
  return {
    aegisId: 'ABC-DEFG-HJKM',
    publicKeyB64: 'A'.repeat(43) + '=',
    name: 'Alice',
    verified: true,
    addedAt: 1_700_000_000_000,
    ...overrides,
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

describe('contacts.relay_onion (federation F1)', () => {
  it('persists and reads back a custom relay', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveContact, getContact } = require('../contacts') as typeof import('../contacts');

    await saveContact(makeContact({ relayOnion: ONION }));
    const back = await getContact('ABC-DEFG-HJKM');
    expect(back?.relayOnion).toBe(ONION);
    expect(db.rows.get('ABC-DEFG-HJKM')?.['relay_onion']).toBe(ONION);
  });

  it('a contact on the official relay persists NULL and reads back null', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveContact, getContact } = require('../contacts') as typeof import('../contacts');

    await saveContact(makeContact());
    expect(db.rows.get('ABC-DEFG-HJKM')?.['relay_onion']).toBeNull();
    expect((await getContact('ABC-DEFG-HJKM'))?.relayOnion).toBeNull();
  });

  it('the schema migration adds relay_onion to an existing contacts table', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveContact } = require('../contacts') as typeof import('../contacts');
    await saveContact(makeContact());

    const ddl = db.execAsync.mock.calls.map((c) => String(c[0]));
    expect(ddl.some((s) => /ALTER TABLE contacts ADD COLUMN relay_onion TEXT/.test(s))).toBe(true);
    // And the fresh-install DDL declares it too, so both paths agree.
    expect(ddl.some((s) => /CREATE TABLE IF NOT EXISTS contacts[\s\S]*relay_onion\s+TEXT/.test(s))).toBe(true);
  });
});
