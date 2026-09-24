/**
 * Jest stand-in for the aegis-sodium native module (Jest runs in Node, where
 * the app's JNI/Swift binding cannot load). Mapped in by `moduleNameMapper`
 * in `mobile/jest.config.js` and `server/jest.config.cjs`.
 *
 * It runs REAL libsodium (sodium-native, the relay's and desktop's backend) and
 * reproduces the C core's contract (`../cpp/aegis_sodium.c`): the same length
 * validation and the same return codes, so the facade's error handling is
 * exercised as on a device. `crypto_box_beforenm` and HMAC/HKDF, which
 * sodium-native does not expose, come from X25519 + Salsa20 (HSalsa20, as in
 * `desktop/src/main/crypto/sodium/boxBefore.ts`) and node:crypto HMAC.
 *
 * The shipped C core itself is tested against TweetNaCl/@noble by
 * `../test/differential.mjs` (CI job `aegis-sodium-native`).
 */
import { createHmac } from 'node:crypto';
import sodium from 'sodium-native';
import type { AegisSodiumNative } from '../index';

const OK = 0;
const EVERIFY = 1;
const EBADLEN = -1;
const EFAIL = -2;
export { OK as AEGIS_OK, EVERIFY as AEGIS_EVERIFY, EBADLEN as AEGIS_EBADLEN, EFAIL as AEGIS_EFAIL };

const MAC = 16;
const NONCE = 24;
const KEY = 32;
const SIGN_SK = 64;
const SIG = 64;
const HKDF_MAX = 255 * 32;

// "expand 32-byte k", little-endian words (HSalsa20 = Salsa20 core without feed-forward).
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574];

const isBytes = (b: unknown): b is Uint8Array => b instanceof Uint8Array;
const len = (...pairs: Array<[Uint8Array, number]>): boolean => pairs.every(([b, n]) => isBytes(b) && b.length === n);

const hmac = (k: Uint8Array, ...parts: Uint8Array[]): Uint8Array => {
  const h = createHmac('sha256', k);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
};

/** RFC 5869 over HMAC (an empty salt is HashLen zero bytes: HMAC zero-pads the key). */
function hkdf(out: Uint8Array, ikm: Uint8Array, salt: Uint8Array, info: Uint8Array): void {
  const prk = hmac(salt, ikm);
  let t: Uint8Array = new Uint8Array(0);
  for (let i = 1, off = 0; off < out.length; i++) {
    t = hmac(prk, t, info, new Uint8Array([i]));
    out.set(t.subarray(0, Math.min(t.length, out.length - off)), off);
    off += t.length;
  }
  prk.fill(0);
  t.fill(0);
}

function hsalsa20Zero(key: Uint8Array): Uint8Array {
  const block = new Uint8Array(64);
  sodium.crypto_stream_salsa20(block, new Uint8Array(8), key);
  const inWords = new DataView(block.buffer);
  const out = new Uint8Array(32);
  const outWords = new DataView(out.buffer);
  [0, 5, 10, 15].forEach((w, i) => outWords.setUint32(i * 4, (inWords.getUint32(w * 4, true) - SIGMA[i]) >>> 0, true));
  for (let i = 0; i < 4; i++) outWords.setUint32(16 + i * 4, inWords.getUint32((6 + i) * 4, true), true);
  block.fill(0);
  return out;
}

