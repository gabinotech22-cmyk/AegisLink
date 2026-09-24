/**
 * TweetNaCl-compatible NaCl API implemented on native libsodium (sodium-native).
 *
 * libsodium's crypto_box_easy / crypto_secretbox_easy / crypto_scalarmult /
 * crypto_sign are byte-compatible with NaCl, so this is a drop-in backend: every
 * output is identical to TweetNaCl's (pinned by `f1-golden.test.ts`). The
 * wrapper also reproduces TweetNaCl's contract at the edges, so callers see no
 * behavioral change:
 *   - wrong-length keys/nonces/signatures THROW with TweetNaCl's messages
 *     (`bad nonce size`, `bad public key size`, …), in the same check order;
 *   - a non-Uint8Array argument throws `TypeError('unexpected type, use Uint8Array')`;
 *   - `open` returns null on MAC failure or a too-short ciphertext;
 *   - results are plain `Uint8Array`s (never `Buffer`: its JSON form differs).
 *
 * Deliberate, stricter differences (libsodium's, kept — fail closed):
 *   - `scalarMult` THROWS when the shared point is all-zero (low-order peer
 *     key). TweetNaCl returned zeros; callers already rejected that
 *     (`assertNonZeroDH`), now the primitive does too.
 *   - `sign.detached.verify` rejects small-order public keys and non-canonical
 *     encodings. TweetNaCl accepted e.g. (R = identity, S = 0) under the
 *     identity key as a valid signature of EVERY message.
 *
 * Byte-identical twins (kept in sync by `desktop/src/main/crypto/__tests__/
 * sodium-native.differential.test.ts`): `server/src/crypto/sodium/native.ts`,
 * `desktop/src/main/crypto/sodium/native.ts`.
 * Reference: Session and SimpleX run native libsodium (golden rule #12).
 */
import sodium from 'sodium-native';

const SECRETBOX_KEY = 32;
const NONCE = 24;
const MAC = 16;
const BOX_PUBLIC = 32;
const BOX_SECRET = 32;
const SCALAR = 32;
const SIGN_PUBLIC = 32;
const SIGN_SECRET = 64;
const SIGN_SEED = 32;
const SIGNATURE = 64;

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

function checkArrayTypes(...args: unknown[]): void {
  for (const a of args) {
    if (!(a instanceof Uint8Array)) throw new TypeError('unexpected type, use Uint8Array');
  }
}

function checkSecretboxLengths(key: Uint8Array, nonce: Uint8Array): void {
  if (key.length !== SECRETBOX_KEY) throw new Error('bad key size');
  if (nonce.length !== NONCE) throw new Error('bad nonce size');
}

function checkBoxLengths(publicKey: Uint8Array, secretKey: Uint8Array): void {
  if (publicKey.length !== BOX_PUBLIC) throw new Error('bad public key size');
  if (secretKey.length !== BOX_SECRET) throw new Error('bad secret key size');
}

export function randomBytes(n: number): Uint8Array {
  const out = new Uint8Array(n);
  if (n > 0) sodium.randombytes_buf(out);
  return out;
}

/** Constant-time equality; false for empty or different-length inputs (TweetNaCl semantics). */
export function verify(x: Uint8Array, y: Uint8Array): boolean {
  checkArrayTypes(x, y);
  if (x.length === 0 || y.length === 0) return false;
  if (x.length !== y.length) return false;
  return sodium.sodium_memcmp(x, y);
}

export function secretbox(msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  checkArrayTypes(msg, nonce, key);
  checkSecretboxLengths(key, nonce);
  const c = new Uint8Array(msg.length + MAC);
  sodium.crypto_secretbox_easy(c, msg, nonce, key);
  return c;
}

