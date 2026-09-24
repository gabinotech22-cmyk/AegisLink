/**
 * The single entry point for low-level crypto primitives (post-audit follow-up F-1).
 *
 * Production code never imports `tweetnacl` or the `@noble/hashes` MAC/KDF/hash
 * modules directly — it imports `nacl` and the hash helpers from here
 * (enforced by `../__tests__/crypto-imports.test.ts`). That makes this file the
 * one seam where the implementation is swapped for a native libsodium binding
 * without touching the protocol code: libsodium's crypto_box / crypto_secretbox /
 * crypto_scalarmult / crypto_sign are byte-compatible with NaCl, so sessions,
 * ratchet state, backups and the wire format stay unchanged.
 *
 * `nacl` deliberately exposes only the subset of the TweetNaCl API the codebase
 * uses: that list is exactly what the native backend has to provide.
 *
 * Out of scope here (stay on @noble for now, see docs/ROADMAP.md): Argon2id /
 * PBKDF2 (the backup format pins a 32-byte salt that crypto_pwhash cannot take)
 * and ML-KEM-768.
 *
 * Same file, same API: `desktop/src/renderer/crypto/sodium/index.ts`.
 */
import tweetnacl from 'tweetnacl';
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';

export interface BoxKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface SignKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface NaclPrimitives {
  randomBytes(n: number): Uint8Array;
  /** Constant-time equality of two equal-length arrays (false on length mismatch). */
  verify(x: Uint8Array, y: Uint8Array): boolean;
  box: {
    (msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    before(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null;
    keyPair: {
      (): BoxKeyPair;
      fromSecretKey(secretKey: Uint8Array): BoxKeyPair;
    };
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
  };
  secretbox: {
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    readonly keyLength: number;
    readonly nonceLength: number;
    readonly overheadLength: number;
  };
  scalarMult: {
    (n: Uint8Array, p: Uint8Array): Uint8Array;
    base(n: Uint8Array): Uint8Array;
  };
  sign: {
    detached: {
      (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
      /** Call only from `crypto/ed25519.ts` — everything else uses `verifyDetached`. */
      verify(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean;
    };
    keyPair: {
      (): SignKeyPair;
      fromSeed(seed: Uint8Array): SignKeyPair;
    };
    readonly publicKeyLength: number;
    readonly secretKeyLength: number;
    readonly seedLength: number;
    readonly signatureLength: number;
  };
}

export const nacl: NaclPrimitives = tweetnacl;

export { setRandomSource } from './random';

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function sha512(data: Uint8Array): Uint8Array {
  return nobleSha512(data);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(nobleSha256, key, data);
}

/** RFC 5869 HKDF-SHA256. An undefined salt means HashLen zero bytes (per the RFC). */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | undefined,
  length: number,
): Uint8Array {
  return hkdf(nobleSha256, ikm, salt, info, length);
}
