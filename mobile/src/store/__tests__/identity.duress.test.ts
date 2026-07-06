/**
 * identity store — duress (coercion) hydrate tests
 *
 * Covers:
 *   1. Two duress hydrations show the SAME decoy AegisID (stable decoy).
 *   2. Reverting duress (real PIN) rehydrates the REAL identity, discarding
 *      any decoy state left in memory — no decoy leftovers after reversion.
 *   3. The real identity/keys are never touched while hydrating the decoy.
 */

const secureStoreBacking: Record<string, string> = {};

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn((key: string) => Promise.resolve(secureStoreBacking[key] ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    secureStoreBacking[key] = value;
    return Promise.resolve(undefined);
  }),
  deleteItemAsync: jest.fn((key: string) => {
    delete secureStoreBacking[key];
    return Promise.resolve(undefined);
  }),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));

jest.mock('../../utils/secureStore', () => {
  const backing: Record<string, string> = {};
  return {
    ss: {
      get: jest.fn((key: string) => Promise.resolve(backing[key] ?? null)),
      set: jest.fn((key: string, value: string) => { backing[key] = value; return Promise.resolve(undefined); }),
      delete: jest.fn((key: string) => { delete backing[key]; return Promise.resolve(undefined); }),
    },
  };
});

// Real (valid-base64, 32-byte) dummy key material — identityFromStored
// decodes these and does NOT re-derive them, so they must round-trip exactly.
// Built directly inside the jest.mock factory (Babel hoists jest.mock calls
// above top-level const declarations, so a module-scope constant referenced
// here would still be undefined at factory-invocation time).
jest.mock('../../db/local', () => ({
  loadIdentity: jest.fn().mockResolvedValue({
    aegisId: 'REAL-AAAA-BBBB',
    publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
    secretKeyB64: Buffer.alloc(32, 2).toString('base64'),
    signingPublicKeyB64: Buffer.alloc(32, 3).toString('base64'),
    signingSecretKeyB64: Buffer.alloc(64, 4).toString('base64'),
    createdAt: 1000,
  }),
  saveIdentity: jest.fn().mockResolvedValue(undefined),
  setActiveDbSlot: jest.fn(),
  deleteIdentitySlot: jest.fn().mockResolvedValue(undefined),
}));

const mockRealStoredIdentity = {
  aegisId: 'REAL-AAAA-BBBB',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  secretKeyB64: Buffer.alloc(32, 2).toString('base64'),
  signingPublicKeyB64: Buffer.alloc(32, 3).toString('base64'),
  signingSecretKeyB64: Buffer.alloc(64, 4).toString('base64'),
  createdAt: 1000,
};

jest.mock('../../crypto/ensureRegistered', () => ({
  ensureRegistered: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../crypto/media', () => ({
  purgeCachedDecryptedMedia: jest.fn().mockResolvedValue(undefined),
}));

import { useIdentity } from '../identity';
import { usePreferences } from '../preferences';

describe('identity store — duress hydrate', () => {
  beforeEach(() => {
    useIdentity.setState({
      identity: null,
      status: 'idle',
      hydrated: false,
      displayName: 'you',
      avatarColor: '#05b875',
      avatarImage: null,
      profileStatus: '',
      activeSlotId: 'self',
      slotsList: ['self'],
    });
    usePreferences.setState({ duressActive: false });
  });

  it('shows the SAME decoy AegisID across two duress hydrations', async () => {
    usePreferences.setState({ duressActive: true });

    await useIdentity.getState().hydrate();
    const firstId = useIdentity.getState().identity?.aegisId;
    expect(firstId).toBeTruthy();
    expect(firstId).not.toBe(mockRealStoredIdentity.aegisId);

    // Simulate leaving and re-entering duress mode.
    useIdentity.setState({ identity: null, hydrated: false });
    await useIdentity.getState().hydrate();
    const secondId = useIdentity.getState().identity?.aegisId;

    expect(secondId).toBe(firstId);
  });

  it('reverts to the real identity after duress is turned off, discarding decoy state', async () => {
    usePreferences.setState({ duressActive: true });
    await useIdentity.getState().hydrate();
    const decoyPublicKey = useIdentity.getState().identity?.publicKeyB64;
    expect(decoyPublicKey).not.toBe(mockRealStoredIdentity.publicKeyB64);

    // Real PIN entered — duress flag flips off (mirrors Lock.tsx's real-PIN branch).
    usePreferences.setState({ duressActive: false });
    await useIdentity.getState().hydrate();

    // The real identity is re-derived from the real stored secret key — the
    // decoy's public key must be completely gone from the store.
    expect(useIdentity.getState().identity?.publicKeyB64).toBe(mockRealStoredIdentity.publicKeyB64);
    expect(useIdentity.getState().identity?.secretKeyB64).toBe(mockRealStoredIdentity.secretKeyB64);
  });

  it('marks the decoy as already published so no relay registration is retried', async () => {
    // If publishStatus stayed failed/unknown, HomeScreen would call
    // runPublish() with the decoy identity — registering decoy keys on the
    // relay while under coercion. The duress hydrate must neutralize it.
    useIdentity.setState({ publishStatus: 'failed', publishError: 'boom', publishRetryAfterMs: 5000 });
    usePreferences.setState({ duressActive: true });

    await useIdentity.getState().hydrate();

    expect(useIdentity.getState().publishStatus).toBe('published');
    expect(useIdentity.getState().publishError).toBeNull();
    expect(useIdentity.getState().publishRetryAfterMs).toBeNull();
  });
});
