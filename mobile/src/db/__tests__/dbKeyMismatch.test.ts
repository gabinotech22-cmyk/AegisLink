/**
 * Lost SQLCipher key — the app must fail CLEARLY, never spin, never fall back.
 *
 * Scenario (seen on emulator A during the F7 test, 2026-09-19): the DB file is
 * SQLCipher data but the key in SecureStore is not the one that encrypted it
 * (keystore reset / restore from a system backup / interrupted install). The
 * old flow mistook the file for a legacy plaintext DB and tried to
 * `sqlcipher_export` it, then surfaced an opaque error while the UI stayed on
 * "Initializing secure storage…" for good.
 *
 * Now:
 *   - a file whose header is NOT the SQLite plaintext magic is never exported;
 *     the open fails with DbKeyMismatchError and getDbFatalError() exposes it;
 *   - a plaintext header still takes the migration path (unchanged);
 *   - "file is not a database" after `PRAGMA key` is classified the same way;
 *   - restartDb() clears the fatal state so a fresh file can be opened after
 *     the reset the recovery screen performs.
 *
 * Same harness as sqlcipher.test.ts, plus a readAsStringAsync mock for the header.
 */

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const PLAINTEXT_MAGIC_B64 = 'U1FMaXRlIGZvcm1hdCAzAA==';

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

const mockGetInfoAsync = jest.fn();
const mockMoveAsync = jest.fn().mockResolvedValue(undefined);
const mockReadAsStringAsync = jest.fn();
jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///test/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: (...a: unknown[]) => mockGetInfoAsync(...a),
  moveAsync: (...a: unknown[]) => mockMoveAsync(...a),
  readAsStringAsync: (...a: unknown[]) => mockReadAsStringAsync(...a),
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

const CONTACT = { aegisId: 'KEY-1', publicKeyB64: 'pk', name: 'K', verified: false, addedAt: 1 };

beforeEach(() => {
  jest.resetModules();
  jest.clearAllMocks();
  const { ss } = require('../../utils/secureStore') as { ss: { get: jest.Mock } };
  ss.get.mockResolvedValue(mockFixedKeyB64);
  mockMoveAsync.mockResolvedValue(undefined);
  mockGetInfoAsync.mockResolvedValue({ exists: true, size: 8192 }); // a file is there
});

function requireLocal() {
  return require('../local') as typeof import('../local');
}

describe('encrypted file under a key we no longer hold', () => {
  it('fails with DbKeyMismatchError, never runs sqlcipher_export, and exposes the fatal state', async () => {
    mockReadAsStringAsync.mockResolvedValue('AAAAAAAAAAAAAAAAAAAAAA=='); // not the magic → encrypted
    const probeDb = makeMockDb();
    probeDb.getFirstAsync.mockRejectedValue(new Error('file is not a database'));
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(probeDb);

    const { saveContact, getDbFatalError, DbKeyMismatchError } = requireLocal();

    await expect(saveContact(CONTACT)).rejects.toBeInstanceOf(DbKeyMismatchError);
    // Header read once, at offset 0, 16 bytes, base64.
    expect(mockReadAsStringAsync).toHaveBeenCalledWith(
      'file:///test/SQLite/aegislink.db',
      expect.objectContaining({ encoding: 'base64', position: 0, length: 16 }),
    );
    // No export, no swap: an encrypted file is never treated as plaintext.
    const exported = (probeDb.execAsync.mock.calls as string[][]).some(([s]) => s.includes('sqlcipher_export'));
    expect(exported).toBe(false);
    expect(mockMoveAsync).not.toHaveBeenCalled();
    // Fatal and sticky for this process.
    expect(getDbFatalError()).toBeInstanceOf(DbKeyMismatchError);
    await expect(saveContact(CONTACT)).rejects.toBeInstanceOf(DbKeyMismatchError);
  });

  it('a plaintext header still migrates (legacy path unchanged)', async () => {
    mockReadAsStringAsync.mockResolvedValue(PLAINTEXT_MAGIC_B64);
    const probeDb = makeMockDb();
    probeDb.getFirstAsync.mockRejectedValue(new Error('file is not a database'));
    const plainDb = makeMockDb();
    const mainDb = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock)
      .mockResolvedValueOnce(probeDb)
      .mockResolvedValueOnce(plainDb)
      .mockResolvedValueOnce(mainDb);

    const { saveContact, getDbFatalError } = requireLocal();
    await saveContact(CONTACT);

    const exported = (plainDb.execAsync.mock.calls as string[][]).some(([s]) => s.includes('sqlcipher_export'));
    expect(exported).toBe(true);
    expect(mockMoveAsync).toHaveBeenCalledTimes(1);
    expect(getDbFatalError()).toBeNull();
  });

  it('"file is not a database" right after PRAGMA key is a key mismatch too', async () => {
    mockGetInfoAsync.mockResolvedValue({ exists: false }); // no migration probe
    const mainDb = makeMockDb();
    mainDb.execAsync.mockImplementation(async (sql: string) => {
      if (sql.startsWith('PRAGMA key')) return undefined;
      throw new Error('Error code 26: file is not a database (SQLITE_NOTADB)');
    });
    (require('expo-sqlite').openDatabaseAsync as jest.Mock).mockResolvedValue(mainDb);

    const { saveContact, getDbFatalError, DbKeyMismatchError } = requireLocal();
    await expect(saveContact(CONTACT)).rejects.toBeInstanceOf(DbKeyMismatchError);
    expect(getDbFatalError()).toBeInstanceOf(DbKeyMismatchError);
    expect(mainDb.closeAsync).toHaveBeenCalled();
  });

  it('restartDb() forgets the fatal state and a fresh file opens', async () => {
    mockReadAsStringAsync.mockResolvedValue('AAAAAAAAAAAAAAAAAAAAAA==');
    const probeDb = makeMockDb();
    probeDb.getFirstAsync.mockRejectedValue(new Error('file is not a database'));
    const freshDb = makeMockDb();
    (require('expo-sqlite').openDatabaseAsync as jest.Mock)
      .mockResolvedValueOnce(probeDb)
      .mockResolvedValue(freshDb);

    const local = requireLocal();
    await expect(local.saveContact(CONTACT)).rejects.toBeInstanceOf(local.DbKeyMismatchError);

    // The recovery screen deleted the file; now there is nothing to migrate.
    mockGetInfoAsync.mockResolvedValue({ exists: false });
    local.restartDb();
    await local.dbReadyPromise;
    expect(local.getDbFatalError()).toBeNull();
    await expect(local.saveContact(CONTACT)).resolves.toBeUndefined();
  });
});
