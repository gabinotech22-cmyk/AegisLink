/**
 * Binary layout of a Double Ratchet state inside the desktop key vault (F-1b
 * phase 3, docs/F1B-KEY-VAULT-DESIGN.md), in the MAIN process. Twin of
 * `mobile/modules/aegis-sodium/ratchetState.ts` (and of the struct the mobile
 * C core seals, `cpp/aegis_ratchet.c`): the same state, byte for byte.
 *
 * The state is fixed-size, so its sealed blob is too: the vault seals it under
 * the profile KEK as a blob of type 6 (ratchet), which never loads as a key
 * handle, and no key blob ever opens as a state.
 * Pure: no imports.
 *
 * State v1 (little-endian u32):
 *   0 version=1 | 1 flags | 2 nskipped | 3 reserved=0 | 4 Ns | 8 Nr | 12 PN
 *   16 RK[32] | 48 DHs.pub[32] | 80 DHs.sec[32] | 112 DHr[32] | 144 CKs[32]
 *   176 CKr[32] | 208 PQs.pub[1184] | 1392 PQs.sec[2400] | 3792 PQr[1184]
 *   4976 pqSendCt[1088] | 6064 skipped[50] = { pub[32] | n u32 | mk[32] }
 * Absent fields (flag clear) are zero.
 */

export const RATCHET_STATE_VERSION = 1;
export const MAX_SKIPPED = 50;
export const MLKEM_PUB = 1184;
export const MLKEM_SEC = 2400;
export const MLKEM_CT = 1088;

export const F_DHR = 1;
export const F_CKS = 2;
export const F_CKR = 4;
export const F_PQS = 8;
export const F_PQR = 16;
export const F_PQCT = 32;

const O_NS = 4;
const O_NR = 8;
const O_PN = 12;
const O_RK = 16;
const O_DHS_PUB = 48;
const O_DHS_SEC = 80;
const O_DHR = 112;
const O_CKS = 144;
const O_CKR = 176;
const O_PQS_PUB = 208;
const O_PQS_SEC = O_PQS_PUB + MLKEM_PUB; // 1392
const O_PQR = O_PQS_SEC + MLKEM_SEC; // 3792
const O_PQCT = O_PQR + MLKEM_PUB; // 4976
const O_SKIPPED = O_PQCT + MLKEM_CT; // 6064
const SKIPPED_ENTRY = 68;
export const RATCHET_STATE_LEN = O_SKIPPED + MAX_SKIPPED * SKIPPED_ENTRY; // 9464

/** One stored out-of-order message key: (the chain's ratchet public key, n). */
export interface SkippedKey {
  pub: Uint8Array;
  n: number;
  mk: Uint8Array;
}

/**
 * A ratchet state with raw keys. Exists only inside the vault (and its Jest
 * stand-in, and the one-time migration of a pre-F-1b session).
 */
export interface RawRatchetState {
  DHs: { publicKey: Uint8Array; secretKey: Uint8Array };
  DHr: Uint8Array | null;
  RK: Uint8Array;
  PQs: { publicKey: Uint8Array; secretKey: Uint8Array } | null;
  PQr: Uint8Array | null;
  pqSendCt: Uint8Array | null;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  /** In insertion order (eviction ties break by it). */
  skipped: SkippedKey[];
}

const U32_MAX = 0xffffffff;
const isU32 = (n: number): boolean => Number.isInteger(n) && n >= 0 && n <= U32_MAX;

function put(out: Uint8Array, off: number, b: Uint8Array | null, len: number, what: string): void {
  if (!b) return;
  if (b.length !== len) throw new Error(`ratchetState: ${what} must be ${len} bytes`);
  out.set(b, off);
}

