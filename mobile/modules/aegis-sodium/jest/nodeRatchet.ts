/**
 * Jest stand-in for the C core's ratchet (`../cpp/aegis_ratchet.c`, F-1b
 * phase 3): the same calls, buffers and return codes. It runs the TypeScript
 * twin of the algorithm (`ratchetCore.ts`) on the state the vault seals as a
 * blob of type AEGIS_KEY_RATCHET; the C port is checked against that twin by
 * `../test/ratchet-interop.mjs`.
 */
import { createHmac, hkdfSync } from 'node:crypto';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import sodium from 'sodium-native';
import type { AegisSodiumNative } from '../index';
import {
  RATCHET_STATE_LEN,
  RATCHET_HEADER_LEN,
  RATCHET_INFO_LEN,
  decodeRatchetState,
  encodeRatchetState,
  infoOf,
  unpackRatchetHeader,
  type RawRatchetState,
} from '../ratchetState';
import * as core from './ratchetCore';

const { RC } = core;
export const RATCHET_TYPE = 6;

export type RatchetMethods = Pick<
  AegisSodiumNative,
  'ratchetInitAlice' | 'ratchetInitBob' | 'ratchetEncrypt' | 'ratchetDecrypt' | 'ratchetTrim' | 'ratchetImport'
>;

/** What the ratchet needs from the vault: sealing under the slot KEK and reading a key by handle. */
export interface RatchetVaultAccess {
  /** Seal `plain` as a blob of `type` for `slot` into `blob`; a return code. */
  seal(blob: Uint8Array, slot: Uint8Array, type: number, plain: Uint8Array): number;
  /** Open a blob of `type` for `slot`: its plaintext, or a return code. */
  open(slot: Uint8Array, type: number, blob: Uint8Array): Uint8Array | number;
  /** A copy of the secret of `handle` if it is of `type` and of `slot`, else a return code. */
  secretOf(handle: Uint8Array, type: number, slot: Uint8Array): Uint8Array | number;
  blobLen(slot: Uint8Array, len: number): number;
  slotOk(slot: Uint8Array): boolean;
}

export const nodePrims: core.RatchetPrims = {
  randomBytes: (n) => {
    const b = new Uint8Array(n);
    sodium.randombytes_buf(b);
    return b;
  },
  x25519Keypair: () => {
    const publicKey = new Uint8Array(32);
    const secretKey = new Uint8Array(32);
    sodium.crypto_box_keypair(publicKey, secretKey);
    return { publicKey, secretKey };
  },
  x25519: (sk, pk) => {
    const q = new Uint8Array(32);
    try {
      sodium.crypto_scalarmult(q, sk, pk);
    } catch {
      return null; // all-zero output
    }
    return q;
  },
  secretbox: (m, n, k) => {
    const c = new Uint8Array(m.length + 16);
    sodium.crypto_secretbox_easy(c, m, n, k);
    return c;
  },
  secretboxOpen: (c, n, k) => {
    if (c.length < 16) return null;
    const m = new Uint8Array(c.length - 16);
    return sodium.crypto_secretbox_open_easy(m, c, n, k) ? m : null;
  },
  hmacSha256: (k, m) => new Uint8Array(createHmac('sha256', k).update(m).digest()),
  hkdfSha256: (ikm, salt, info, len) => new Uint8Array(hkdfSync('sha256', ikm, salt, info, len)),
  mlkemKeygen: () => ml_kem768.keygen(),
  mlkemEncapsulate: (pk) => ml_kem768.encapsulate(pk),
  mlkemDecapsulate: (ct, sk) => ml_kem768.decapsulate(ct, sk),
};

const isBytes = (b: unknown): b is Uint8Array => b instanceof Uint8Array;

