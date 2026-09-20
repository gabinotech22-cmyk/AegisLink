/**
 * findOrphanedPendingMessages — the query behind the once-per-launch sweep that
 * turns "sending forever" into "failed, tap to retry".
 *
 * An outgoing row is an orphan when it is still `pending`, older than the
 * grace window, and NO outbox job points at it — neither as a 1:1 `msg_id` nor
 * as a group `bubble_id`. Builds up to 1.0.6 produced one for every photo,
 * video and voice note (the bubble id never matched the wire id).
 *
 * Same harness as outbox.db.test.ts: real db/messages against the expo-sqlite
 * mock, module reset per test.
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

function makeMockDb(getAllAsyncMock: jest.Mock) {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 }),
    getAllAsync: getAllAsyncMock,
    getFirstAsync: jest.fn().mockResolvedValue({ user_version: 5 }),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

describe('findOrphanedPendingMessages', () => {
  it('selects pending outgoing rows older than the cutoff that no outbox job references', async () => {
    const getAll = jest.fn().mockResolvedValue([
      { id: 'm-photo', chat_id: 'peer-a' },
      { id: 'm-voice', chat_id: 'grp-1' },
    ]);
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(makeMockDb(getAll));
    const { findOrphanedPendingMessages } = require('../messages') as typeof import('../messages');

    const rows = await findOrphanedPendingMessages(1_000_000);

    expect(rows).toEqual([
      { id: 'm-photo', chatId: 'peer-a' },
      { id: 'm-voice', chatId: 'grp-1' },
    ]);
    const call = getAll.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).includes('FROM messages'),
    );
    expect(call).toBeDefined();
    const sql = (call as unknown[])[0] as string;
    // The three guards that make a row an orphan, and the age cutoff as the
    // only bound parameter.
    expect(sql).toMatch(/direction = 'out'/);
    expect(sql).toMatch(/delivery_status = 'pending'/);
    expect(sql).toMatch(/created_at < \?/);
    expect(sql).toMatch(/id NOT IN \(SELECT msg_id FROM outbox\)/);
    expect(sql).toMatch(/id NOT IN \(SELECT bubble_id FROM outbox WHERE bubble_id IS NOT NULL\)/);
    expect((call as unknown[])[1]).toBe(1_000_000);
  });

  it('returns an empty list when nothing is orphaned', async () => {
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(makeMockDb(jest.fn().mockResolvedValue([])));
    const { findOrphanedPendingMessages } = require('../messages') as typeof import('../messages');
    expect(await findOrphanedPendingMessages(Date.now())).toEqual([]);
  });
});
