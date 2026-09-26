/**
 * identityFromStored.derive.test.ts — regression for the audit 2026-06 fix:
 * when a stored identity lacks signing material (pre-multi-key DB), the signing
 * key is DERIVED deterministically from the box secret (nacl.sign.keyPair
 * .fromSeed) — restoring the user's REAL signing identity — instead of a
 * throwaway random pair that no contact could verify (sealed-sender breakage).
 * The derivation happens inside the key vault (F-1b).
 */
import { encodeBase64 } from 'tweetnacl-util';
import { nacl } from '../sodium';
import { vault } from '../sodium/vault';
import { createIdentity, identityFromStored } from '../identity';
import { rawStoredIdentity } from './helpers/rawIdentity';

describe('identityFromStored deterministic signing derivation (audit 2026-06)', () => {
  it('derives the real signing key from the box secret when signing material is missing', () => {
    const raw = rawStoredIdentity();
    const restored = identityFromStored({
      publicKeyB64: raw.publicKeyB64,
      secretKeyStored: raw.secretKeyStored,
      // signing fields intentionally omitted — simulates a pre-multi-key DB
      createdAt: raw.createdAt,
    });

    const expected = nacl.sign.keyPair.fromSeed(raw.box.secretKey);
    expect(restored.signingPublicKeyB64).toBe(encodeBase64(expected.publicKey));
    // …and that equals the identity's REAL signing key, not a random throwaway.
    expect(restored.signingPublicKeyB64).toBe(raw.signingPublicKeyB64);
    // The derived key signs exactly as the raw one would.
    const msg = new TextEncoder().encode('derive');
    expect(vault.sign(restored.signingSecretKey, msg)).toEqual(nacl.sign.detached(msg, raw.sign.secretKey));
  });

  it('is deterministic across calls', () => {
    const id = createIdentity();
    const a = identityFromStored({ publicKeyB64: id.publicKeyB64, secretKeyStored: id.secretKeyStored, createdAt: id.createdAt });
    const b = identityFromStored({ publicKeyB64: id.publicKeyB64, secretKeyStored: id.secretKeyStored, createdAt: id.createdAt });
    expect(a.signingPublicKeyB64).toBe(b.signingPublicKeyB64);
    expect(a.signingPublicKeyB64).toBe(id.signingPublicKeyB64);
  });

  it('still honours explicitly stored signing material', () => {
    const id = createIdentity();
    const restored = identityFromStored({
      publicKeyB64: id.publicKeyB64,
      secretKeyStored: id.secretKeyStored,
      signingPublicKeyB64: id.signingPublicKeyB64,
      signingSecretKeyStored: id.signingSecretKeyStored,
      createdAt: id.createdAt,
    });
    expect(restored.signingPublicKeyB64).toBe(id.signingPublicKeyB64);
    // A loaded blob is kept as is: nothing to re-persist.
    expect(restored.signingSecretKeyStored).toBe(id.signingSecretKeyStored);
    expect(restored.secretKeyStored).toBe(id.secretKeyStored);
  });

  it('migrates raw pre-F-1b keys: the result carries vault blobs to re-persist', () => {
    const raw = rawStoredIdentity();
    const migrated = identityFromStored(raw);
    expect(migrated.secretKeyStored.startsWith('vault1:')).toBe(true);
    expect(migrated.signingSecretKeyStored.startsWith('vault1:')).toBe(true);
    expect(migrated.secretKeyStored).not.toContain(raw.secretKeyStored);
    // Loading the migrated form gives the same keys.
    const again = identityFromStored({
      publicKeyB64: migrated.publicKeyB64,
      secretKeyStored: migrated.secretKeyStored,
      signingPublicKeyB64: migrated.signingPublicKeyB64,
      signingSecretKeyStored: migrated.signingSecretKeyStored,
      createdAt: migrated.createdAt,
    });
    const peer = nacl.box.keyPair();
    expect(vault.scalarMult(again.secretKey, peer.publicKey)).toEqual(nacl.scalarMult(raw.box.secretKey, peer.publicKey));
  });
});