export function secretboxOpen(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null {
  checkArrayTypes(box, nonce, key);
  checkSecretboxLengths(key, nonce);
  if (box.length < MAC) return null;
  const m = new Uint8Array(box.length - MAC);
  return sodium.crypto_secretbox_open_easy(m, box, nonce, key) ? m : null;
}

export function box(msg: Uint8Array, nonce: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  checkArrayTypes(msg, nonce, publicKey, secretKey);
  checkBoxLengths(publicKey, secretKey);
  if (nonce.length !== NONCE) throw new Error('bad nonce size');
  const c = new Uint8Array(msg.length + MAC);
  sodium.crypto_box_easy(c, msg, nonce, publicKey, secretKey);
  return c;
}

export function boxOpen(
  msg: Uint8Array,
  nonce: Uint8Array,
  publicKey: Uint8Array,
  secretKey: Uint8Array,
): Uint8Array | null {
  checkArrayTypes(msg, nonce, publicKey, secretKey);
  checkBoxLengths(publicKey, secretKey);
  if (nonce.length !== NONCE) throw new Error('bad nonce size');
  if (msg.length < MAC) return null;
  const m = new Uint8Array(msg.length - MAC);
  return sodium.crypto_box_open_easy(m, msg, nonce, publicKey, secretKey) ? m : null;
}

export function boxKeyPair(): KeyPair {
  const publicKey = new Uint8Array(BOX_PUBLIC);
  const secretKey = new Uint8Array(BOX_SECRET);
  sodium.crypto_box_keypair(publicKey, secretKey);
  return { publicKey, secretKey };
}

export function boxKeyPairFromSecretKey(secretKey: Uint8Array): KeyPair {
  checkArrayTypes(secretKey);
  if (secretKey.length !== BOX_SECRET) throw new Error('bad secret key size');
  const publicKey = new Uint8Array(BOX_PUBLIC);
  sodium.crypto_scalarmult_base(publicKey, secretKey);
  return { publicKey, secretKey: new Uint8Array(secretKey) };
}

export function scalarMult(n: Uint8Array, p: Uint8Array): Uint8Array {
  checkArrayTypes(n, p);
  if (n.length !== SCALAR) throw new Error('bad n size');
  if (p.length !== SCALAR) throw new Error('bad p size');
  const q = new Uint8Array(SCALAR);
  try {
    sodium.crypto_scalarmult(q, n, p);
  } catch {
    throw new Error('scalarMult: low-order point (all-zero shared secret)');
  }
  return q;
}

export function scalarMultBase(n: Uint8Array): Uint8Array {
  checkArrayTypes(n);
  if (n.length !== SCALAR) throw new Error('bad n size');
  const q = new Uint8Array(SCALAR);
  sodium.crypto_scalarmult_base(q, n);
  return q;
}

export function signDetached(msg: Uint8Array, secretKey: Uint8Array): Uint8Array {
  checkArrayTypes(msg, secretKey);
  if (secretKey.length !== SIGN_SECRET) throw new Error('bad secret key size');
  const sig = new Uint8Array(SIGNATURE);
  sodium.crypto_sign_detached(sig, msg, secretKey);
  return sig;
}

export function signVerifyDetached(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean {
  checkArrayTypes(msg, sig, publicKey);
  if (sig.length !== SIGNATURE) throw new Error('bad signature size');
  if (publicKey.length !== SIGN_PUBLIC) throw new Error('bad public key size');
  return sodium.crypto_sign_verify_detached(sig, msg, publicKey);
}

export function signKeyPair(): KeyPair {
  const publicKey = new Uint8Array(SIGN_PUBLIC);
  const secretKey = new Uint8Array(SIGN_SECRET);
  sodium.crypto_sign_keypair(publicKey, secretKey);
  return { publicKey, secretKey };
}

export function signKeyPairFromSeed(seed: Uint8Array): KeyPair {
  checkArrayTypes(seed);
  if (seed.length !== SIGN_SEED) throw new Error('bad seed size');
  const publicKey = new Uint8Array(SIGN_PUBLIC);
  const secretKey = new Uint8Array(SIGN_SECRET);
  sodium.crypto_sign_seed_keypair(publicKey, secretKey, seed);
  return { publicKey, secretKey };
}

export const LENGTHS = {
  secretboxKey: SECRETBOX_KEY,
  nonce: NONCE,
  overhead: MAC,
  boxPublicKey: BOX_PUBLIC,
  boxSecretKey: BOX_SECRET,
  signPublicKey: SIGN_PUBLIC,
  signSecretKey: SIGN_SECRET,
  signSeed: SIGN_SEED,
  signature: SIGNATURE,
} as const;
