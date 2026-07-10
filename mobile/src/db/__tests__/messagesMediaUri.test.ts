/**
 * db/messages — regression test for iOS audit finding #6: media_uri must be
 * persisted as a container-independent relative pointer, never an absolute
 * file:// URI. blob:/http(s):// pointers pass through unchanged.
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
  documentDirectory: 'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/',
  cacheDirectory: 'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Library/Caches/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(mockFixedKeyB64),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

function makeMockDb() {
  const rows: Record<string, unknown>[] = [];
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: jest.fn().mockImplementation((sql: string, ...args: unknown[]) => {
      if (typeof sql === 'string' && sql.includes('INSERT OR REPLACE INTO messages')) {
        const [id, chat_id, direction, body, created_at, type, media_uri] = args;
        rows.push({ id, chat_id, direction, body, created_at, type, media_uri });
      }
      return Promise.resolve({ lastInsertRowId: 1, changes: 1 });
    }),
    getAllAsync: jest.fn().mockImplementation(() => Promise.resolve(rows)),
    getFirstAsync: jest.fn().mockImplementation(() => Promise.resolve(rows[0] ?? null)),
    withTransactionAsync: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
    __rows: rows,
  };
}

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
});

function requireLocal() {
  return require('../local') as typeof import('../local');
}

describe('db/messages media_uri container-independent persistence', () => {
  it('persists a local staged file as a relative pointer, not the absolute URI', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { saveMessage } = requireLocal();
    const absoluteMedia =
      'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/scheduledposts/post_1.jpg';

    await saveMessage({
      id: 'm1',
      chatId: 'chat1',
      direction: 'out',
      body: 'hi',
      createdAt: 1,
      type: 'image',
      mediaUri: absoluteMedia,
    });

    const stored = mockDb.__rows[0].media_uri as string;
    // At-rest encrypted (encv1: prefix) — decrypt to inspect the plaintext pointer.
    const { decryptBody } = requireLocal();
    const decrypted = await decryptBody(stored);
    expect(decrypted).toBe('doc:scheduledposts/post_1.jpg');
  });

  it('resolves the stored relative pointer back to an absolute URI on read', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { saveMessage, getMessage } = requireLocal();
    const absoluteMedia =
      'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/scheduledposts/post_2.jpg';

    await saveMessage({
      id: 'm2',
      chatId: 'chat1',
      direction: 'out',
      body: 'hi',
      createdAt: 2,
      type: 'image',
      mediaUri: absoluteMedia,
    });

    const msg = await getMessage('m2');
    expect(msg?.mediaUri).toBe(absoluteMedia);
  });

  it('leaves a remote blob pointer unchanged (passthrough, no local file semantics)', async () => {
    const mockDb = makeMockDb();
    const openMock = require('expo-sqlite').openDatabaseAsync as jest.Mock;
    openMock.mockResolvedValue(mockDb);

    const { saveMessage, getMessage } = requireLocal();
    const blobUri = 'blob:abc123:key456:nonce789';

    await saveMessage({
      id: 'm3',
      chatId: 'chat1',
      direction: 'in',
      body: '[image:blob:abc123:key456:nonce789]',
      createdAt: 3,
      type: 'image',
      mediaUri: blobUri,
    });

    const msg = await getMessage('m3');
    expect(msg?.mediaUri).toBe(blobUri);
  });
});
