import { vault, toStored, isVaultStored, type VaultKey, type VaultExportPurpose } from './sodium/vault';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

export { isVaultStored };

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, charsOut: number): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  const totalBits = BigInt(bytes.length * 8);
  const needed = BigInt(charsOut * 5);
  if (totalBits > needed) bits = bits >> (totalBits - needed);
  else if (totalBits < needed) bits = bits << (needed - totalBits);
  let out = '';
  for (let i = charsOut - 1; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 0x1fn);
    out += CROCKFORD[idx];
  }
  return out;
}

export function deriveAegisId(publicKey: Uint8Array): string {
  if (publicKey.length < 7) throw new Error('public key too short');
  const head = publicKey.slice(0, 7);
  const raw = encodeBase32(head, 11);
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 11)}`;
}

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * The user's long-term identity. Its private keys live in the key vault (F-1b,
 * docs/F1B-KEY-VAULT-DESIGN.md): `secretKey` and `signingSecretKey` are vault
 * handles, never bytes, so the secrets do not exist in JavaScript. Operations
 * go through `vault.scalarMult/box/boxOpen` (X25519) and `vault.sign`
 * (Ed25519). What persists is `secretKeyStored` / `signingSecretKeyStored`:
 * the keys wrapped under the profile's KEK (see `toStored`).
 */
export interface Identity {
  aegisId: string;
  publicKey: Uint8Array;
  publicKeyB64: string;
  /** X25519 identity key (vault handle). */
  secretKey: VaultKey;
  signingPublicKey: Uint8Array;
  signingPublicKeyB64: string;
  /** Ed25519 identity key (vault handle). */
  signingSecretKey: VaultKey;
  /** Persisted form of `secretKey`: a vault blob of this profile. */
  secretKeyStored: string;
  /** Persisted form of `signingSecretKey`. */
  signingSecretKeyStored: string;
  createdAt: number;
}

function build(key: VaultKey, keyStored: string, sign: VaultKey, signStored: string, createdAt: number): Identity {
  return {
    aegisId: deriveAegisId(key.publicKey),
    publicKey: key.publicKey,
    publicKeyB64: encodeBase64(key.publicKey),
    secretKey: key,
    signingPublicKey: sign.publicKey,
    signingPublicKeyB64: encodeBase64(sign.publicKey),
    signingSecretKey: sign,
    secretKeyStored: keyStored,
    signingSecretKeyStored: signStored,
    createdAt,
  };
}

/**
 * A new identity in profile `slot` (unlocked). The signing key is derived from
 * the box secret (sign.keyPair.fromSeed) so a 32-word mnemonic fully restores
 * the identity — inside the vault, like everything else.
 */
export function createIdentity(slot = 'self'): Identity {
  const x = vault.generate(slot, 'x25519');
  const e = vault.deriveEd25519(x.key);
  return build(x.key, toStored(x.blob), e.key, toStored(e.blob), Date.now());
}

/**
 * Take raw identity keys into the vault: backup restore, recovery phrase,
 * device link, and the one-time migration of keys stored before F-1b. The
 * caller's copies are zeroed. Without a signing key it is derived from the box
 * secret, exactly as createIdentity does.
 */
export function importIdentity(slot: string, boxSecret: Uint8Array, signSecret: Uint8Array | null, createdAt: number): Identity {
  try {
    const x = vault.import(slot, 'x25519', boxSecret);
    let e: { key: VaultKey; blob: Uint8Array };
    try {
      e = signSecret ? vault.import(slot, 'ed25519', signSecret) : vault.deriveEd25519(x.key);
    } catch (err) {
      vault.release(x.key);
      throw err;
    }
    return build(x.key, toStored(x.blob), e.key, toStored(e.blob), createdAt);
  } finally {
    boxSecret.fill(0);
    signSecret?.fill(0);
  }
}

/** The same identity as a key set of profile `slot` (unlocked); the original handles are released. */
export function moveIdentity(identity: Identity, slot: string): Identity {
  if (identity.secretKey.slot === slot) return identity;
  const x = vault.copy(identity.secretKey, slot);
  const e = vault.copy(identity.signingSecretKey, slot);
  vault.release(identity.secretKey);
  vault.release(identity.signingSecretKey);
  return build(x.key, toStored(x.blob), e.key, toStored(e.blob), identity.createdAt);
}

/**
 * The raw identity secrets, for the explicit exports ONLY (design doc §5).
 * The main process asks the user first, in a native dialog the renderer cannot
 * click (VaultExportDeniedError if declined). The caller zeroes both.
 */
export function exportIdentitySecrets(identity: Identity, purpose: VaultExportPurpose): { secretKey: Uint8Array; signingSecretKey: Uint8Array } {
  const secretKey = vault.exportSecret(identity.secretKey, purpose);
  try {
    return { secretKey, signingSecretKey: vault.exportSecret(identity.signingSecretKey, purpose) };
  } catch (e) {
    secretKey.fill(0);
    throw e;
  }
}

/** XOR-accumulated constant-time comparison for key material (golden rule #8). */
function constantTimeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/**
 * The identity of profile `slot` (unlocked) from its persisted form. Keys
 * stored before F-1b (raw base64) are imported into the vault here; the result
 * then carries their blob form and the caller re-persists it when
 * `secretKeyStored` / `signingSecretKeyStored` differ from what it loaded.
 */
export function identityFromStored(
  opts: {
    publicKeyB64: string;
    secretKeyStored: string;
    signingPublicKeyB64?: string;
    signingSecretKeyStored?: string;
    createdAt: number;
  },
  slot = 'self',
): Identity {
  const x = vault.openStored(slot, 'x25519', opts.secretKeyStored);

  // Integrity check: publicKeyB64 and the secret are written to two different
  // stores (SQLite vs SecureStore) by two separate operations in saveIdentity —
  // if one write lands and the other fails/retries with a DIFFERENT keypair,
  // the two halves silently stop matching. Every future encrypt/sign then fails
  // against whatever the relay and contacts actually have on file (e.g.
  // permanent 403 invalid_signature on prekey upload). Failing loudly here
  // converts that into a clear, debuggable error instead of a perpetual silent
  // failure (golden rule #1). The vault computes the public half from the
  // secret itself, so the comparison is against the real key.
  if (!constantTimeEqualBytes(x.key.publicKey, decodeBase64(opts.publicKeyB64))) {
    vault.release(x.key);
    throw new Error('identity corrupted: secretKey does not match publicKeyB64');
  }

  // Missing signing material (pre-multi-key DBs): DERIVE it deterministically
  // from the box secret key, exactly as createIdentity does. A throwaway RANDOM
  // pair would produce signatures no contact can verify (sealed-sender rejects
  // everything) AND would mask a corrupted/half-written identity as valid.
  let e: { key: VaultKey; stored: string };
  if (opts.signingPublicKeyB64 && opts.signingSecretKeyStored) {
    try {
      e = vault.openStored(slot, 'ed25519', opts.signingSecretKeyStored);
    } catch (err) {
      vault.release(x.key);
      // Importing an Ed25519 secret checks that its embedded public half is
      // the one its seed derives (sign.detached only ever uses the seed).
      if (!isVaultStored(opts.signingSecretKeyStored)) {
        throw new Error('identity corrupted: signingSecretKey does not match signingPublicKeyB64');
      }
      throw err;
    }
    // The vault's public half comes from the seed: a secret whose embedded
    // bytes were patched to match signingPublicKeyB64 while its seed stayed
    // unrelated cannot pass.
    if (!constantTimeEqualBytes(e.key.publicKey, decodeBase64(opts.signingPublicKeyB64))) {
      vault.release(x.key);
      vault.release(e.key);
      throw new Error('identity corrupted: signingSecretKey does not match signingPublicKeyB64');
    }
  } else {
    const d = vault.deriveEd25519(x.key);
    e = { key: d.key, stored: toStored(d.blob) };
  }
  return build(x.key, x.stored, e.key, e.stored, opts.createdAt);
}
