/**
 * Ola 10 — SQLCipher at-rest encryption (mobile control-flow tests).
 *
 * expo-sqlite's real SQLCipher only runs in a native build, so these unit tests
 * verify the OPEN/MIGRATE control flow against a mocked expo-sqlite:
 *   - the SQLCipher `PRAGMA key` is applied as the first statement on every handle;
 *   - a pre-existing PLAINTEXT file is re-encrypted via sqlcipher_export + swap;
 *   - an already-encrypted file is left untouched (idempotent).
 *
 * openAndInit is internal; we drive it through saveContact (db() → openAndInit).
 */

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 zero bytes → 64 hex zeros

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

// FileSystem fully featured here (getInfoAsync + moveAsync present) so migration
// can run — unlike openAndInit.test.ts which deliberately omits them.
const mockGetInfoAsync = jest.fn();
const mockMoveAsync = jest.fn().mockResolvedValue(undefined);
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///test/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: (...a: unknown[]) => mockGetInfoAsync(...a),
  moveAsync: (...a: unknown[]) => mockMoveAsync(...a),
}));

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(mockFixedKeyB64),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

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

const SAMPLE_CONTACT = {
  aegisId: 'SQLC-1',
  publicKeyB64: 'pk',
  name: 'Cipher',
  verified: false,
  addedAt: 1_000_000,
};

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
  mockMoveAsync.mockResolvedValue(undefined);
  // Default: no pre-existing file → no migration.
  mockGetInfoAsync.mockResolvedValue({ exists: false });
});

function requireLocal() {
  return require('../local') as typeof import('../local');
}

describe('SQLCipher key application', () => {
  it('applies PRAGMA key as the FIRST statement on the handle', async () => {
    const mockDb = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

    const { saveContact } = requireLocal();
    await saveContact(SAMPLE_CONTACT);

    const firstExec = (mockDb.execAsync.mock.calls[0] as string[])[0];
    expect(firstExec).toBe(`PRAGMA key = "x'${'0'.repeat(64)}'"`);
  });

  it('does not migrate when the DB file does not exist (fresh install)', async () => {
    const mockDb = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(mockDb);

    const { saveContact } = requireLocal();
    await saveContact(SAMPLE_CONTACT);

    expect(mockMoveAsync).not.toHaveBeenCalled();
  });
});

describe('plaintext → SQLCipher migration', () => {
  it('re-encrypts a legacy plaintext DB (probe fails → sqlcipher_export + swap)', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 8192 });

    const probeDb = makeMockDb();
    probeDb.getFirstAsync.mockRejectedValue(new Error('file is not a database')); // plaintext
    const plainDb = makeMockDb();
    const mainDb = makeMockDb();

    (require('expo-sqlite').openDatabaseAsync as jest.Mock)
      .mockResolvedValueOnce(probeDb)  // migration probe
      .mockResolvedValueOnce(plainDb)  // plaintext source for export
      .mockResolvedValueOnce(mainDb);  // final encrypted handle

    const { saveContact } = requireLocal();
    await saveContact(SAMPLE_CONTACT);

    // The export ran on the plaintext handle…
    const exportCall = (plainDb.execAsync.mock.calls as string[][]).find(([s]) =>
      s.includes("sqlcipher_export('encrypted')"),
    );
    expect(exportCall).toBeDefined();
    expect(exportCall![0]).toContain('ATTACH DATABASE');
    // …and the encrypted copy replaced the plaintext file.
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
  });

  it('leaves an already-encrypted DB untouched (probe succeeds → no swap)', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: true, size: 8192 });

    const probeDb = makeMockDb();
    probeDb.getFirstAsync.mockResolvedValue({ 'count(*)': 3 }); // readable with key → encrypted
    const mainDb = makeMockDb();

    (require('expo-sqlite').openDatabaseAsync as jest.Mock)
      .mockResolvedValueOnce(probeDb)
      .mockResolvedValueOnce(mainDb);

    const { saveContact } = requireLocal();
    await saveContact(SAMPLE_CONTACT);

    expect(mockMoveAsync).not.toHaveBeenCalled();
  });
});
