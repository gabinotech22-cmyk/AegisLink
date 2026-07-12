/**
 * Delete-identity (Profile → "Delete identity", useIdentity.reset()) must NOT
 * leave the app-lock PIN or the coercion (duress) PIN behind.
 *
 * Reported bug: after deleting the identity from Profile, `aegis.pin.hash`,
 * `aegis.panic.v1` (the coercion PIN) and the decoy config survived in
 * SecureStore — so a freshly created identity inherited the old lock PIN, and
 * the old coercion PIN still armed the decoy. reset() cleared the identity/DB
 * key material but never touched the lock/duress secrets.
 *
 * These tests lock in that reset() now routes through the shared
 * purgeLockAndDuressSecrets() (the same purge panic-wipe uses), and that the
 * purge itself covers the complete lock/duress/PIN key set + the in-memory
 * preferences reset (so appLockEnabled can't strand a PIN-less identity in a
 * permanent lock).
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

// db/local is the barrel that re-exports purgeLockAndDuressSecrets from db/core.
// Mock it so we can assert reset() invokes the purge without dragging in SQLite.
const mockPurge = jest.fn().mockResolvedValue(undefined);
const mockDeleteIdentitySlot = jest.fn().mockResolvedValue(undefined);
jest.mock('../../db/local', () => ({
  loadIdentity: jest.fn().mockResolvedValue(null),
  saveIdentity: jest.fn().mockResolvedValue(undefined),
  deleteIdentitySlot: mockDeleteIdentitySlot,
  purgeLockAndDuressSecrets: mockPurge,
  setActiveDbSlot: jest.fn(),
  resetDbConnection: jest.fn(),
}));

jest.mock('../../crypto/media', () => ({
  purgeCachedDecryptedMedia: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../crypto/ensureRegistered', () => ({
  ensureRegistered: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));

describe('useIdentity.reset() — wipes lock + coercion PINs (delete-identity regression)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('routes through purgeLockAndDuressSecrets so the lock/coercion PIN never survives', async () => {
    const { useIdentity } = require('../identity') as typeof import('../identity');
    await useIdentity.getState().reset();
    expect(mockPurge).toHaveBeenCalledTimes(1);
  });

  it('purges the identity slot before clearing the lock secrets', async () => {
    const { useIdentity } = require('../identity') as typeof import('../identity');
    await useIdentity.getState().reset();
    // Both the per-slot key material and the global lock/duress secrets go.
    expect(mockDeleteIdentitySlot).toHaveBeenCalled();
    expect(mockPurge).toHaveBeenCalled();
  });
});

describe('purgeLockAndDuressSecrets — complete lock/duress/PIN key set', () => {
  const mockPrefsReset = jest.fn().mockResolvedValue(undefined);

  function loadRealPurge() {
    jest.resetModules();
    jest.doMock('expo-secure-store', () => ({
      getItemAsync: jest.fn().mockResolvedValue(null),
      setItemAsync: jest.fn().mockResolvedValue(undefined),
      deleteItemAsync: jest.fn().mockResolvedValue(undefined),
      AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
    }));
    jest.doMock('../../utils/secureStore', () => ({
      ss: { get: jest.fn().mockResolvedValue(null), set: jest.fn(), delete: jest.fn() },
    }));
    jest.doMock('../../store/preferences', () => ({
      usePreferences: { getState: () => ({ reset: mockPrefsReset }) },
    }));
    // The real helper lives in db/core; unmock the barrel path for this block.
    const SecureStore = require('expo-secure-store') as { deleteItemAsync: jest.Mock };
    const { purgeLockAndDuressSecrets } = require('../../db/core') as typeof import('../../db/core');
    return { purgeLockAndDuressSecrets, SecureStore };
  }

  it('deletes every lock/coercion/PIN key and resets in-memory preferences', async () => {
    const { purgeLockAndDuressSecrets, SecureStore } = loadRealPurge();
    await purgeLockAndDuressSecrets();
    const deleted = SecureStore.deleteItemAsync.mock.calls.map((c: string[]) => c[0]);
    // Coercion (duress) PIN + decoy config.
    expect(deleted).toContain('aegis.panic.v1');
    expect(deleted).toContain('aegis.duress.decoy.v1');
    // App-lock PIN material — including aegis.pin.len.v1, which the pre-fix
    // wipe left behind.
    expect(deleted).toContain('aegis.pin.hash');
    expect(deleted).toContain('aegis.pin.salt.v2');
    expect(deleted).toContain('aegis.pin.len.v1');
    // Lock attempt counter + legacy keys.
    expect(deleted).toContain('aegis.lock.attempts.v1');
    expect(deleted).toContain('aegis.pin.v1');
    expect(deleted).toContain('aegis.lockSettings');
    // Preference blobs + in-memory reset (avoids the permanent-lockout trap).
    expect(deleted).toContain('aegis.preferences.v1');
    expect(mockPrefsReset).toHaveBeenCalled();
  });
});
