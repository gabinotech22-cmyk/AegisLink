/**
 * Attachments leave the disk with their row.
 *
 * Delete for me, delete for everyone, ephemeral expiry and a chat wipe used
 * to remove the row and leave `media/<id>.enc`, the DECRYPTED `dec_<id>.jpg`
 * in the cache and the local original behind. Pins: each path collects the
 * media URIs of the affected rows (main + multi-attachment) and deletes every
 * file behind them; a text-only message deletes nothing.
 */

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const mockDeleteAsync = jest.fn().mockResolvedValue(undefined);
const mockReadDir = jest.fn().mockResolvedValue(['dec_blob1.jpg', 'dec_other.jpg', 'upload_tmp_x']);

jest.mock('expo-sqlite', () => ({ openDatabaseAsync: jest.fn(), SQLiteDatabase: jest.fn() }));
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null), setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined), AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///docs/',
  cacheDirectory: 'file:///cache/',
  deleteAsync: (...a: unknown[]) => mockDeleteAsync(...a),
  readDirectoryAsync: (...a: unknown[]) => mockReadDir(...a),
  makeDirectoryAsync: jest.fn().mockResolvedValue(undefined),
  copyAsync: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../utils/secureStore', () => ({
  ss: { get: jest.fn().mockResolvedValue(mockFixedKeyB64), set: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) },
}));

import type { StoredMessage } from '../messages';

function makeMockDb() {
  const rows = new Map<string, Record<string, unknown>>();
  return {
    rows,
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('INTO messages')) {
        const cols = sql.slice(sql.indexOf('(') + 1, sql.indexOf(')')).split(',').map((c) => c.trim());
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        rows.set(String(row['id']), row);
      } else if (sql.startsWith('DELETE FROM messages WHERE chat_id')) {
        for (const [k, r] of rows) if (r['chat_id'] === params[0]) rows.delete(k);
      } else if (sql.startsWith('DELETE FROM messages WHERE expires_at')) {
        for (const [k, r] of rows) if (r['expires_at'] != null && Number(r['expires_at']) <= Number(params[0])) rows.delete(k);
      }
      return { lastInsertRowId: 1, changes: 1 };
    }),
    getAllAsync: jest.fn().mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('WHERE chat_id = ?')) return [...rows.values()].filter((r) => r['chat_id'] === params[0]);
      if (sql.includes('expires_at <= ?')) return [...rows.values()].filter((r) => r['expires_at'] != null && Number(r['expires_at']) <= Number(params[0]));
      return [];
    }),
    getFirstAsync: jest.fn().mockImplementation(async (sql: string, ...params: unknown[]) => {
      if (sql.includes('FROM messages WHERE id = ?')) return rows.get(String(params[0])) ?? null;
      return null;
    }),
    withTransactionAsync: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

const BLOB = 'blob:blob1:KEY:NONCE:tok';
function msg(id: string, extra: Partial<StoredMessage> = {}): StoredMessage {
  return { id, chatId: 'peer-a', direction: 'in', body: 'x', createdAt: 1, senderId: 'peer-a', ...extra };
}
const deletedPaths = () => mockDeleteAsync.mock.calls.map((c) => String(c[0])).sort();

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

describe('media files go with the row', () => {
  it('delete for me removes ciphertext, decrypted cache copy and a local original; text-only removes nothing', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveMessage, setMessageDeleted } = require('../messages') as typeof import('../messages');
    await saveMessage(msg('m1', { type: 'image', mediaUri: BLOB }));
    await saveMessage(msg('m2', { type: 'image', mediaUri: 'file:///docs/media/sent.jpg' }));
    await saveMessage(msg('m3'));

    await setMessageDeleted('m1');
    expect(deletedPaths()).toEqual(['file:///cache/dec_blob1.jpg', 'file:///docs/media/blob1.enc']);
    mockDeleteAsync.mockClear();
    await setMessageDeleted('m2');
    expect(deletedPaths()).toEqual(['file:///docs/media/sent.jpg']);
    mockDeleteAsync.mockClear();
    await setMessageDeleted('m3');
    expect(mockDeleteAsync).not.toHaveBeenCalled();
  });

  it('delete for everyone (receiver) removes the files of the retracted message', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveMessage, setRemoteMessageDeleted } = require('../messages') as typeof import('../messages');
    await saveMessage(msg('m1', { type: 'image', mediaUri: BLOB }));
    // getFirstAsync in the mock ignores the authorization filter; the SQL carries it.
    expect(await setRemoteMessageDeleted('m1', 'peer-a', 'peer-a')).toBe(true);
    expect(deletedPaths()).toEqual(['file:///cache/dec_blob1.jpg', 'file:///docs/media/blob1.enc']);
    const sql = String(db.getFirstAsync.mock.calls.map((c: unknown[]) => String(c[0])).find((q: string) => q.includes('FROM messages WHERE id = ?')));
    expect(sql).toMatch(/sender_id = \? AND direction = 'in'/);
  });

  it('ephemeral expiry wipes the files of every expired attachment, including multi-attachment rows', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveMessage } = require('../messages') as typeof import('../messages');
    const { deleteExpiredMessages } = require('../chatState') as typeof import('../chatState');
    await saveMessage(msg('m1', { type: 'image', mediaUri: BLOB, expiresAt: 10 }));
    await saveMessage(msg('m2', { attachments: [{ type: 'file', uri: 'blob:blob2:K:N', fileName: 'a.pdf' }], expiresAt: 10 }));
    await saveMessage(msg('m3', { type: 'image', mediaUri: 'blob:keep:K:N', expiresAt: Date.now() + 10 ** 9 }));
    await deleteExpiredMessages();
    expect(deletedPaths()).toEqual(['file:///cache/dec_blob1.jpg', 'file:///docs/media/blob1.enc', 'file:///docs/media/blob2.enc']);
    expect(db.rows.has('m3')).toBe(true);
  });

  it('wiping a chat removes its attachment files', async () => {
    const db = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(db);
    const { saveMessage } = require('../messages') as typeof import('../messages');
    const { deleteContactMessages } = require('../contacts') as typeof import('../contacts');
    await saveMessage(msg('m1', { type: 'image', mediaUri: BLOB }));
    await saveMessage(msg('m2', { chatId: 'peer-b', type: 'image', mediaUri: 'blob:other:K:N' }));
    await deleteContactMessages('peer-a');
    expect(deletedPaths()).toEqual(['file:///cache/dec_blob1.jpg', 'file:///docs/media/blob1.enc']);
    expect(db.rows.has('m2')).toBe(true);
  });
});
