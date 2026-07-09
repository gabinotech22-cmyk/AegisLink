/**
 * saveIdentity — Keychain accessibility hardening regression test.
 *
 * iOS audit finding #1 (branch fix/ios-audit-batch): saveIdentity() persisted
 * the user's private identity keys (X25519 secretKey + Ed25519
 * signingSecretKey) with `keychainAccessible: AFTER_FIRST_UNLOCK` — WITHOUT
 * the `_THIS_DEVICE_ONLY` suffix. On iOS, a Keychain item without that suffix
 * is eligible for inclusion in an encrypted iCloud/iTunes device backup and
 * gets RESTORED onto a *different* physical device when that backup is
 * restored — leaking the private identity off-device (violates "keys never
 * leave the device", project golden rule #1). This locks in that both
 * secret-key writes use AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, matching the
 * shared `ss` wrapper (utils/secureStore.ts) used everywhere else.
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

describe('saveIdentity — Keychain accessibility (iOS off-device backup leak regression)', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  it('persists both secret keys with AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY, never the plain (backup-eligible) AFTER_FIRST_UNLOCK', async () => {
    const sqlite = require('expo-sqlite') as { openDatabaseAsync: jest.Mock };
    sqlite.openDatabaseAsync.mockResolvedValue(makeMockDb());

    const SecureStore = require('expo-secure-store') as {
      setItemAsync: jest.Mock;
      AFTER_FIRST_UNLOCK: string;
      AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: string;
    };

    const { saveIdentity, getSecretKeySlot, getSignSecretKeySlot } =
      require('../core') as typeof import('../core');

    await saveIdentity({
      aegisId: 'AEGIS-TEST',
      publicKeyB64: 'pub-b64',
      secretKeyB64: 'secret-b64',
      signingPublicKeyB64: 'sign-pub-b64',
      signingSecretKeyB64: 'sign-secret-b64',
      createdAt: Date.now(),
    });

    const secretCall = SecureStore.setItemAsync.mock.calls.find(
      (c: unknown[]) => c[0] === getSecretKeySlot(),
    );
    const signCall = SecureStore.setItemAsync.mock.calls.find(
      (c: unknown[]) => c[0] === getSignSecretKeySlot(),
    );
    expect(secretCall).toBeDefined();
    expect(signCall).toBeDefined();

    const expectedOpts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
    expect((secretCall as unknown[])[2]).toEqual(expectedOpts);
    expect((signCall as unknown[])[2]).toEqual(expectedOpts);

    // Explicitly guard against regressing to the weaker, backup-eligible class.
    const weakOpts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };
    expect((secretCall as unknown[])[2]).not.toEqual(weakOpts);
    expect((signCall as unknown[])[2]).not.toEqual(weakOpts);
  });
});