export function encodeRatchetState(s: RawRatchetState): Uint8Array {
  if (!isU32(s.Ns) || !isU32(s.Nr) || !isU32(s.PN)) throw new Error('ratchetState: counter out of range');
  if (s.skipped.length > MAX_SKIPPED) throw new Error('ratchetState: too many skipped keys');
  const out = new Uint8Array(RATCHET_STATE_LEN);
  const dv = new DataView(out.buffer);
  let flags = 0;
  if (s.DHr) flags |= F_DHR;
  if (s.CKs) flags |= F_CKS;
  if (s.CKr) flags |= F_CKR;
  if (s.PQs) flags |= F_PQS;
  if (s.PQr) flags |= F_PQR;
  if (s.pqSendCt) flags |= F_PQCT;
  out[0] = RATCHET_STATE_VERSION;
  out[1] = flags;
  out[2] = s.skipped.length;
  dv.setUint32(O_NS, s.Ns, true);
  dv.setUint32(O_NR, s.Nr, true);
  dv.setUint32(O_PN, s.PN, true);
  put(out, O_RK, s.RK, 32, 'RK');
  put(out, O_DHS_PUB, s.DHs.publicKey, 32, 'DHs.publicKey');
  put(out, O_DHS_SEC, s.DHs.secretKey, 32, 'DHs.secretKey');
  put(out, O_DHR, s.DHr, 32, 'DHr');
  put(out, O_CKS, s.CKs, 32, 'CKs');
  put(out, O_CKR, s.CKr, 32, 'CKr');
  if (s.PQs) {
    put(out, O_PQS_PUB, s.PQs.publicKey, MLKEM_PUB, 'PQs.publicKey');
    put(out, O_PQS_SEC, s.PQs.secretKey, MLKEM_SEC, 'PQs.secretKey');
  }
  put(out, O_PQR, s.PQr, MLKEM_PUB, 'PQr');
  put(out, O_PQCT, s.pqSendCt, MLKEM_CT, 'pqSendCt');
  s.skipped.forEach((e, i) => {
    const o = O_SKIPPED + i * SKIPPED_ENTRY;
    if (!isU32(e.n)) throw new Error('ratchetState: skipped n out of range');
    put(out, o, e.pub, 32, 'skipped.pub');
    dv.setUint32(o + 32, e.n, true);
    put(out, o + 36, e.mk, 32, 'skipped.mk');
  });
  return out;
}

export function decodeRatchetState(b: Uint8Array): RawRatchetState {
  if (b.length !== RATCHET_STATE_LEN || b[0] !== RATCHET_STATE_VERSION || (b[1] & ~63) !== 0 || b[3] !== 0 || b[2] > MAX_SKIPPED) {
    throw new Error('ratchetState: malformed state');
  }
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const flags = b[1];
  const cp = (off: number, len: number): Uint8Array => b.slice(off, off + len);
  const opt = (f: number, off: number, len: number): Uint8Array | null => (flags & f ? cp(off, len) : null);
  const skipped: SkippedKey[] = [];
  for (let i = 0; i < b[2]; i++) {
    const o = O_SKIPPED + i * SKIPPED_ENTRY;
    skipped.push({ pub: cp(o, 32), n: dv.getUint32(o + 32, true), mk: cp(o + 36, 32) });
  }
  return {
    DHs: { publicKey: cp(O_DHS_PUB, 32), secretKey: cp(O_DHS_SEC, 32) },
    DHr: opt(F_DHR, O_DHR, 32),
    RK: cp(O_RK, 32),
    PQs: flags & F_PQS ? { publicKey: cp(O_PQS_PUB, MLKEM_PUB), secretKey: cp(O_PQS_SEC, MLKEM_SEC) } : null,
    PQr: opt(F_PQR, O_PQR, MLKEM_PUB),
    pqSendCt: opt(F_PQCT, O_PQCT, MLKEM_CT),
    CKs: opt(F_CKS, O_CKS, 32),
    CKr: opt(F_CKR, O_CKR, 32),
    Ns: dv.getUint32(O_NS, true),
    Nr: dv.getUint32(O_NR, true),
    PN: dv.getUint32(O_PN, true),
    skipped,
  };
}

