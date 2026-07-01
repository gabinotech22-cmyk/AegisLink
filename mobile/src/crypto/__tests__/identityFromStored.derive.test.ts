/**
 * identityFromStored.derive.test.ts — regression for the audit 2026-06 fix:
 * when a stored identity lacks signing material (pre-multi-key DB), the signing
 * key is DERIVED deterministically from the box secret (nacl.sign.keyPair
 * .fromSeed) — restoring the user's REAL signing identity — instead of a
 * throwaway random pair that no contact could verify (sealed-sender breakage).
 */
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { createIdentity, identityFromStored } from '../identity';

describe('identityFromStored deterministic signing derivation (audit 2026-06)', () => {
  it('derives the real signing key from the box secret when signing material is missing', () => {
    const id = createIdentity();
    const restored = identityFromStored({
      publicKeyB64: id.publicKeyB64,
      secretKeyB64: id.secretKeyB64,
      // signing fields intentionally omitted — simulates a pre-multi-key DB
      createdAt: id.createdAt,
    });

    const expected = nacl.sign.keyPair.fromSeed(id.secretKey);
    expect(restored.signingPublicKeyB64).toBe(encodeBase64(expected.publicKey));
    // …and that equals the identity's REAL signing key, not a random throwaway.
    expect(restored.signingPublicKeyB64).toBe(id.signingPublicKeyB64);
  });

  it('is deterministic across calls', () => {
    const id = createIdentity();
    const a = identityFromStored({
      publicKeyB64: id.publicKeyB64,
      secretKeyB64: id.secretKeyB64,
      createdAt: id.createdAt,
    });
    const b = identityFromStored({
      publicKeyB64: id.publicKeyB64,
      secretKeyB64: id.secretKeyB64,
      createdAt: id.createdAt,
    });
    expect(a.signingPublicKeyB64).toBe(b.signingPublicKeyB64);
  });

  it('still honours explicitly stored signing material', () => {
    const id = createIdentity();
    const restored = identityFromStored({
      publicKeyB64: id.publicKeyB64,
      secretKeyB64: id.secretKeyB64,
      signingPublicKeyB64: id.signingPublicKeyB64,
      signingSecretKeyB64: id.signingSecretKeyB64,
      createdAt: id.createdAt,
    });
    expect(restored.signingPublicKeyB64).toBe(id.signingPublicKeyB64);
    expect(restored.signingSecretKeyB64).toBe(id.signingSecretKeyB64);
  });
});
