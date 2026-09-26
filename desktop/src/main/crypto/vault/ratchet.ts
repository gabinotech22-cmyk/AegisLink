/**
 * The Double Ratchet in the desktop key vault (F-1b phase 3), MAIN process.
 * Same contract as the mobile C core (`mobile/modules/aegis-sodium/cpp/
 * aegis_ratchet.c`): the state exists only here while a step runs and goes
 * back to the renderer SEALED under the profile KEK (a blob of type 6, never
 * loadable as a key). Every step returns a NEW sealed state; on an error, or a
 * message that does not authenticate, the renderer keeps the old one.
 *
 * The renderer sends and receives plain objects (headers, public info); the
 * state layout (`ratchetState.ts`) never leaves this process.
 */
import sodium from 'sodium-native';
import { hmacSha256, hkdfSha256 } from '../sodium/hashes';
import { mlkemKeygen, mlkemEncapsulate, mlkemDecapsulate } from '../sodium/mlkem';
import * as core from './ratchetCore';
import {
  RATCHET_STATE_LEN,
  MAX_SKIPPED,
  decodeRatchetState,
  encodeRatchetState,
  type RawRatchetState,
  type RatchetHeader,
  type SkippedKey,
} from './ratchetState';
import { KeyVault, VaultError } from './vault';

const RATCHET_TYPE = 6;

/** Non-secret view of a state (counters, public keys): what the renderer may see. */
export interface RatchetInfo {
  Ns: number;
  Nr: number;
  PN: number;
  hybrid: boolean;
  hasCKs: boolean;
  hasCKr: boolean;
  dhsPublicKey: Uint8Array;
  dhr: Uint8Array | null;
}

export interface SealedRatchet {
  sealed: Uint8Array;
  info: RatchetInfo;
}

export const prims: core.RatchetPrims = {
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
      return null; // all-zero output (low-order point)
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
  hmacSha256: (k, m) => hmacSha256(k, m),
  hkdfSha256: (ikm, salt, info, len) => hkdfSha256(ikm, salt, info, len),
  mlkemKeygen: () => mlkemKeygen(),
  mlkemEncapsulate: (pk) => mlkemEncapsulate(pk),
  mlkemDecapsulate: (ct, sk) => mlkemDecapsulate(ct, sk),
};

const isBytes = (b: unknown, len?: number): b is Uint8Array =>
  b instanceof Uint8Array && (len === undefined || b.length === len);
const isU32 = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 0xffffffff;

function infoOf(s: RawRatchetState): RatchetInfo {
  return {
    Ns: s.Ns,
    Nr: s.Nr,
    PN: s.PN,
    hybrid: !!s.PQs,
    hasCKs: !!s.CKs,
    hasCKr: !!s.CKr,
    dhsPublicKey: Uint8Array.from(s.DHs.publicKey),
    dhr: s.DHr ? Uint8Array.from(s.DHr) : null,
  };
}

/** A header off the wire, validated: anything the ratchet could never accept is refused here. */
function header(h: unknown): RatchetHeader {
  const o = h as Partial<RatchetHeader> | null;
  if (!o || typeof o !== 'object' || !isU32(o.n) || !isU32(o.pn) || !isBytes(o.ratchetKey, 32)) {
    throw new VaultError('BAD_ARG', 'Ratchet: bad header');
  }
  const out: RatchetHeader = { ratchetKey: o.ratchetKey, n: o.n, pn: o.pn };
  // Both or neither: a half-present pair is dropped, which a hybrid session rejects as a downgrade.
  if (o.pqPub !== undefined && o.pqCt !== undefined) {
    if (!isBytes(o.pqPub, 1184) || !isBytes(o.pqCt, 1088)) throw new VaultError('BAD_ARG', 'Ratchet: bad header PQ material');
    out.pqPub = o.pqPub;
    out.pqCt = o.pqCt;
  }
  return out;
}

export class VaultRatchet {
  constructor(private readonly vault: KeyVault) {}

  /** Seal `s` for `slot`; wipes the encoding and `s`. */
  private emit(slot: string, s: RawRatchetState): SealedRatchet {
    const plain = encodeRatchetState(s);
    try {
      return { sealed: this.vault.sealPayload(slot, RATCHET_TYPE, plain), info: infoOf(s) };
    } finally {
      plain.fill(0);
      core.wipeState(s);
    }
  }

  private load(slot: string, sealed: unknown): RawRatchetState {
    if (!isBytes(sealed)) throw new VaultError('BAD_ARG', 'Ratchet: bad sealed state');
    const plain = this.vault.openPayload(slot, RATCHET_TYPE, sealed, RATCHET_STATE_LEN);
    try {
      return decodeRatchetState(plain);
    } catch {
      throw new VaultError('REJECTED', 'Ratchet: sealed state rejected (another profile, tampered or corrupt)');
    } finally {
      plain.fill(0);
    }
  }

  initAlice(slot: string, rootKey: Uint8Array, bobSpk: Uint8Array, bobPqSpk: Uint8Array | null): SealedRatchet {
    try {
      if (!isBytes(rootKey, 32) || !isBytes(bobSpk, 32) || (bobPqSpk !== null && !isBytes(bobPqSpk, 1184))) {
        throw new VaultError('BAD_ARG', 'Ratchet: bad init');
      }
      return this.emit(slot, core.initAlice(prims, rootKey, bobSpk, bobPqSpk));
    } finally {
      if (rootKey instanceof Uint8Array) rootKey.fill(0); // the IPC copy
    }
  }