export function makeNodeRatchet(v: RatchetVaultAccess): RatchetMethods & {
  /** TEST ONLY (not in the native module): the raw state inside a sealed blob. */
  peek(slot: Uint8Array, blob: Uint8Array): RawRatchetState;
} {
  const sealedLen = (slot: Uint8Array): number => v.blobLen(slot, RATCHET_STATE_LEN);

  /** Seal `s` into `blobOut` and write its info; wipes the encoded plaintext. */
  function emit(blobOut: Uint8Array, info: Uint8Array, slot: Uint8Array, s: RawRatchetState): number {
    const plain = encodeRatchetState(s);
    try {
      const rc = v.seal(blobOut, slot, RATCHET_TYPE, plain);
      if (rc === RC.OK) info.set(infoOf(s));
      return rc;
    } finally {
      plain.fill(0);
    }
  }

  function load(slot: Uint8Array, blob: Uint8Array): RawRatchetState | number {
    if (!isBytes(blob) || blob.length !== sealedLen(slot)) return RC.EBADLEN;
    const plain = v.open(slot, RATCHET_TYPE, blob);
    if (typeof plain === 'number') return plain === RC.ENOKEY ? RC.ENOKEY : RC.STATE;
    try {
      return decodeRatchetState(plain);
    } catch {
      return RC.STATE;
    } finally {
      plain.fill(0);
    }
  }

  const outsOk = (blobOut: Uint8Array, info: Uint8Array, slot: Uint8Array): boolean =>
    v.slotOk(slot) && isBytes(blobOut) && blobOut.length === sealedLen(slot) && isBytes(info) && info.length === RATCHET_INFO_LEN;

  /** Run a core step: RatchetCoreError → its code; anything else → EFAIL. */
  function guard(fn: () => number): number {
    try {
      return fn();
    } catch (e) {
      return e instanceof core.RatchetCoreError ? e.code : RC.EFAIL;
    }
  }

  return {
    ratchetInitAlice: (blobOut, info, slot, rk, dhr, pqr) => {
      if (!outsOk(blobOut, info, slot) || !isBytes(rk) || rk.length !== 32 || !isBytes(dhr) || dhr.length !== 32) return RC.EBADLEN;
      if (!isBytes(pqr) || (pqr.length !== 0 && pqr.length !== 1184)) return RC.EBADLEN;
      return guard(() => {
        const s = core.initAlice(nodePrims, rk, dhr, pqr.length ? pqr : null);
        try {
          return emit(blobOut, info, slot, s);
        } finally {
          core.wipeState(s);
        }
      });
    },
    ratchetInitBob: (blobOut, info, slot, rk, spk, pqspk) => {
      if (!outsOk(blobOut, info, slot) || !isBytes(rk) || rk.length !== 32) return RC.EBADLEN;
      if (!isBytes(pqspk) || (pqspk.length !== 0 && pqspk.length !== 4)) return RC.EBADLEN;
      // The SPK is an X25519 prekey of THIS profile (an identity key also
      // qualifies: X25519 is what the operation needs).
      let spkSec = v.secretOf(spk, 5, slot);
      if (typeof spkSec === 'number') spkSec = v.secretOf(spk, 1, slot);
      if (typeof spkSec === 'number') return spkSec;
      let pqSec: Uint8Array | null = null;
      if (pqspk.length) {
        const r = v.secretOf(pqspk, 3, slot);
        if (typeof r === 'number') {
          spkSec.fill(0);
          return r;
        }
        pqSec = r;
      }
      const spkPub = new Uint8Array(32);
      sodium.crypto_scalarmult_base(spkPub, spkSec);
      const pq = pqSec ? { publicKey: pqSec.slice(1152, 1152 + 1184), secretKey: pqSec } : null;
      return guard(() => {
        const s = core.initBob(nodePrims, rk, { publicKey: spkPub, secretKey: spkSec as Uint8Array }, pq);
        try {
          return emit(blobOut, info, slot, s);
        } finally {
          core.wipeState(s);
          (spkSec as Uint8Array).fill(0);
          pqSec?.fill(0);
        }
      });
    },
    ratchetEncrypt: (blobOut, info, hdr, box, slot, blob, m) => {
      if (!outsOk(blobOut, info, slot) || !isBytes(hdr) || hdr.length !== RATCHET_HEADER_LEN) return RC.EBADLEN;
      if (!isBytes(m) || !isBytes(box) || box.length !== 24 + 16 + m.length) return RC.EBADLEN;
      const s = load(slot, blob);
      if (typeof s === 'number') return s;
      return guard(() => {
        try {
          const r = core.ratchetEncrypt(nodePrims, s, m);
          try {
            const rc = emit(blobOut, info, slot, r.state);
            if (rc !== RC.OK) return rc;
          } finally {
            core.wipeState(r.state);
          }
          hdr.fill(0);
          const dv = new DataView(hdr.buffer, hdr.byteOffset, hdr.length);
          dv.setUint32(1, r.header.n, true);
          dv.setUint32(5, r.header.pn, true);
          hdr.set(r.header.ratchetKey, 9);
          if (r.header.pqPub && r.header.pqCt) {
            hdr[0] = 1;
            hdr.set(r.header.pqPub, 41);
            hdr.set(r.header.pqCt, 41 + 1184);
          }
          box.set(r.nonce, 0);
          box.set(r.ciphertext, 24);
          return RC.OK;
        } finally {
          core.wipeState(s);
        }
      });
    },
    ratchetDecrypt: (blobOut, info, m, slot, blob, hdr, box) => {
      if (!outsOk(blobOut, info, slot) || !isBytes(hdr) || hdr.length !== RATCHET_HEADER_LEN) return RC.EBADLEN;
      if (!isBytes(box) || box.length < 24 + 16 || !isBytes(m) || m.length !== box.length - 40) return RC.EBADLEN;
      const s = load(slot, blob);
      if (typeof s === 'number') return s;
      return guard(() => {
        try {
          const r = core.ratchetDecrypt(nodePrims, s, unpackRatchetHeader(hdr), box.subarray(24), box.subarray(0, 24));
          if (!r) return RC.EVERIFY;
          try {
            const rc = emit(blobOut, info, slot, r.state);
            if (rc !== RC.OK) return rc;
            m.set(r.plaintext);
            return RC.OK;
          } finally {
            core.wipeState(r.state);
            r.plaintext.fill(0);
          }
        } finally {
          core.wipeState(s);
        }
      });
    },
    ratchetTrim: (blobOut, info, slot, blob, maxAge) => {
      if (!outsOk(blobOut, info, slot) || !Number.isInteger(maxAge) || maxAge < 0 || maxAge > 0xffffffff) return RC.EBADLEN;
      const s = load(slot, blob);
      if (typeof s === 'number') return s;
      const t = core.trimSkipped(s, maxAge);
      try {
        return emit(blobOut, info, slot, t);
      } finally {
        core.wipeState(s);
        core.wipeState(t);
      }
    },
    ratchetImport: (blobOut, info, slot, raw) => {
      if (!outsOk(blobOut, info, slot) || !isBytes(raw) || raw.length !== RATCHET_STATE_LEN) return RC.EBADLEN;
      let s: RawRatchetState;
      try {
        s = decodeRatchetState(raw);
      } catch {
        return RC.STATE;
      }
      const n = core.normalizeImported(s);
      try {
        return emit(blobOut, info, slot, n);
      } finally {
        core.wipeState(s);
        core.wipeState(n);
      }
    },
    peek: (slot, blob) => {
      const s = load(slot, blob);
      if (typeof s === 'number') throw new Error(`peek: ${s}`);
      return s;
    },
  };
}
