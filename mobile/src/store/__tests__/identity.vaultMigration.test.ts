/**
 * identity store — F-1b key vault migration at hydrate.
 *
 * An identity stored before F-1b has raw base64 secrets in SecureStore. The
 * first hydrate imports them into the vault and re-persists them as vault
 * blobs (the raw copies are replaced); later hydrates load the blobs and
 * write nothing. The keys work by handle exactly as the raw ones did.
 */

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve(undefined)),
  deleteItemAsync: jest.fn(() => Promise.resolve(undefined)),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
}));

jest.mock('../../db/local', () => ({
  loadIdentity: jest.fn(),
  saveIdentity: jest.fn().mockResolvedValue(undefined),
  setActiveDbSlot: jest.fn(),
  deleteIdentitySlot: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../crypto/ensureRegistered', () => ({
  ensureRegistered: jest.fn().mockResolvedValue({ ok: true }),
}));

jest.mock('../../net/homeRelay', () => ({ hydrateHomeRelay: jest.fn().mockResolvedValue(undefined) }));

import { nacl } from '../../crypto/sodium';
import { vault } from '../../crypto/sodium/vault';
import { useIdentity } from '../identity';
import type { StoredIdentity } from '../../db/local';
import { rawStoredIdentity } from '../../crypto/__tests__/helpers/rawIdentity';

const db = jest.requireMock('../../db/local') as { loadIdentity: jest.Mock; saveIdentity: jest.Mock };

function resetStore(): void {
  useIdentity.setState({ identity: null, status: 'idle', hydrated: false, activeSlotId: 'self', slotsList: ['self'] });
}

describe('identity store — vault migration at hydrate (F-1b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetStore();
  });

  it('imports raw pre-F-1b keys once and re-persists them as vault blobs', async () => {
    const raw = rawStoredIdentity();
    const stored: StoredIdentity = {
      aegisId: 'unused',
      publicKeyB64: raw.publicKeyB64,
      secretKeyStored: raw.secretKeyStored,
      signingPublicKeyB64: raw.signingPublicKeyB64,
      signingSecretKeyStored: raw.signingSecretKeyStored,
      createdAt: raw.createdAt,
    };
    db.loadIdentity.mockResolvedValue(stored);

    await useIdentity.getState().hydrate();

    const identity = useIdentity.getState().identity!;
    expect(identity.publicKeyB64).toBe(raw.publicKeyB64);
    // Handles, not bytes — and they operate like the raw keys.
    expect(identity.secretKey.type).toBe('x25519');
    const peer = nacl.box.keyPair();
    expect(vault.scalarMult(identity.secretKey, peer.publicKey)).toEqual(nacl.scalarMult(raw.box.secretKey, peer.publicKey));
    const msg = new TextEncoder().encode('migrated');
    expect(vault.sign(identity.signingSecretKey, msg)).toEqual(nacl.sign.detached(msg, raw.sign.secretKey));

    // Re-persisted as blobs: no raw secret left in what is written.
    expect(db.saveIdentity).toHaveBeenCalledTimes(1);
    const saved = db.saveIdentity.mock.calls[0][0] as StoredIdentity;
    expect(saved.secretKeyStored.startsWith('vault1:')).toBe(true);
    expect(saved.signingSecretKeyStored.startsWith('vault1:')).toBe(true);
    expect(saved.secretKeyStored).not.toContain(raw.secretKeyStored);
    expect(saved.signingSecretKeyStored).not.toContain(raw.signingSecretKeyStored);

    // Next launch loads the blobs and writes nothing.
    jest.clearAllMocks();
    resetStore();
    db.loadIdentity.mockResolvedValue(saved);
    await useIdentity.getState().hydrate();
    expect(db.saveIdentity).not.toHaveBeenCalled();
    expect(useIdentity.getState().identity!.publicKeyB64).toBe(raw.publicKeyB64);
  });

  it('a new identity is born in the vault and persisted only as blobs', async () => {
    await useIdentity.getState().generate();
    const saved = db.saveIdentity.mock.calls[0][0] as StoredIdentity;
    expect(saved.secretKeyStored.startsWith('vault1:')).toBe(true);
    expect(saved.signingSecretKeyStored.startsWith('vault1:')).toBe(true);
    expect(useIdentity.getState().identity!.secretKey.slot).toBe('self');
  });
});
