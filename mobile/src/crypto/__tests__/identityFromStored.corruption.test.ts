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
 * returning a broken keypair (golden rule #1). It holds for both stored forms:
 * vault blobs (F-1b) and raw keys stored before F-1b (migrated on load).
 */
import { encodeBase64 } from 'tweetnacl-util';
import { createIdentity, identityFromStored } from '../identity';
import { rawStoredIdentity } from './helpers/rawIdentity';

describe('identityFromStored — corrupted (mismatched) key material', () => {
  it('throws when the stored secret key does not correspond to publicKeyB64 (vault blobs)', () => {
    const a = createIdentity();
    const b = createIdentity();

    expect(() =>
      identityFromStored({
        publicKeyB64: a.publicKeyB64,
        // A completely unrelated secret key — simulates the SecureStore write
        // from a different, later saveIdentity() attempt landing while SQLite
        // still holds the earlier identity's public row.
        secretKeyStored: b.secretKeyStored,
        createdAt: a.createdAt,
      }),
    ).toThrow(/identity corrupted/);
  });

  it('throws when the stored secret key does not correspond to publicKeyB64 (raw, pre-F-1b)', () => {
    const a = rawStoredIdentity();
    const b = rawStoredIdentity();
    expect(() =>
      identityFromStored({ publicKeyB64: a.publicKeyB64, secretKeyStored: b.secretKeyStored, createdAt: a.createdAt }),
    ).toThrow(/identity corrupted/);
  });

  it('throws when the signing secret does not correspond to signingPublicKeyB64', () => {
    const id = createIdentity();
    const other = createIdentity();

    expect(() =>
      identityFromStored({
        publicKeyB64: id.publicKeyB64,
        secretKeyStored: id.secretKeyStored,
        signingPublicKeyB64: id.signingPublicKeyB64,
        // Mismatched signing secret from an unrelated identity.
        signingSecretKeyStored: other.signingSecretKeyStored,
        createdAt: id.createdAt,
      }),
    ).toThrow(/identity corrupted/);

    const raw = rawStoredIdentity();
    const rawOther = rawStoredIdentity();
    expect(() =>
      identityFromStored({ ...raw, signingSecretKeyStored: rawOther.signingSecretKeyStored }),
    ).toThrow(/identity corrupted/);
  });

  it('throws when only the signing SEED is corrupted but the embedded public-key bytes still match', () => {
    // nacl.sign.detached() only ever reads the seed (first 32 bytes) to
    // compute a signature — the embedded public-key bytes (last 32) are a
    // convenience copy never read back for signing. A bytes-only comparison
    // against those embedded bytes would miss this: patch the seed while
    // keeping the embedded public-key bytes intact and matching
    // signingPublicKeyB64, so the ONLY way to catch it is deriving from the
    // seed itself — which the vault does on import.
    const raw = rawStoredIdentity();
    const tamperedSecret = new Uint8Array(raw.sign.secretKey);
    tamperedSecret[0] ^= 0xff; // corrupt one byte of the seed half only

    expect(() =>
      identityFromStored({ ...raw, signingSecretKeyStored: encodeBase64(tamperedSecret) }),
    ).toThrow(/identity corrupted/);
  });

  it('does not throw for a genuinely consistent identity, in either stored form', () => {
    const id = createIdentity();
    expect(() =>
      identityFromStored({
        publicKeyB64: id.publicKeyB64,
        secretKeyStored: id.secretKeyStored,
        signingPublicKeyB64: id.signingPublicKeyB64,
        signingSecretKeyStored: id.signingSecretKeyStored,
        createdAt: id.createdAt,
      }),
    ).not.toThrow();
    expect(() => identityFromStored(rawStoredIdentity())).not.toThrow();
  });

  it('does not throw when signing material is legitimately absent (derives instead)', () => {
    const id = createIdentity();
    expect(() =>
      identityFromStored({ publicKeyB64: id.publicKeyB64, secretKeyStored: id.secretKeyStored, createdAt: id.createdAt }),
    ).not.toThrow();
  });

  it('sanity: a tampered publicKeyB64 (single flipped byte) is caught', () => {
    const id = createIdentity();
    const tampered = new Uint8Array(id.publicKey);
    tampered[0] ^= 0xff;

    expect(() =>
      identityFromStored({
        publicKeyB64: encodeBase64(tampered),
        secretKeyStored: id.secretKeyStored,
        createdAt: id.createdAt,
      }),
    ).toThrow(/identity corrupted/);
  });

  it('a blob of another profile is rejected, not loaded', async () => {
    const { vault } = await import('../sodium/vault');
    await vault.unlock('work');
    const id = createIdentity('work');
    expect(() =>
      identityFromStored({ publicKeyB64: id.publicKeyB64, secretKeyStored: id.secretKeyStored, createdAt: id.createdAt }, 'self'),
    ).toThrow(/blob rejected/);
  });
});
