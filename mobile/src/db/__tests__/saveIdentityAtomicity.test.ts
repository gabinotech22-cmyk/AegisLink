/**
 * saveIdentity — write-order regression (real production incident, see
 * crypto/__tests__/identityFromStored.corruption.test.ts for the full story).
 *
 * saveIdentity() used to write SecureStore (private keys) BEFORE SQLite (the
 * public identity row). A SQLite failure after a successful SecureStore
 * write left the two stores permanently out of sync: SecureStore held a new
 * keypair nobody registered, SQLite kept the old, still-relay-registered
 * one. Real iPhones hit this via a schema-init crash mid identity-generation
 * retry and ended up permanently unable to sign anything the relay would
 * accept (403 invalid_signature on every prekey upload).
 *
 * Fix: SQLite is written FIRST. If it throws, SecureStore must never be
 * touched — so a failure leaves whatever identity already existed (if any)
 * completely untouched in both stores, and the caller can safely retry.
 */
jest.mock('expo-sqlite', () => ({
  openDatabaseAsync: jest.fn(),
  SQLiteDatabase: jest.fn(),
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
}));

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///test/',
  deleteAsync: jest.fn().mockResolvedValue(undefined),
  getInfoAsync: jest.fn().mockResolvedValue({ exists: false }),
  moveAsync: jest.fn().mockResolvedValue(undefined),
}));

const mockFixedKeyB64 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(mockFixedKeyB64),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

function makeMockDb(runAsyncMock: jest.Mock) {
  return {
    execAsync: jest.fn().mockResolvedValue(undefined),
    runAsync: runAsyncMock,
    getAllAsync: jest.fn().mockResolvedValue([]),
    getFirstAsync: jest.fn().mockResolvedValue(null),
    withTransactionAsync: jest.fn().mockImplementation((fn: () => Promise<void>) => fn()),
    closeAsync: jest.fn().mockResolvedValue(undefined),
  };
}

describe('saveIdentity — SQLite-then-SecureStore write order', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('never touches SecureStore when the SQLite identity INSERT fails', async () => {
    const runAsync = jest.fn().mockRejectedValue(new Error('no such column: whatever'));
    const sqlite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
    sqlite.openDatabaseAsync.mockResolvedValue(makeMockDb(runAsync));

    const SecureStore = require('expo-secure-store') as { setItemAsync: jest.Mock };
    const { saveIdentity } = require('../core') as typeof import('../core');

    await expect(
      saveIdentity({
        aegisId: 'AEGIS-TEST',
        publicKeyB64: 'pub-b64',
        secretKeyB64: 'secret-b64',
        signingPublicKeyB64: 'sign-pub-b64',
        signingSecretKeyB64: 'sign-secret-b64',
        createdAt: Date.now(),
      }),
    ).rejects.toThrow('no such column');

    // The whole point of the fix: a SQLite failure must leave SecureStore
    // completely untouched, so no half-written/mismatched keypair can exist.
    expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  });

  it('persists SecureStore keys only after the SQLite row is written successfully', async () => {
    const runAsync = jest.fn().mockResolvedValue({ lastInsertRowId: 1, changes: 1 });
    const sqlite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
    sqlite.openDatabaseAsync.mockResolvedValue(makeMockDb(runAsync));

    const SecureStore = require('expo-secure-store') as { setItemAsync: jest.Mock };
    const { saveIdentity } = require('../core') as typeof import('../core');

    await saveIdentity({
      aegisId: 'AEGIS-TEST',
      publicKeyB64: 'pub-b64',
      secretKeyB64: 'secret-b64',
      signingPublicKeyB64: 'sign-pub-b64',
      signingSecretKeyB64: 'sign-secret-b64',
      createdAt: Date.now(),
    });

    expect(runAsync).toHaveBeenCalled();
    expect(SecureStore.setItemAsync).toHaveBeenCalled();
  });
});
