/**
 * The relay's single entry point for NaCl primitives (post-audit follow-up F-1).
 *
 * Production code never imports a crypto library directly — it imports `nacl`
 * from here (enforced by `src/__tests__/crypto-imports.test.ts`). The backend is
 * native libsodium (`./native.ts`, sodium-native), byte-compatible with the
 * TweetNaCl implementation it replaced: nothing on the wire changes
 * (`f1-golden.test.ts`).
 *
 * Hashing, HMAC, HKDF and constant-time comparison already go through
 * `node:crypto` (OpenSSL, native) and stay there.
 *
 * Client twins: `mobile/src/crypto/sodium/index.ts`,
 * `desktop/src/renderer/crypto/sodium/index.ts`.
 */
import * as native from './native.js';

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

// Fresh wrapper functions: never decorate the native module's own exports.
const box = Object.assign(
  (msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array =>
    native.box(msg, nonce, publicKey, secretKey),
  {
    open: native.boxOpen,
    keyPair: native.boxKeyPair,
    publicKeyLength: native.LENGTHS.boxPublicKey,
    nonceLength: native.LENGTHS.nonce,
  },
);

const secretbox = Object.assign(
  (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array => native.secretbox(msg, nonce, key),
  {
    open: native.secretboxOpen,
    keyLength: native.LENGTHS.secretboxKey,
    nonceLength: native.LENGTHS.nonce,
  },
);

const sign = {
  detached: Object.assign(
    (msg: Uint8Array, secretKey: Uint8Array): Uint8Array => native.signDetached(msg, secretKey),
    { verify: native.signVerifyDetached },
  ),
  keyPair: native.signKeyPair,
  publicKeyLength: native.LENGTHS.signPublicKey,
  signatureLength: native.LENGTHS.signature,
};

export const nacl: NaclPrimitives = {
  randomBytes: native.randomBytes,
  box,
  secretbox,
  sign,
};
