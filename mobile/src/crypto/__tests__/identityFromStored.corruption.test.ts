/**
 * identityFromStored.corruption.test.ts — regression for a real production
 * incident (2026-08-10): saveIdentity() used to write SecureStore (private
 * keys) BEFORE SQLite (public identity row). When the SQLite write then
 * failed — e.g. a schema-init crash on that DB handle — SecureStore was left
 * holding a brand-new keypair while SQLite kept the OLD identity row. The
 * next loadIdentity() silently recombined the OLD aegisId/publicKey with the
 * NEW, unrelated secretKey into a keypair-that-never-was: every signature
 * made with it failed to verify against what the relay/contacts actually had
 * on file, surfacing as a permanent 403 invalid_signature on prekey upload.
 *
 * identityFromStored is the single trust boundary all stored identity data
 * passes through (db/local → store/identity.ts), so it is where the
 * integrity check belongs: fail loud on a mismatch instead of silently
 * returning a broken keypair (golden rule #1).
 */
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { createIdentity, identityFromStored } from '../identity';

describe('identityFromStored — corrupted (mismatched) key material', () => {
  it('throws when secretKeyB64 does not correspond to publicKeyB64', () => {
    const a = createIdentity();
    const b = createIdentity();

    expect(() =>
      identityFromStored({
        publicKeyB64: a.publicKeyB64,
        // A completely unrelated secret key — simulates the SecureStore write
        // from a different, later saveIdentity() attempt landing while SQLite
        // still holds the earlier identity's public row.
        secretKeyB64: b.secretKeyB64,
        createdAt: a.createdAt,
      }),
    ).toThrow(/identity corrupted/);
  });

  it('throws when signingSecretKeyB64 does not correspond to signingPublicKeyB64', () => {
    const id = createIdentity();
    const other = createIdentity();

    expect(() =>
      identityFromStored({
        publicKeyB64: id.publicKeyB64,
        secretKeyB64: id.secretKeyB64,
        signingPublicKeyB64: id.signingPublicKeyB64,
        // Mismatched signing secret from an unrelated identity.
        signingSecretKeyB64: other.signingSecretKeyB64,
        createdAt: id.createdAt,
      }),
    ).toThrow(/identity corrupted/);
  });

  it('does not throw for a genuinely consistent identity', () => {
    const id = createIdentity();
    expect(() =>
      identityFromStored({
        publicKeyB64: id.publicKeyB64,
        secretKeyB64: id.secretKeyB64,
        signingPublicKeyB64: id.signingPublicKeyB64,
        signingSecretKeyB64: id.signingSecretKeyB64,
        createdAt: id.createdAt,
      }),
    ).not.toThrow();
  });

  it('does not throw when signing material is legitimately absent (derives instead)', () => {
    const id = createIdentity();
    expect(() =>
      identityFromStored({
        publicKeyB64: id.publicKeyB64,
        secretKeyB64: id.secretKeyB64,
        createdAt: id.createdAt,
      }),
    ).not.toThrow();
  });

  it('sanity: a tampered publicKeyB64 (single flipped byte) is caught', () => {
    const id = createIdentity();
    const tampered = new Uint8Array(nacl.box.keyPair.fromSecretKey(id.secretKey).publicKey);
    tampered[0] ^= 0xff;

    expect(() =>
      identityFromStored({
        publicKeyB64: encodeBase64(tampered),
        secretKeyB64: id.secretKeyB64,
        createdAt: id.createdAt,
      }),
    ).toThrow(/identity corrupted/);
  });
});
