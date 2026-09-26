/**
 * Jest stand-in for the C key vault (`../cpp/aegis_vault.c`, F-1b). Same
 * contract: the same blob format ("AV" | 2 | type | nonce | secretbox(type |
 * slotlen | slot | key)), the same return codes, slot binding, release and
 * lock, and the sealed ratchet states of phase 3 (`nodeRatchet.ts`). The
 * "Keychain/Keystore" is an in-memory map that survives lock/unlock (like the
 * OS store survives app restarts) and is cleared by vaultDestroyProfile.
 *
 * The shipped C vault is tested against TweetNaCl/@noble by
 * `../test/differential.mjs`.
 */
import sodium from 'sodium-native';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { sha3_256 } from '@noble/hashes/sha3.js';
import type { AegisSodiumNative } from '../index';
import { makeNodeRatchet, type RatchetMethods } from './nodeRatchet';

const OK = 0;
const EVERIFY = 1;
const EBADLEN = -1;
const EFAIL = -2;
const ENOKEY = -3;

const X25519 = 1;
const ED25519 = 2;
const MLKEM768 = 3;
const SECRET32 = 4;
const X25519_PREKEY = 5;
const KEY_LEN: Record<number, number> = { [X25519]: 32, [ED25519]: 64, [MLKEM768]: 2400, [SECRET32]: 32, [X25519_PREKEY]: 32 };
const PUB_LEN: Record<number, number> = { [X25519]: 32, [ED25519]: 32, [MLKEM768]: 1184, [SECRET32]: 0, [X25519_PREKEY]: 32 };
const HEADER = 28;
const VERSION = 2;
// Blob v2: "AV" | 2 | type | nonce | secretbox(type | slotlen | slot | key), as in aegis_vault.c.
const blobLen = (slotLen: number, keyLen: number): number => HEADER + 16 + 2 + slotLen + keyLen;
/** A key of type `have` serves an operation wanting `want` (an X25519 prekey does every X25519 operation). */
const typeOk = (have: number, want: number): boolean => have === want || (want === X25519 && have === X25519_PREKEY);

type Prims = Pick<AegisSodiumNative, 'signDetached' | 'scalarmult' | 'boxEasy' | 'boxOpenEasy' | 'mlkem768Dec'>;
export type VaultMethods = Pick<
  AegisSodiumNative,
  | 'vaultUnlock' | 'vaultDestroyProfile' | 'vaultLock' | 'vaultLockAll' | 'vaultGenerate' | 'vaultImport'
  | 'vaultLoad' | 'vaultDeriveEd25519' | 'vaultCopy' | 'vaultRelease' | 'vaultSign' | 'vaultScalarmult' | 'vaultBox'
  | 'vaultBoxOpen' | 'vaultMlkem768Dec' | 'vaultExport' | 'vaultLiveKeys'
>;

const isBytes = (b: unknown): b is Uint8Array => b instanceof Uint8Array;
const key = (slot: Uint8Array): string => Buffer.from(slot).toString('hex');

/** The vault plus a synchronous unlock for test setup (the native one is async only because it reads the OS keystore). */
export type NodeVault = VaultMethods &
  RatchetMethods & {
    unlockNow(slot: string): void;
    /** TEST ONLY: the raw state inside a sealed ratchet blob (`nodeRatchet.ts`). */
    ratchetPeek: ReturnType<typeof makeNodeRatchet>['peek'];
  };