const nodeBackend: AegisSodiumNative = {
  init: () => OK,
  randombytes: (buf) => {
    if (!isBytes(buf)) return EBADLEN;
    if (buf.length > 0) sodium.randombytes_buf(buf);
    return OK;
  },
  memcmp: (a, b) => {
    if (!isBytes(a) || !isBytes(b) || a.length !== b.length) return EBADLEN;
    if (a.length === 0) return EVERIFY;
    return sodium.sodium_memcmp(a, b) ? OK : EVERIFY;
  },
  boxKeypair: (pk, sk) => {
    if (!len([pk, KEY], [sk, KEY])) return EBADLEN;
    sodium.crypto_box_keypair(pk, sk);
    return OK;
  },
  boxEasy: (c, m, n, pk, sk) => {
    if (!isBytes(m) || !len([c, m.length + MAC], [n, NONCE], [pk, KEY], [sk, KEY])) return EBADLEN;
    try {
      sodium.crypto_box_easy(c, m, n, pk, sk);
      return OK;
    } catch {
      return EFAIL;
    }
  },
  boxOpenEasy: (m, c, n, pk, sk) => {
    if (!isBytes(c) || c.length < MAC || !len([m, c.length - MAC], [n, NONCE], [pk, KEY], [sk, KEY])) return EBADLEN;
    return sodium.crypto_box_open_easy(m, c, n, pk, sk) ? OK : EVERIFY;
  },
  boxBeforenm: (k, pk, sk) => {
    if (!len([k, KEY], [pk, KEY], [sk, KEY])) return EBADLEN;
    const shared = new Uint8Array(KEY);
    try {
      sodium.crypto_scalarmult(shared, sk, pk);
    } catch {
      return EFAIL;
    }
    const derived = hsalsa20Zero(shared);
    k.set(derived);
    shared.fill(0);
    derived.fill(0);
    return OK;
  },
  secretboxEasy: (c, m, n, k) => {
    if (!isBytes(m) || !len([c, m.length + MAC], [n, NONCE], [k, KEY])) return EBADLEN;
    sodium.crypto_secretbox_easy(c, m, n, k);
    return OK;
  },
  secretboxOpenEasy: (m, c, n, k) => {
    if (!isBytes(c) || c.length < MAC || !len([m, c.length - MAC], [n, NONCE], [k, KEY])) return EBADLEN;
    return sodium.crypto_secretbox_open_easy(m, c, n, k) ? OK : EVERIFY;
  },
  scalarmult: (q, n, p) => {
    if (!len([q, KEY], [n, KEY], [p, KEY])) return EBADLEN;
    try {
      sodium.crypto_scalarmult(q, n, p);
      return OK;
    } catch {
      return EFAIL;
    }
  },
  scalarmultBase: (q, n) => {
    if (!len([q, KEY], [n, KEY])) return EBADLEN;
    sodium.crypto_scalarmult_base(q, n);
    return OK;
  },
  signKeypair: (pk, sk) => {
    if (!len([pk, KEY], [sk, SIGN_SK])) return EBADLEN;
    sodium.crypto_sign_keypair(pk, sk);
    return OK;
  },
  signSeedKeypair: (pk, sk, seed) => {
    if (!len([pk, KEY], [sk, SIGN_SK], [seed, KEY])) return EBADLEN;
    sodium.crypto_sign_seed_keypair(pk, sk, seed);
    return OK;
  },
  signDetached: (sig, m, sk) => {
    if (!isBytes(m) || !len([sig, SIG], [sk, SIGN_SK])) return EBADLEN;
    sodium.crypto_sign_detached(sig, m, sk);
    return OK;
  },
  signVerifyDetached: (sig, m, pk) => {
    if (!isBytes(m) || !len([sig, SIG], [pk, KEY])) return EBADLEN;
    return sodium.crypto_sign_verify_detached(sig, m, pk) ? OK : EVERIFY;
  },
  hmacsha256: (out, m, k) => {
    if (!isBytes(m) || !isBytes(k) || !len([out, 32])) return EBADLEN;
    out.set(hmac(k, m));
    return OK;
  },
  hkdfSha256: (out, ikm, salt, info) => {
    if (!isBytes(out) || !isBytes(ikm) || !isBytes(salt) || !isBytes(info)) return EBADLEN;
    if (out.length === 0 || out.length > HKDF_MAX) return EBADLEN;
    hkdf(out, ikm, salt, info);
    return OK;
  },
};

export default nodeBackend;