// ── Message header, packed for the native call ─────────────────────────────
//   0 flags (1 = pqPub + pqCt present) | 1 n u32 | 5 pn u32 | 9 ratchetKey[32]
//   41 pqPub[1184] | 1225 pqCt[1088]
export const RATCHET_HEADER_LEN = 41 + MLKEM_PUB + MLKEM_CT; // 2313

export interface RatchetHeader {
  ratchetKey: Uint8Array;
  n: number;
  pn: number;
  pqPub?: Uint8Array;
  pqCt?: Uint8Array;
}

/** Pack a header off the wire; throws on anything the ratchet could never accept. */
export function packRatchetHeader(h: RatchetHeader): Uint8Array {
  if (!isU32(h.n) || !isU32(h.pn)) throw new Error('Ratchet: bad header counter');
  if (!(h.ratchetKey instanceof Uint8Array) || h.ratchetKey.length !== 32) throw new Error('Ratchet: bad header ratchet key');
  const out = new Uint8Array(RATCHET_HEADER_LEN);
  const dv = new DataView(out.buffer);
  dv.setUint32(1, h.n, true);
  dv.setUint32(5, h.pn, true);
  out.set(h.ratchetKey, 9);
  if (h.pqPub || h.pqCt) {
    // Both or neither: a half-present pair is dropped, which a hybrid session
    // then rejects as a downgrade (the same outcome as before F-1b phase 3).
    if (h.pqPub && h.pqCt) {
      if (h.pqPub.length !== MLKEM_PUB || h.pqCt.length !== MLKEM_CT) throw new Error('Ratchet: bad header PQ material');
      out[0] = 1;
      out.set(h.pqPub, 41);
      out.set(h.pqCt, 41 + MLKEM_PUB);
    }
  }
  return out;
}

export function unpackRatchetHeader(b: Uint8Array): RatchetHeader {
  if (b.length !== RATCHET_HEADER_LEN) throw new Error('Ratchet: bad packed header');
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  const h: RatchetHeader = { ratchetKey: b.slice(9, 41), n: dv.getUint32(1, true), pn: dv.getUint32(5, true) };
  if (b[0] & 1) {
    h.pqPub = b.slice(41, 41 + MLKEM_PUB);
    h.pqCt = b.slice(41 + MLKEM_PUB, RATCHET_HEADER_LEN);
  }
  return h;
}

// ── Public view of a state, returned by every native ratchet call ──────────
//   0 Ns u32 | 4 Nr u32 | 8 PN u32 | 12 flags (1 hybrid, 2 CKs, 4 CKr, 8 DHr)
//   13 DHs.pub[32] | 45 DHr[32]
export const RATCHET_INFO_LEN = 77;

/** Non-secret facts about a state (counters, public keys): what the app may see. */
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

export function infoOf(s: RawRatchetState): Uint8Array {
  const out = new Uint8Array(RATCHET_INFO_LEN);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, s.Ns, true);
  dv.setUint32(4, s.Nr, true);
  dv.setUint32(8, s.PN, true);
  out[12] = (s.PQs ? 1 : 0) | (s.CKs ? 2 : 0) | (s.CKr ? 4 : 0) | (s.DHr ? 8 : 0);
  out.set(s.DHs.publicKey, 13);
  if (s.DHr) out.set(s.DHr, 45);
  return out;
}

export function decodeRatchetInfo(b: Uint8Array): RatchetInfo {
  if (b.length !== RATCHET_INFO_LEN) throw new Error('ratchetState: bad info');
  const dv = new DataView(b.buffer, b.byteOffset, b.length);
  return {
    Ns: dv.getUint32(0, true),
    Nr: dv.getUint32(4, true),
    PN: dv.getUint32(8, true),
    hybrid: (b[12] & 1) !== 0,
    hasCKs: (b[12] & 2) !== 0,
    hasCKr: (b[12] & 4) !== 0,
    dhsPublicKey: b.slice(13, 45),
    dhr: b[12] & 8 ? b.slice(45, 77) : null,
  };
}
