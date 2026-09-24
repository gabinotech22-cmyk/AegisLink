/**
 * The single entry point for low-level crypto primitives (post-audit follow-up F-1).
 *
 * Production code never imports a crypto library directly — it imports `nacl`
 * and the hash helpers from here (enforced by `../__tests__/crypto-imports.test.ts`).
 *
 * Backend: NATIVE libsodium (sodium-native) and node:crypto running in the
 * Electron main process for every KEYED primitive (NaCl box/secretbox/X25519/
 * Ed25519, HMAC, HKDF). The renderer is sandboxed and cannot load native
 * addons, so those are IPC calls (`window.aegis.sodium`, see
 * `src/main/ipc/sodium.ts`). Calls are synchronous (`sendSync`, ~0.2 ms) so the
 * ratchet / X3DH / sealed-sender API stays synchronous and in lockstep with
 * mobile; whole attachments use the async variants below.
 *
 * SHA-256/512 stay in-process (@noble): an unkeyed hash has no secret-dependent
 * branches or table lookups to leak through timing, and the registration
 * proof-of-work hashes ~260k times — ~0.2 ms of IPC each would turn seconds
 * into about a minute.
 *
 * libsodium's crypto_box / crypto_secretbox / crypto_scalarmult / crypto_sign
 * are byte-compatible with the TweetNaCl implementation this replaced (pinned
 * by `f1-golden.test.ts`); errors keep TweetNaCl's classes and messages.
 * Deliberate, stricter differences (fail closed): `scalarMult` throws on a
 * low-order point, and Ed25519 verification rejects small-order public keys.
 *
 * `nacl` exposes only the subset of the TweetNaCl API the desktop uses.
 * Out of scope (stays on @noble, see docs/ROADMAP.md): Argon2id / PBKDF2 and
 * ML-KEM-768.
 *
 * Same API: `mobile/src/crypto/sodium/index.ts`.
 */
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import { sodiumBridge } from './sodiumIpcBridge';
import type { SodiumResult } from '../ipc-types';

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
  /** Constant-time equality (sodium_memcmp); false for empty or different-length inputs. */
  verify(x: Uint8Array, y: Uint8Array): boolean;
  box: {
    (msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
    open(box: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null;
    /** Precomputed shared key (crypto_box_beforenm); throws on a low-order public key. */
    before(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array;
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

function unwrap<T>(result: unknown): T {
  const r = result as SodiumResult;
  if (!r || typeof r !== 'object' || typeof r.ok !== 'boolean') {
    throw new Error('native crypto bridge returned an invalid result');
  }
  if (!r.ok) throw r.errorName === 'TypeError' ? new TypeError(r.message) : new Error(r.message);
  return r.value as T;
}

function call<T>(op: string, ...args: Array<Uint8Array | number | undefined>): T {
  return unwrap<T>(sodiumBridge().call(op, args));
}

async function callAsync<T>(op: string, ...args: Array<Uint8Array | number | undefined>): Promise<T> {
  return unwrap<T>(await sodiumBridge().callAsync(op, args));
}

const box = Object.assign(
  (msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array =>
    call('box', msg, nonce, publicKey, secretKey),
  {
    open: (b: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null =>
      call('boxOpen', b, nonce, publicKey, secretKey),
    before: (publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array => call('boxBefore', publicKey, secretKey),
    keyPair: Object.assign((): BoxKeyPair => call('boxKeyPair'), {
      fromSecretKey: (secretKey: Uint8Array): BoxKeyPair => call('boxKeyPairFromSecretKey', secretKey),
    }),
    publicKeyLength: 32,
    secretKeyLength: 32,
    nonceLength: 24,
    overheadLength: 16,
  },
);

const secretbox = Object.assign(
  (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array => call('secretbox', msg, nonce, key),
  {
    open: (b: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null =>
      call('secretboxOpen', b, nonce, key),
    keyLength: 32,
    nonceLength: 24,
    overheadLength: 16,
  },
);

const scalarMult = Object.assign((n: Uint8Array, p: Uint8Array): Uint8Array => call('scalarMult', n, p), {
  base: (n: Uint8Array): Uint8Array => call('scalarMultBase', n),
});

const sign = {
  detached: Object.assign(
    (msg: Uint8Array, secretKey: Uint8Array): Uint8Array => call('signDetached', msg, secretKey),
    {
      verify: (msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean =>
        call('signVerifyDetached', msg, sig, publicKey),
    },
  ),
  keyPair: Object.assign((): SignKeyPair => call('signKeyPair'), {
    fromSeed: (seed: Uint8Array): SignKeyPair => call('signKeyPairFromSeed', seed),
  }),
  publicKeyLength: 32,
  secretKeyLength: 64,
  seedLength: 32,
  signatureLength: 64,
};

export const nacl: NaclPrimitives = {
  randomBytes: (n: number): Uint8Array => call('randomBytes', n),
  verify: (x: Uint8Array, y: Uint8Array): boolean => call('verify', x, y),
  box,
  secretbox,
  scalarMult,
  sign,
};

/** `nacl.secretbox` for whole attachments: runs off the renderer's synchronous path. */
export function secretboxAsync(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array> {
  return callAsync('secretbox', msg, nonce, key);
}

/** `nacl.secretbox.open` for whole attachments: runs off the renderer's synchronous path. */
export function secretboxOpenAsync(b: Uint8Array, nonce: Uint8Array, key: Uint8Array): Promise<Uint8Array | null> {
  return callAsync('secretboxOpen', b, nonce, key);
}

/** In-process (unkeyed, see the header): stays fast for the proof-of-work loops. */
export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function sha512(data: Uint8Array): Uint8Array {
  return nobleSha512(data);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return call('hmacSha256', key, data);
}

/** RFC 5869 HKDF-SHA256. An undefined salt means HashLen zero bytes (per the RFC). */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | undefined,
  length: number,
): Uint8Array {
  return call('hkdfSha256', ikm, salt, info, length);
}