export function makeNodeVault(p: Prims): NodeVault {
  const keystore = new Map<string, Uint8Array>(); // slot → KEK (the "OS store")
  const unlocked = new Map<string, Uint8Array>(); // slot → KEK in the vault
  const keys = new Map<number, { type: number; slot: string; secret: Uint8Array }>();
  let next = 1;

  const readHandle = (h: Uint8Array): number | null =>
    isBytes(h) && h.length === 4 ? new DataView(h.buffer, h.byteOffset, 4).getUint32(0, true) : null;
  const writeHandle = (out: Uint8Array, h: number): void => new DataView(out.buffer, out.byteOffset, 4).setUint32(0, h, true);
  const slotOk = (slot: Uint8Array): boolean => isBytes(slot) && slot.length >= 1 && slot.length <= 64;
  const slotName = (s: string): Uint8Array => new TextEncoder().encode(s);

  function publicOf(type: number, secret: Uint8Array, pub: Uint8Array): number {
    const want = PUB_LEN[type];
    if (want === 0 && pub.length === 0) return OK;
    if (pub.length !== want) return EBADLEN;
    if (type === X25519 || type === X25519_PREKEY) sodium.crypto_scalarmult_base(pub, secret);
    else if (type === ED25519) pub.set(secret.subarray(32, 64));
    else if (type === MLKEM768) pub.set(secret.subarray(1152, 1152 + 1184));
    else return EBADLEN;
    return OK;
  }

  function wrap(blob: Uint8Array, slot: Uint8Array, type: number, secret: Uint8Array): number {
    if (blob.length !== blobLen(slot.length, secret.length)) return EBADLEN;
    const plain = new Uint8Array(2 + slot.length + secret.length);
    plain[0] = type;
    plain[1] = slot.length;
    plain.set(slot, 2);
    plain.set(secret, 2 + slot.length);
    blob.set([0x41, 0x56, VERSION, type]);
    const nonce = blob.subarray(4, 28);
    sodium.randombytes_buf(nonce);
    sodium.crypto_secretbox_easy(blob.subarray(HEADER), plain, nonce, unlocked.get(key(slot))!);
    plain.fill(0);
    return OK;
  }

  function addKey(handle: Uint8Array, blob: Uint8Array, pub: Uint8Array, slot: Uint8Array, type: number, secret: Uint8Array): number {
    let rc = publicOf(type, secret, pub);
    if (rc === OK) rc = wrap(blob, slot, type, secret);
    if (rc !== OK) return rc;
    const h = next++;
    keys.set(h, { type, slot: key(slot), secret: Uint8Array.from(secret) });
    writeHandle(handle, h);
    return OK;
  }

  function withKey(h: Uint8Array, type: number, fn: (secret: Uint8Array) => number): number {
    const id = readHandle(h);
    if (id === null) return EBADLEN;
    const k = keys.get(id);
    return k && typeOk(k.type, type) ? fn(k.secret) : ENOKEY;
  }

  /** Export: the exact declared type (a platform's export policy keys off it). */
  function withExactKey(h: Uint8Array, type: number, fn: (secret: Uint8Array) => number): number {
    const id = readHandle(h);
    if (id === null) return EBADLEN;
    const k = keys.get(id);
    return k && k.type === type ? fn(k.secret) : ENOKEY;
  }

  function lockSlot(k: string): void {
    for (const [h, v] of keys) if (v.slot === k) { v.secret.fill(0); keys.delete(h); }
    unlocked.get(k)?.fill(0);
    unlocked.delete(k);
  }

  function unlockNow(slot: string): void {
    const s = slotName(slot);
    let kek = keystore.get(key(s));
    if (!kek) {
      kek = new Uint8Array(32);
      sodium.randombytes_buf(kek);
      keystore.set(key(s), kek);
    }
    if (!unlocked.has(key(s))) unlocked.set(key(s), Uint8Array.from(kek));
  }

  // Sealed ratchet states (F-1b phase 3): blobs of type 6, a fixed-size state
  // instead of a key. Never loadable as a key (KEY_LEN has no type 6).
  const ratchet = makeNodeRatchet({
    blobLen: (slot, len) => blobLen(slot.length, len),
    slotOk,
    seal: (blob, slot, type, plain) => {
      if (!unlocked.has(key(slot))) return ENOKEY;
      return wrap(blob, slot, type, plain);
    },
    open: (slot, type, blob) => {
      const kek = unlocked.get(key(slot));
      if (!kek) return ENOKEY;
      if (blob.length < HEADER + 18 || blob[0] !== 0x41 || blob[1] !== 0x56 || blob[2] !== VERSION || blob[3] !== type) return EBADLEN;
      const plain = new Uint8Array(blob.length - HEADER - 16);
      if (!sodium.crypto_secretbox_open_easy(plain, blob.subarray(HEADER), blob.subarray(4, 28), kek)) return EVERIFY;
      if (plain[0] !== type || plain[1] !== slot.length || !Buffer.from(plain.subarray(2, 2 + slot.length)).equals(Buffer.from(slot))) {
        plain.fill(0);
        return EVERIFY;
      }
      const out = plain.slice(2 + slot.length);
      plain.fill(0);
      return out;
    },
    secretOf: (h, type, slot) => {
      const id = readHandle(h);
      if (id === null) return EBADLEN;
      const k = keys.get(id);
      return k && k.type === type && k.slot === key(slot) ? Uint8Array.from(k.secret) : ENOKEY;
    },
  });

  return {
    ratchetInitAlice: ratchet.ratchetInitAlice,
    ratchetInitBob: ratchet.ratchetInitBob,
    ratchetEncrypt: ratchet.ratchetEncrypt,
    ratchetDecrypt: ratchet.ratchetDecrypt,
    ratchetTrim: ratchet.ratchetTrim,
    ratchetImport: ratchet.ratchetImport,
    ratchetPeek: ratchet.peek,
    vaultUnlock: async (slot) => unlockNow(slot),
    unlockNow,
    vaultDestroyProfile: async (slot) => {
      const k = key(slotName(slot));
      lockSlot(k);
      keystore.delete(k);
    },
    vaultLock: (slot) => { lockSlot(key(slotName(slot))); return OK; },
    vaultLockAll: () => { for (const k of [...unlocked.keys()]) lockSlot(k); return OK; },
    vaultGenerate: (handle, blob, pub, slot, type) => {
      const len = KEY_LEN[type];
      if (!len || !slotOk(slot) || !isBytes(handle) || handle.length !== 4) return EBADLEN;
      if (!unlocked.has(key(slot))) return ENOKEY;
      let secret: Uint8Array;
      if (type === ED25519) {
        const pk = new Uint8Array(32);
        secret = new Uint8Array(64);
        sodium.crypto_sign_keypair(pk, secret);
      } else if (type === MLKEM768) {
        secret = ml_kem768.keygen().secretKey;
      } else {
        secret = new Uint8Array(32);
        sodium.randombytes_buf(secret);
      }
      const rc = addKey(handle, blob, pub, slot, type, secret);
      secret.fill(0);
      return rc;
    },
    vaultImport: (handle, blob, pub, slot, type, raw) => {
      const len = KEY_LEN[type];
      if (!len || !isBytes(raw) || raw.length !== len || !slotOk(slot) || !isBytes(handle) || handle.length !== 4) return EBADLEN;
      if (type === ED25519) {
        const pk = new Uint8Array(32);
        const sk = new Uint8Array(64);
        sodium.crypto_sign_seed_keypair(pk, sk, raw.subarray(0, 32));
        if (!Buffer.from(pk).equals(Buffer.from(raw.subarray(32)))) return EFAIL;
      }
      if (type === MLKEM768) {
        const h = sha3_256(raw.subarray(1152, 1152 + 1184));
        if (!Buffer.from(h).equals(Buffer.from(raw.subarray(1152 + 1184, 1152 + 1184 + 32)))) return EFAIL;
      }
      if (!unlocked.has(key(slot))) return ENOKEY;
      return addKey(handle, blob, pub, slot, type, raw);
    },
    vaultLoad: (handle, typeOut, pub, slot, blob) => {
      if (!isBytes(blob) || !slotOk(slot) || !isBytes(handle) || handle.length !== 4 || !isBytes(typeOut) || typeOut.length !== 4) return EBADLEN;
      if (blob.length < HEADER + 18 || blob[0] !== 0x41 || blob[1] !== 0x56 || blob[2] !== VERSION) return EBADLEN;
      const type = blob[3];
      const len = KEY_LEN[type];
      if (!len || blob.length !== blobLen(slot.length, len)) return EBADLEN;
      const kek = unlocked.get(key(slot));
      if (!kek) return ENOKEY;
      const plain = new Uint8Array(blob.length - HEADER - 16);
      if (!sodium.crypto_secretbox_open_easy(plain, blob.subarray(HEADER), blob.subarray(4, 28), kek)) return EVERIFY;
      if (plain[0] !== type || plain[1] !== slot.length || !Buffer.from(plain.subarray(2, 2 + slot.length)).equals(Buffer.from(slot))) return EVERIFY;
      const secret = plain.subarray(2 + slot.length);
      const rc = publicOf(type, secret, pub);
      if (rc === OK) {
        const h = next++;
        keys.set(h, { type, slot: key(slot), secret: Uint8Array.from(secret) });
        writeHandle(handle, h);
        new DataView(typeOut.buffer, typeOut.byteOffset, 4).setInt32(0, type, true);
      }
      plain.fill(0);
      return rc;
    },
    vaultDeriveEd25519: (handle, blob, pub, xhandle) => {
      const id = readHandle(xhandle);
      if (id === null || !isBytes(handle) || handle.length !== 4) return EBADLEN;
      const x = keys.get(id);
      if (!x || x.type !== X25519) return ENOKEY;
      const pk = new Uint8Array(32);
      const sk = new Uint8Array(64);
      sodium.crypto_sign_seed_keypair(pk, sk, x.secret);
      const slot = Uint8Array.from(Buffer.from(x.slot, 'hex'));
      const rc = addKey(handle, blob, pub, slot, ED25519, sk);
      sk.fill(0);
      return rc;
    },
    vaultCopy: (handle, blob, src, slot) => {
      const id = readHandle(src);
      if (id === null || !slotOk(slot) || !isBytes(handle) || handle.length !== 4) return EBADLEN;
      const k = keys.get(id);
      if (!k || !unlocked.has(key(slot))) return ENOKEY;
      return addKey(handle, blob, new Uint8Array(PUB_LEN[k.type]), slot, k.type, k.secret);
    },
    vaultRelease: (handle) => {
      const id = readHandle(handle);
      if (id === null) return EBADLEN;
      const k = keys.get(id);
      if (!k) return ENOKEY;
      k.secret.fill(0);
      keys.delete(id);
      return OK;
    },
    vaultSign: (handle, sig, m) => withKey(handle, ED25519, (sk) => p.signDetached(sig, m, sk)),
    vaultScalarmult: (handle, q, pt) => withKey(handle, X25519, (sk) => p.scalarmult(q, sk, pt)),
    vaultBox: (handle, c, m, n, pk) => withKey(handle, X25519, (sk) => p.boxEasy(c, m, n, pk, sk)),
    vaultBoxOpen: (handle, m, c, n, pk) => withKey(handle, X25519, (sk) => p.boxOpenEasy(m, c, n, pk, sk)),
    vaultMlkem768Dec: (handle, ss, ct) => withKey(handle, MLKEM768, (sk) => p.mlkem768Dec(ss, ct, sk)),
    vaultExport: (handle, type, out) => {
      const len = KEY_LEN[type];
      if (!len || !isBytes(out) || out.length !== len) return EBADLEN;
      return withExactKey(handle, type, (sk) => { out.set(sk); return OK; });
    },
    vaultLiveKeys: () => keys.size,
  };
}
