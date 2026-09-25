/**
 * The single entry point for low-level crypto primitives (post-audit follow-up F-1).
 *
 * Production code never imports `tweetnacl` or the `@noble/hashes` MAC/KDF/hash
 * modules directly — it imports `nacl` and the hash helpers from here
 * (enforced by `../__tests__/crypto-imports.test.ts`).
 *
 * Backend: NATIVE libsodium, compiled into the app from the vendored sources
 * (`modules/aegis-sodium`, F-1 B2) and called synchronously over JSI. Every
 * KEYED primitive runs there: NaCl box/secretbox, X25519, Ed25519, HMAC-SHA256,
 * HKDF-SHA256, constant-time comparison and the CSPRNG. libsodium's
 * crypto_box / crypto_secretbox / crypto_scalarmult / crypto_sign are
 * byte-compatible with the TweetNaCl this replaced (pinned by `f1-golden.test.ts`),
 * so sessions, ratchet state, backups and the wire format are unchanged.
 *
 * This wrapper keeps TweetNaCl's contract at the edges, so callers see no
 * change: wrong-length keys/nonces/signatures THROW with TweetNaCl's messages
 * in the same check order, a non-Uint8Array argument throws
 * `TypeError('unexpected type, use Uint8Array')`, and `open` returns null on a
 * bad MAC or a too-short box. Deliberate, stricter differences (libsodium's,
 * kept — fail closed): `scalarMult` / `box.before` / `box` THROW on a low-order
 * public key, and Ed25519 verification rejects small-order public keys.
 *
 * ML-KEM-768 (PQXDH prekeys and the PQ ratchet) runs natively too, with
 * @noble/post-quantum's API and bytes (`ml_kem768`, below). Argon2id (PIN and
 * backup KDFs) and the relay's proof-of-work miner run natively off the JS
 * thread (`argon2id`, `powSha256`, below), and so does PBKDF2 for legacy
 * backups (`pbkdf2Sha256`). Single unkeyed SHA-256/512 calls stay on @noble
 * (no secret-dependent branches or table lookups to leak through timing), as
 * on desktop.
 *
 * If the native module is missing from the binary (Expo Go, a stale dev
 * client), importing this file THROWS: there is no JavaScript fallback.
 *
 * Same API: `desktop/src/renderer/crypto/sodium/index.ts`.
 */
import { sha256 as nobleSha256, sha512 as nobleSha512 } from '@noble/hashes/sha2.js';
import AegisSodium, { AEGIS_OK, AEGIS_EVERIFY, AEGIS_EFAIL } from '../../../modules/aegis-sodium';

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

const MAC = 16;
const NONCE = 24;
const KEY = 32;
const SIGN_PUBLIC = 32;
const SIGN_SECRET = 64;
const SIGN_SEED = 32;
const SIGNATURE = 64;
const HKDF_MAX = 255 * 32;

if (AegisSodium.init() !== AEGIS_OK) {
  throw new Error('aegis-sodium: libsodium failed to initialize');
}

/**
 * A native call that must succeed. Every length was checked here first, so a
 * non-OK code is a broken invariant (or a low-order point, handled by callers)
 * — never silently ignored.
 */
function must(rc: number, what: string): void {
  if (rc !== AEGIS_OK) throw new Error(`aegis-sodium: ${what} failed (${rc})`);
}

function checkArrayTypes(...args: unknown[]): void {
  for (const a of args) {
    if (!(a instanceof Uint8Array)) throw new TypeError('unexpected type, use Uint8Array');
  }
}

function checkSecretboxLengths(key: Uint8Array, nonce: Uint8Array): void {
  if (key.length !== KEY) throw new Error('bad key size');
  if (nonce.length !== NONCE) throw new Error('bad nonce size');
}

function checkBoxLengths(publicKey: Uint8Array, secretKey: Uint8Array): void {
  if (publicKey.length !== KEY) throw new Error('bad public key size');
  if (secretKey.length !== KEY) throw new Error('bad secret key size');
}

