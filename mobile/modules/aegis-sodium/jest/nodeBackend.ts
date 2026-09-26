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
 * Argon2id: libsodium's crypto_pwhash for 16-byte salts; @noble/hashes for the
 * rest (sodium-native exposes no other salt length, and node:crypto has no
 * Argon2 before Node 24.7). The proof-of-work miner is the C core's loop over
 * libsodium's SHA-256. ML-KEM-768: @noble/post-quantum (sodium-native has no
 * ML-KEM), with the C core's lengths and return codes; the C core is diffed
 * against it byte for byte.
 *
 * The shipped C core itself is tested against TweetNaCl/@noble by
 * `../test/differential.mjs` (CI job `aegis-sodium-native`).
 */
import { createHmac, pbkdf2Sync } from 'node:crypto';
import { argon2id } from '@noble/hashes/argon2.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import sodium from 'sodium-native';
import type { AegisSodiumNative } from '../index';
import { makeNodeVault, type NodeVault } from './nodeVault';

const OK = 0;
const EVERIFY = 1;
const EBADLEN = -1;
const EFAIL = -2;
export { OK as AEGIS_OK, EVERIFY as AEGIS_EVERIFY, EBADLEN as AEGIS_EBADLEN, EFAIL as AEGIS_EFAIL };
export const AEGIS_ENOKEY = -3;

const MAC = 16;
const NONCE = 24;
const KEY = 32;
const SIGN_SK = 64;
const SIG = 64;
const HKDF_MAX = 255 * 32;
const MLKEM_PK = 1184;
const MLKEM_SK = 2400;
const MLKEM_CT = 1088;

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

const base: Omit<AegisSodiumNative, keyof NodeVault> = {
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
  // Async like the device binding; rejects where it would.
  argon2id: async (pwd, salt, t, mKib, outLen) => {
    const ok =
      isBytes(pwd) && isBytes(salt) && pwd.length <= 65536 && salt.length >= 8 && salt.length <= 64 &&
      Number.isInteger(outLen) && outLen >= 16 && outLen <= 64 &&
      Number.isInteger(t) && t >= 1 && t <= 16 && Number.isInteger(mKib) && mKib >= 8 && mKib <= 262144;
    if (!ok) throw new Error(`aegis_argon2id failed: ${EBADLEN}`);
    // A 16-byte salt (the app-lock PIN's per-install salt) goes to real libsodium:
    // crypto_pwhash with Argon2id v1.3, one lane, is the same function as the C
    // core's argon2id_hash_raw. Other salt lengths (backup: 32 B, duress: a domain
    // string) fall back to @noble's argon2id.
    if (salt.length === sodium.crypto_pwhash_SALTBYTES) {
      const out = new Uint8Array(outLen);
      sodium.crypto_pwhash(out, pwd, salt, t, mKib * 1024, sodium.crypto_pwhash_ALG_ARGON2ID13);
      return Array.from(out);
    }
    return Array.from(argon2id(pwd, salt, { t, m: mKib, p: 1, dkLen: outLen }));
  },
  pbkdf2Sha256: async (pwd, salt, iterations, outLen) => {
    const ok =
      isBytes(pwd) && isBytes(salt) && pwd.length <= 65536 && salt.length <= 1024 &&
      Number.isInteger(outLen) && outLen >= 1 && outLen <= 64 &&
      Number.isInteger(iterations) && iterations >= 1 && iterations <= 10_000_000;
    if (!ok) throw new Error(`aegis_pbkdf2_sha256 failed: ${EBADLEN}`);
    return Array.from(pbkdf2Sync(pwd, salt, iterations, outLen, 'sha256'));
  },
  mlkem768Keypair: (pk, sk) => {
    if (!len([pk, MLKEM_PK], [sk, MLKEM_SK])) return EBADLEN;
    const k = ml_kem768.keygen();
    pk.set(k.publicKey);
    sk.set(k.secretKey);
    return OK;
  },
  mlkem768SeedKeypair: (pk, sk, seed) => {
    if (!len([pk, MLKEM_PK], [sk, MLKEM_SK], [seed, 64])) return EBADLEN;
    const k = ml_kem768.keygen(seed);
    pk.set(k.publicKey);
    sk.set(k.secretKey);
    return OK;
  },
  mlkem768Enc: (ct, ss, pk) => {
    if (!len([ct, MLKEM_CT], [ss, 32], [pk, MLKEM_PK])) return EBADLEN;
    try {
      const e = ml_kem768.encapsulate(pk);
      ct.set(e.cipherText);
      ss.set(e.sharedSecret);
      return OK;
    } catch {
      return EFAIL; // FIPS 203 encapsulation-key check, as in the C core
    }
  },
  mlkem768Dec: (ss, ct, sk) => {
    if (!len([ss, 32], [ct, MLKEM_CT], [sk, MLKEM_SK])) return EBADLEN;
    try {
      ss.set(ml_kem768.decapsulate(ct, sk));
      return OK;
    } catch {
      return EFAIL; // FIPS 203 decapsulation-key (hash) check, as in the C core
    }
  },
  // The C core's miner, step for step: nonces "00000000", "00000001", ... hashed
  // in front of the challenge with libsodium's SHA-256.
  powSha256: async (challenge, difficulty) => {
    const ok =
      isBytes(challenge) && challenge.length >= 1 && challenge.length <= 512 &&
      Number.isInteger(difficulty) && difficulty >= 0 && difficulty <= 32;
    if (!ok) throw new Error(`aegis_pow_sha256 failed: ${EBADLEN}`);
    const buf = new Uint8Array(8 + challenge.length);
    buf.set(challenge, 8);
    const digest = new Uint8Array(32);
    for (let i = 0; i <= 0xffffffff; i++) {
      const nonce = i.toString(16).padStart(8, '0');
      for (let k = 0; k < 8; k++) buf[k] = nonce.charCodeAt(k);
      sodium.crypto_hash_sha256(digest, buf);
      if (leadingZeroBits(digest, difficulty)) return nonce;
    }
    throw new Error(`aegis_pow_sha256 failed: ${EFAIL}`);
  },
};

function leadingZeroBits(d: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (d[i] !== 0) return false;
  return bits % 8 === 0 || (d[full] & (0xff << (8 - (bits % 8)))) === 0;
}

// One vault per test file, like the native module's process-wide state: a
// jest.resetModules() re-evaluates this file but must not forget the unlocked
// profiles or the live keys that identities already hold handles to.
const g = globalThis as { __aegisNodeVault?: NodeVault };
const vaultImpl: NodeVault = (g.__aegisNodeVault ??= makeNodeVault(base));

const nodeBackend: AegisSodiumNative = { ...base, ...vaultImpl };

/** Test setup: unlock a profile synchronously (see jest/vaultSetup.ts). */
export const unlockVaultNow = (slot: string): void => vaultImpl.unlockNow(slot);

export default nodeBackend;
