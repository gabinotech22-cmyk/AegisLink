/**
 * searchMessages — the body column is encrypted at rest, so search decrypts
 * and matches in memory. Pins: the SQL excludes deleted / expired / non-text
 * rows and reads newest first with a scan cap; the match is case-insensitive
 * on the DECRYPTED body; wire-tag bodies (attachment references that carry the
 * blob key, polls, call markers) are never matched nor returned; results stop
 * at the limit. Mocked expo-sqlite: INSERTs are captured so the very bytes
 * saveMessage wrote are what search reads back.
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

import type { StoredMessage } from '../messages';

function makeMockDb() {
  const rows: Record<string, unknown>[] = [];
  const getAllAsync = jest.fn().mockImplementation(async (sql: string) => {
    if (!sql.includes('FROM messages')) return [];
    // Newest first, like the ORDER BY the SQL asks for.
    return [...rows].sort((a, b) => Number(b['created_at']) - Number(a['created_at']));
  });
  return {
    rows,
    getAllAsync,
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('INTO messages')) {
        const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        rows.push(row);
      }
      return { lastInsertRowId: 1, changes: 1 };
    }),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    withTransactionAsync: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

function msg(id: string, body: string, createdAt: number, extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id, chatId: 'peer-a', direction: 'in', body, createdAt, ...extra };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

describe('searchMessages', () => {
  it('matches the decrypted body case-insensitively, newest first, and skips wire-tag bodies', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveMessage, searchMessages } = require('../messages') as typeof import('../messages');

    await saveMessage(msg('m1', 'Nos vemos en la Plaza', 1000));
    await saveMessage(msg('m2', 'plaza mayor a las 5', 2000));
    await saveMessage(msg('m3', 'otra cosa', 3000));
    await saveMessage(msg('m4', '[image:blob:id:PLAZAKEY:nonce:token]', 4000));
    await saveMessage(msg('m5', '[poll:{"q":"plaza?"}]', 5000));
    await saveMessage(msg('m6', '[file:plaza-plano.pdf:blob:id:KEY:nonce:token]', 6000));

    // The stored column is not the plaintext.
    expect(db.rows.every((r) => !String(r['body']).toLowerCase().includes('plaza'))).toBe(true);

    const hits = await searchMessages('PLAZA');
    // A file matches by its name only (m6); wire tags never match (m4, m5).
    expect(hits.map((h) => h.id)).toEqual(['m6', 'm2', 'm1']);
    expect(hits.every((h) => !h.body.includes('PLAZAKEY'))).toBe(true);
  });

  it('excludes deleted / expired / non-text rows in SQL, reads newest first with a scan cap', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { searchMessages } = require('../messages') as typeof import('../messages');

    await searchMessages('x', { now: 123, scan: 42 });
    const call = db.getAllAsync.mock.calls.find((c: unknown[]) => String(c[0]).includes('FROM messages'))!;
    const sql = String(call[0]);
    expect(sql).toMatch(/deleted = 0/);
    expect(sql).toMatch(/expires_at IS NULL OR expires_at > \?/);
    expect(sql).toMatch(/type IS NULL OR type NOT IN \('image', 'video', 'audio', 'view_once'\)/);
    expect(sql).toMatch(/ORDER BY created_at DESC LIMIT \?/);
    expect(call.slice(1)).toEqual([123, 42]);
  });

  it('returns nothing for a blank query without touching the DB, and stops at the limit', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveMessage, searchMessages } = require('../messages') as typeof import('../messages');
    expect(await searchMessages('   ')).toEqual([]);
    expect(db.getAllAsync).not.toHaveBeenCalled();

    for (let i = 0; i < 5; i++) await saveMessage(msg(`m${i}`, `hola ${i}`, i));
    expect((await searchMessages('hola', { limit: 2 })).map((h) => h.id)).toEqual(['m4', 'm3']);
  });
});