  /** Bob: his SPK (and PQSPK) handles, of `slot`, are his initial pair. */
  initBob(slot: string, rootKey: Uint8Array, spk: number, pqSpk: number | null): SealedRatchet {
    let spkSec: Uint8Array | null = null;
    let pqSec: Uint8Array | null = null;
    try {
      if (!isBytes(rootKey, 32)) throw new VaultError('BAD_ARG', 'Ratchet: bad init');
      spkSec = this.vault.readSecret(spk, 'x25519', slot);
      const spkPub = new Uint8Array(32);
      sodium.crypto_scalarmult_base(spkPub, spkSec);
      let pq: { publicKey: Uint8Array; secretKey: Uint8Array } | null = null;
      if (pqSpk !== null) {
        pqSec = this.vault.readSecret(pqSpk, 'mlkem768', slot);
        // The encapsulation key sits inside the FIPS 203 decapsulation key.
        pq = { publicKey: pqSec.slice(1152, 1152 + 1184), secretKey: pqSec };
      }
      return this.emit(slot, core.initBob(prims, rootKey, { publicKey: spkPub, secretKey: spkSec }, pq));
    } finally {
      spkSec?.fill(0);
      pqSec?.fill(0);
      if (rootKey instanceof Uint8Array) rootKey.fill(0);
    }
  }

  encrypt(slot: string, sealed: Uint8Array, plaintext: Uint8Array): SealedRatchet & { header: RatchetHeader; nonce: Uint8Array; ciphertext: Uint8Array } {
    if (!isBytes(plaintext)) throw new VaultError('BAD_ARG', 'Ratchet: bad plaintext');
    const s = this.load(slot, sealed);
    try {
      const r = core.ratchetEncrypt(prims, s, plaintext);
      return { ...this.emit(slot, r.state), header: r.header, nonce: r.nonce, ciphertext: r.ciphertext };
    } finally {
      core.wipeState(s);
    }
  }

  /** The plaintext and the new state, or null when the message does not authenticate. */
  decrypt(slot: string, sealed: Uint8Array, h: unknown, box: Uint8Array): (SealedRatchet & { plaintext: Uint8Array }) | null {
    if (!isBytes(box) || box.length < 24 + 16) return null;
    const hdr = header(h);
    const s = this.load(slot, sealed);
    try {
      const r = core.ratchetDecrypt(prims, s, hdr, box.subarray(24), box.subarray(0, 24));
      if (!r) return null;
      return { ...this.emit(slot, r.state), plaintext: r.plaintext };
    } finally {
      core.wipeState(s);
    }
  }

  trim(slot: string, sealed: Uint8Array, maxAge: number): SealedRatchet {
    if (!isU32(maxAge)) throw new VaultError('BAD_ARG', 'Ratchet: bad max age');
    const s = this.load(slot, sealed);
    try {
      return this.emit(slot, core.trimSkipped(s, maxAge));
    } finally {
      core.wipeState(s);
    }
  }

  /**
   * One-time migration of a pre-F-1b session (raw keys revived from the
   * renderer's old JSON, design doc section 4). Malformed → REJECTED (the
   * session is re-keyed, never guessed). The IPC copies are zeroed.
   */
  import(slot: string, raw: unknown): SealedRatchet {
    const r = raw as Partial<RawRatchetState> | null;
    const wipe = (): void => {
      if (!r || typeof r !== 'object') return;
      for (const b of [r.RK, r.CKs, r.CKr, r.DHs?.secretKey, r.PQs?.secretKey]) if (b instanceof Uint8Array) b.fill(0);
      if (Array.isArray(r.skipped)) for (const e of r.skipped) if (e && e.mk instanceof Uint8Array) e.mk.fill(0);
    };
    try {
      const bad = (): VaultError => new VaultError('REJECTED', 'Ratchet: legacy session rejected (malformed)');
      if (!r || typeof r !== 'object' || !r.DHs || !Array.isArray(r.skipped)) throw bad();
      // Required fields (the encoder leaves an absent field zero, which here would be a guess).
      if (!isBytes(r.RK, 32) || !isBytes(r.DHs.publicKey, 32) || !isBytes(r.DHs.secretKey, 32)) throw bad();
      if (!isU32(r.Ns) || !isU32(r.Nr) || !isU32(r.PN)) throw bad();
      const skipped: SkippedKey[] = r.skipped.filter(
        (e): e is SkippedKey => !!e && isBytes(e.pub, 32) && isBytes(e.mk, 32) && isU32(e.n),
      );
      if (skipped.length > MAX_SKIPPED) throw bad();
      let encoded: Uint8Array;
      try {
        encoded = encodeRatchetState({
          DHs: { publicKey: r.DHs.publicKey as Uint8Array, secretKey: r.DHs.secretKey as Uint8Array },
          DHr: r.DHr ?? null,
          RK: r.RK as Uint8Array,
          PQs: r.PQs ?? null,
          PQr: r.PQr ?? null,
          pqSendCt: r.pqSendCt ?? null,
          CKs: r.CKs ?? null,
          CKr: r.CKr ?? null,
          Ns: r.Ns as number,
          Nr: r.Nr as number,
          PN: r.PN as number,
          skipped,
        });
      } catch {
        throw bad();
      }
      try {
        return this.emit(slot, decodeRatchetState(encoded));
      } finally {
        encoded.fill(0);
      }
    } finally {
      wipe();
    }
  }
}