function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  must(AegisSodium.randombytes(out), 'randombytes');
  return out;
}

function verify(x: Uint8Array, y: Uint8Array): boolean {
  checkArrayTypes(x, y);
  if (x.length === 0 || y.length === 0 || x.length !== y.length) return false;
  return AegisSodium.memcmp(x, y) === AEGIS_OK;
}

const box = Object.assign(
  (msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array => {
    checkArrayTypes(msg, nonce, publicKey, secretKey);
    checkBoxLengths(publicKey, secretKey);
    if (nonce.length !== NONCE) throw new Error('bad nonce size');
    const c = new Uint8Array(msg.length + MAC);
    const rc = AegisSodium.boxEasy(c, msg, nonce, publicKey, secretKey);
    if (rc === AEGIS_EFAIL) throw new Error('box: low-order public key');
    must(rc, 'box');
    return c;
  },
  {
    before: (publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array => {
      checkArrayTypes(publicKey, secretKey);
      checkBoxLengths(publicKey, secretKey);
      const k = new Uint8Array(KEY);
      const rc = AegisSodium.boxBeforenm(k, publicKey, secretKey);
      if (rc === AEGIS_EFAIL) throw new Error('scalarMult: low-order point (all-zero shared secret)');
      must(rc, 'box.before');
      return k;
    },
    open: (b: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null => {
      checkArrayTypes(b, nonce, publicKey, secretKey);
      checkBoxLengths(publicKey, secretKey);
      if (nonce.length !== NONCE) throw new Error('bad nonce size');
      if (b.length < MAC) return null;
      const m = new Uint8Array(b.length - MAC);
      const rc = AegisSodium.boxOpenEasy(m, b, nonce, publicKey, secretKey);
      if (rc === AEGIS_EVERIFY) return null;
      must(rc, 'box.open');
      return m;
    },
    keyPair: Object.assign(
      (): BoxKeyPair => {
        const publicKey = new Uint8Array(KEY);
        const secretKey = new Uint8Array(KEY);
        must(AegisSodium.boxKeypair(publicKey, secretKey), 'box.keyPair');
        return { publicKey, secretKey };
      },
      {
        fromSecretKey: (secretKey: Uint8Array): BoxKeyPair => {
          checkArrayTypes(secretKey);
          if (secretKey.length !== KEY) throw new Error('bad secret key size');
          const publicKey = new Uint8Array(KEY);
          must(AegisSodium.scalarmultBase(publicKey, secretKey), 'box.keyPair.fromSecretKey');
          return { publicKey, secretKey: new Uint8Array(secretKey) };
        },
      },
    ),
    publicKeyLength: KEY,
    secretKeyLength: KEY,
    nonceLength: NONCE,
    overheadLength: MAC,
  },
);

const secretbox = Object.assign(
  (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array => {
    checkArrayTypes(msg, nonce, key);
    checkSecretboxLengths(key, nonce);
    const c = new Uint8Array(msg.length + MAC);
    must(AegisSodium.secretboxEasy(c, msg, nonce, key), 'secretbox');
    return c;
  },
  {
    open: (b: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null => {
      checkArrayTypes(b, nonce, key);
      checkSecretboxLengths(key, nonce);
      if (b.length < MAC) return null;
      const m = new Uint8Array(b.length - MAC);
      const rc = AegisSodium.secretboxOpenEasy(m, b, nonce, key);
      if (rc === AEGIS_EVERIFY) return null;
      must(rc, 'secretbox.open');
      return m;
    },
    keyLength: KEY,
    nonceLength: NONCE,
    overheadLength: MAC,
  },
);

const scalarMult = Object.assign(
  (n: Uint8Array, p: Uint8Array): Uint8Array => {
    checkArrayTypes(n, p);
    if (n.length !== KEY) throw new Error('bad n size');
    if (p.length !== KEY) throw new Error('bad p size');
    const q = new Uint8Array(KEY);
    const rc = AegisSodium.scalarmult(q, n, p);
    if (rc === AEGIS_EFAIL) throw new Error('scalarMult: low-order point (all-zero shared secret)');
    must(rc, 'scalarMult');
    return q;
  },
  {
    base: (n: Uint8Array): Uint8Array => {
      checkArrayTypes(n);
      if (n.length !== KEY) throw new Error('bad n size');
      const q = new Uint8Array(KEY);
      must(AegisSodium.scalarmultBase(q, n), 'scalarMult.base');
      return q;
    },
  },
);

const sign = {
  detached: Object.assign(
    (msg: Uint8Array, secretKey: Uint8Array): Uint8Array => {
      checkArrayTypes(msg, secretKey);
      if (secretKey.length !== SIGN_SECRET) throw new Error('bad secret key size');
      const sig = new Uint8Array(SIGNATURE);
      must(AegisSodium.signDetached(sig, msg, secretKey), 'sign.detached');
      return sig;
    },
    {
      verify: (msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean => {
        checkArrayTypes(msg, sig, publicKey);
        if (sig.length !== SIGNATURE) throw new Error('bad signature size');
        if (publicKey.length !== SIGN_PUBLIC) throw new Error('bad public key size');
        return AegisSodium.signVerifyDetached(sig, msg, publicKey) === AEGIS_OK;
      },
    },
  ),
  keyPair: Object.assign(
    (): SignKeyPair => {
      const publicKey = new Uint8Array(SIGN_PUBLIC);
      const secretKey = new Uint8Array(SIGN_SECRET);
      must(AegisSodium.signKeypair(publicKey, secretKey), 'sign.keyPair');
      return { publicKey, secretKey };
    },
    {
      fromSeed: (seed: Uint8Array): SignKeyPair => {
        checkArrayTypes(seed);
        if (seed.length !== SIGN_SEED) throw new Error('bad seed size');
        const publicKey = new Uint8Array(SIGN_PUBLIC);
        const secretKey = new Uint8Array(SIGN_SECRET);
        must(AegisSodium.signSeedKeypair(publicKey, secretKey, seed), 'sign.keyPair.fromSeed');
        return { publicKey, secretKey };
      },
    },
  ),
  publicKeyLength: SIGN_PUBLIC,
  secretKeyLength: SIGN_SECRET,
  seedLength: SIGN_SEED,
  signatureLength: SIGNATURE,
};

export const nacl: NaclPrimitives = { randomBytes, verify, box, secretbox, scalarMult, sign };

export function sha256(data: Uint8Array): Uint8Array {
  return nobleSha256(data);
}

export function sha512(data: Uint8Array): Uint8Array {
  return nobleSha512(data);
}

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  checkArrayTypes(key, data);
  const out = new Uint8Array(32);
  must(AegisSodium.hmacsha256(out, data, key), 'hmacSha256');
  return out;
}

/** RFC 5869 HKDF-SHA256. An undefined salt means HashLen zero bytes (per the RFC). */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | undefined,
  length: number,
): Uint8Array {
  checkArrayTypes(ikm, salt ?? new Uint8Array(0), info ?? new Uint8Array(0));
  if (!Number.isSafeInteger(length) || length < 1 || length > HKDF_MAX) {
    throw new Error('hkdfSha256: length must be 1..8160');
  }
  const out = new Uint8Array(length);
  must(
    AegisSodium.hkdfSha256(out, ikm, salt ?? new Uint8Array(0), info ?? new Uint8Array(0)),
    'hkdfSha256',
  );
  return out;
}

/** Argon2id parameters, same names as @noble/hashes. Only one lane (`p: 1`) is supported. */
export interface Argon2idOpts {
  t: number;
  m: number;
  p: 1;
  dkLen: number;
}

// Mirrors the C core's bounds (modules/aegis-sodium/cpp/aegis_sodium.h), so a
// bad call fails here with a clear message; the C core checks again.
const ARGON2_OUT = [16, 64] as const;
const ARGON2_SALT = [8, 64] as const;
const ARGON2_PWD_MAX = 65536;
const ARGON2_T = [1, 16] as const;
const ARGON2_M_KIB = [8, 262144] as const;
const inRange = (v: number, [lo, hi]: readonly [number, number]): boolean =>
  Number.isSafeInteger(v) && v >= lo && v <= hi;

/**
 * Argon2id (RFC 9106, v1.3), byte-identical to @noble/hashes `argon2id` with the
 * same parameters, but native and off the JS thread: the app's backup KDF
 * (64 MiB, 3 passes) took minutes on Hermes in JavaScript. Any salt of 8–64
 * bytes works (libsodium's public crypto_pwhash only takes 16), so existing
 * 32-byte backup salts and domain-string salts derive unchanged.
 */
export async function argon2id(password: Uint8Array, salt: Uint8Array, opts: Argon2idOpts): Promise<Uint8Array> {
  checkArrayTypes(password, salt);
  if (opts.p !== 1) throw new Error('argon2id: only p = 1 is supported');
  if (!inRange(opts.dkLen, ARGON2_OUT)) throw new Error('argon2id: dkLen must be 16..64');
  if (!inRange(salt.length, ARGON2_SALT)) throw new Error('argon2id: salt must be 8..64 bytes');
  if (password.length > ARGON2_PWD_MAX) throw new Error('argon2id: password too long');
  if (!inRange(opts.t, ARGON2_T)) throw new Error('argon2id: t must be 1..16');
  if (!inRange(opts.m, ARGON2_M_KIB)) throw new Error('argon2id: m must be 8..262144 KiB');
  const bytes = await AegisSodium.argon2id(password, salt, opts.t, opts.m, opts.dkLen);
  try {
    if (!Array.isArray(bytes) || bytes.length !== opts.dkLen) throw new Error('aegis-sodium: argon2id failed');
    return Uint8Array.from(bytes);
  } finally {
    if (Array.isArray(bytes)) bytes.fill(0);
  }
}

/**
 * PBKDF2-HMAC-SHA256 (RFC 8018), native and off the JS thread, byte-identical
 * to @noble/hashes `pbkdf2(sha256, ...)`. Only legacy v1/v2 backups use it
 * (100k / 600k iterations); on Hermes the JavaScript loop froze the UI.
 */
export async function pbkdf2Sha256(
  password: Uint8Array,
  salt: Uint8Array,
  iterations: number,
  dkLen: number,
): Promise<Uint8Array> {
  checkArrayTypes(password, salt);
  if (!inRange(dkLen, [1, 64])) throw new Error('pbkdf2Sha256: dkLen must be 1..64');
  if (!inRange(iterations, [1, 10_000_000])) throw new Error('pbkdf2Sha256: iterations must be 1..10000000');
  if (password.length > 65536) throw new Error('pbkdf2Sha256: password too long');
  if (salt.length > 1024) throw new Error('pbkdf2Sha256: salt too long');
  const bytes = await AegisSodium.pbkdf2Sha256(password, salt, iterations, dkLen);
  try {
    if (!Array.isArray(bytes) || bytes.length !== dkLen) throw new Error('aegis-sodium: pbkdf2Sha256 failed');
    return Uint8Array.from(bytes);
  } finally {
    if (Array.isArray(bytes)) bytes.fill(0);
  }
}

const MLKEM_PK = 1184;
const MLKEM_SK = 2400;
const MLKEM_CT = 1088;
const MLKEM_SS = 32;
const MLKEM_SEED = 64;
/** Offset of ek inside a FIPS 203 dk: dk_PKE (384 * k bytes, k = 3) || ek || H(ek) || z. */
const MLKEM_EK_OFFSET = 1152;

export interface MlKemKeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/**
 * ML-KEM-768 (FIPS 203) on native libsodium, with the @noble/post-quantum API
 * the app used before and the same bytes: same seed -> key pair, same 2400-byte
 * secret key, same ciphertexts and shared secrets, same implicit rejection — so
 * stored PQ prekeys and ratchet states keep working (pinned by the C core's
 * differential test). Wrong lengths throw; so does a public key that fails
 * FIPS 203's encapsulation-key check or a secret key that fails its hash check,
 * as with @noble.
 */
export const ml_kem768 = {
  keygen(seed?: Uint8Array): MlKemKeyPair {
    const publicKey = new Uint8Array(MLKEM_PK);
    const secretKey = new Uint8Array(MLKEM_SK);
    if (seed === undefined) {
      must(AegisSodium.mlkem768Keypair(publicKey, secretKey), 'mlkem768 keygen');
    } else {
      checkArrayTypes(seed);
      if (seed.length !== MLKEM_SEED) throw new Error('ml_kem768.keygen: seed must be 64 bytes');
      must(AegisSodium.mlkem768SeedKeypair(publicKey, secretKey, seed), 'mlkem768 keygen');
    }
    return { publicKey, secretKey };
  },

  encapsulate(publicKey: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array } {
    checkArrayTypes(publicKey);
    if (publicKey.length !== MLKEM_PK) throw new Error('ml_kem768.encapsulate: bad public key size');
    const cipherText = new Uint8Array(MLKEM_CT);
    const sharedSecret = new Uint8Array(MLKEM_SS);
    must(AegisSodium.mlkem768Enc(cipherText, sharedSecret, publicKey), 'mlkem768 encapsulate');
    return { cipherText, sharedSecret };
  },

  decapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array {
    checkArrayTypes(cipherText, secretKey);
    if (cipherText.length !== MLKEM_CT) throw new Error('ml_kem768.decapsulate: bad ciphertext size');
    if (secretKey.length !== MLKEM_SK) throw new Error('ml_kem768.decapsulate: bad secret key size');
    const sharedSecret = new Uint8Array(MLKEM_SS);
    must(AegisSodium.mlkem768Dec(sharedSecret, cipherText, secretKey), 'mlkem768 decapsulate');
    return sharedSecret;
  },

  /** The public key embedded in a secret key (a copy). */
  getPublicKey(secretKey: Uint8Array): Uint8Array {
    checkArrayTypes(secretKey);
    if (secretKey.length !== MLKEM_SK) throw new Error('ml_kem768.getPublicKey: bad secret key size');
    return secretKey.slice(MLKEM_EK_OFFSET, MLKEM_EK_OFFSET + MLKEM_PK);
  },
};

/** Highest proof-of-work difficulty the native miner accepts (the relay asks for 12-18). */
export const POW_DIFFICULTY_MAX = 32;
const POW_CHALLENGE_MAX = 512;

/**
 * The relay's proof-of-work, mined natively off the JS thread: resolves to the
 * first nonce "00000000", "00000001", ... (8 lowercase hex digits) such that
 * SHA-256(utf8(nonce + challenge)) has `difficulty` leading zero bits. The same
 * nonce the JavaScript miner found, in a fraction of the time: on Hermes (no
 * JIT) each of the ~260k hashes of a registration cost microseconds of JS.
 */
export async function powSha256(challenge: Uint8Array, difficulty: number): Promise<string> {
  checkArrayTypes(challenge);
  if (challenge.length < 1 || challenge.length > POW_CHALLENGE_MAX) {
    throw new Error('powSha256: challenge must be 1..512 bytes');
  }
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > POW_DIFFICULTY_MAX) {
    throw new Error('powSha256: difficulty must be 0..32');
  }
  const nonce = await AegisSodium.powSha256(challenge, difficulty);
  if (typeof nonce !== 'string' || !/^[0-9a-f]{8}$/.test(nonce)) throw new Error('aegis-sodium: powSha256 failed');
  return nonce;
}
