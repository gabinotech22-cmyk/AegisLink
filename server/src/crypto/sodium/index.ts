/**
 * The relay's single entry point for NaCl primitives (post-audit follow-up F-1).
 *
 * Production code never imports `tweetnacl` directly — it imports `nacl` from
 * here (enforced by `src/__tests__/crypto-imports.test.ts`), so the switch to
 * native libsodium (sodium-native) is a change to this one directory.
 * libsodium's crypto_box / crypto_secretbox / crypto_sign are byte-compatible
 * with NaCl: nothing on the wire changes.
 *
 * Hashing, HMAC, HKDF and constant-time comparison already go through
 * `node:crypto` (OpenSSL, native) and stay there.
 *
 * Client twins: `mobile/src/crypto/sodium/index.ts`,
 * `desktop/src/renderer/crypto/sodium/index.ts`.
 */
import tweetnacl from 'tweetnacl';

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
  box: {
    (msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null;
    keyPair: () => BoxKeyPair;
    readonly publicKeyLength: number;
    readonly nonceLength: number;
  };
  secretbox: {
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
    readonly keyLength: number;
    readonly nonceLength: number;
  };
  sign: {
    detached: {
      (msg: Uint8Array, secretKey: Uint8Array): Uint8Array;
      /** Call only from `crypto/ed25519.ts` — everything else uses `verifyDetached`. */
      verify(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean;
    };
    keyPair: () => SignKeyPair;
    readonly publicKeyLength: number;
    readonly signatureLength: number;
  };
}

export const nacl: NaclPrimitives = tweetnacl;
