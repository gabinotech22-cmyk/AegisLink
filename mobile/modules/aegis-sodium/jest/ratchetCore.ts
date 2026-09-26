/**
 * The Double Ratchet (classic and hybrid ML-KEM-768, "R1") on a raw state:
 * the algorithm the vault runs, in TypeScript. Twin of the C port in
 * `../cpp/aegis_ratchet.c` (what the app ships) and of
 * `desktop/src/main/crypto/vault/ratchetCore.ts` (what the desktop main
 * process runs). Before F-1b phase 3 this was `src/crypto/signal/ratchet.ts`;
 * the algorithm and the bytes on the wire are unchanged.
 *
 * Used by the Jest stand-in of the vault (`nodeRatchet.ts`) and, as the
 * reference, by the C interop test (`../test/ratchet-interop.mjs`). Not
 * shipped in the app. Pure: primitives come in `RatchetPrims`, so Node can
 * load it with type stripping.
 *
 * Transactional: `ratchetDecrypt` works on a copy and returns the advanced
 * state only when the message authenticates (Signal Double Ratchet spec
 * section 3.4); callers keep the old state otherwise.
 */

/** Same shape as `RawRatchetState` in `../ratchetState.ts`. */
export interface CoreState {
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
  skipped: { pub: Uint8Array; n: number; mk: Uint8Array }[];
}

export interface CoreHeader {
  ratchetKey: Uint8Array;
  n: number;
  pn: number;
  pqPub?: Uint8Array;
  pqCt?: Uint8Array;
}

export interface RatchetPrims {
  randomBytes(n: number): Uint8Array;
  x25519Keypair(): { publicKey: Uint8Array; secretKey: Uint8Array };
  /** X25519; returns null when the output is all zero (low-order point). */
  x25519(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array | null;
  secretbox(m: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array;
  secretboxOpen(c: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null;
  hmacSha256(key: Uint8Array, msg: Uint8Array): Uint8Array;
  hkdfSha256(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, len: number): Uint8Array;
  mlkemKeygen(): { publicKey: Uint8Array; secretKey: Uint8Array };
  mlkemEncapsulate(publicKey: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array };
  mlkemDecapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array;
}

/** Return codes shared with the C core (`aegis_vault.h`). */
export const RC = {
  OK: 0,
  EVERIFY: 1,
  EBADLEN: -1,
  EFAIL: -2,
  ENOKEY: -3,
  STATE: -10,
  NO_CHAIN: -11,
  TOO_MANY_SKIPPED: -12,
  LOW_ORDER: -13,
  DOWNGRADE: -14,
  PQ: -15,
} as const;

export class RatchetCoreError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export const MAX_SKIPPED_KEYS = 50;
const MLKEM_PUB = 1184;
const MLKEM_CT = 1088;

const enc = (s: string): Uint8Array => {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
};
const ROOT_INFO = enc('AegisLinkRoot');
const ROOT_INFO_PQ = enc('AegisLinkRootPQ');
const MESSAGE_KEY_CONSTANT = new Uint8Array([0x01]);
const CHAIN_KEY_CONSTANT = new Uint8Array([0x02]);

const zero = (b: Uint8Array | null | undefined): void => {
  if (b) b.fill(0);
};

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

function dh(p: RatchetPrims, sk: Uint8Array, pk: Uint8Array): Uint8Array {
  const out = pk.length === 32 ? p.x25519(sk, pk) : null;
  if (!out) throw new RatchetCoreError(RC.LOW_ORDER, 'Ratchet: all-zero DH output — low-order point attack');
  return out;
}

function pqSecret(ss: Uint8Array): Uint8Array {
  let acc = 0;
  for (let i = 0; i < ss.length; i++) acc |= ss[i];
  if (ss.length !== 32 || acc === 0) throw new RatchetCoreError(RC.PQ, 'Ratchet: all-zero ML-KEM shared secret');
  return ss;
}

function kdfRoot(p: RatchetPrims, rk: Uint8Array, dhOut: Uint8Array, pq: Uint8Array | null): { rk: Uint8Array; ck: Uint8Array } {
  let ikm = dhOut;
  if (pq) {
    ikm = new Uint8Array(dhOut.length + pq.length);
    ikm.set(dhOut, 0);
    ikm.set(pq, dhOut.length);
  }
  const d = p.hkdfSha256(ikm, rk, pq ? ROOT_INFO_PQ : ROOT_INFO, 64);
  const out = { rk: d.slice(0, 32), ck: d.slice(32, 64) };
  zero(d);
  if (pq) zero(ikm);
  return out;
}

function kdfChain(p: RatchetPrims, ck: Uint8Array): { ck: Uint8Array; mk: Uint8Array } {
  return { mk: p.hmacSha256(ck, MESSAGE_KEY_CONSTANT), ck: p.hmacSha256(ck, CHAIN_KEY_CONSTANT) };
}

export function wipeState(s: CoreState): void {
  zero(s.DHs.secretKey);
  zero(s.RK);
  zero(s.CKs);
  zero(s.CKr);
  if (s.PQs) zero(s.PQs.secretKey);
  for (const e of s.skipped) zero(e.mk);
}

export function copyState(s: CoreState): CoreState {
  const c = (b: Uint8Array | null): Uint8Array | null => (b ? Uint8Array.from(b) : null);
  return {
    DHs: { publicKey: Uint8Array.from(s.DHs.publicKey), secretKey: Uint8Array.from(s.DHs.secretKey) },
    DHr: c(s.DHr),
    RK: Uint8Array.from(s.RK),
    PQs: s.PQs ? { publicKey: Uint8Array.from(s.PQs.publicKey), secretKey: Uint8Array.from(s.PQs.secretKey) } : null,
    PQr: c(s.PQr),
    pqSendCt: c(s.pqSendCt),
    CKs: c(s.CKs),
    CKr: c(s.CKr),
    Ns: s.Ns,
    Nr: s.Nr,
    PN: s.PN,
    skipped: s.skipped.map((e) => ({ pub: Uint8Array.from(e.pub), n: e.n, mk: Uint8Array.from(e.mk) })),
  };
}

/** Alice: she sends first, so she turns the first sending chain right away. */
export function initAlice(p: RatchetPrims, rootKey: Uint8Array, bobSpk: Uint8Array, bobPqSpk: Uint8Array | null): CoreState {
  if (rootKey.length !== 32 || bobSpk.length !== 32) throw new RatchetCoreError(RC.EBADLEN, 'Ratchet: bad init');
  if (bobPqSpk && bobPqSpk.length !== MLKEM_PUB) throw new RatchetCoreError(RC.EBADLEN, 'Ratchet: bad init');
  const s: CoreState = {
    DHs: p.x25519Keypair(),
    DHr: Uint8Array.from(bobSpk),
    RK: Uint8Array.from(rootKey),
    PQs: null,
    PQr: bobPqSpk ? Uint8Array.from(bobPqSpk) : null,
    pqSendCt: null,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    skipped: [],
  };
  try {
    const dhOut = dh(p, s.DHs.secretKey, bobSpk);
    let pq: Uint8Array | null = null;
    if (bobPqSpk) {
      // Alice's own PQ pair for this sending chain; she encapsulates to Bob's
      // PQSPK so Bob recovers the same secret with his PQSPK.
      s.PQs = p.mlkemKeygen();
      const { cipherText, sharedSecret } = p.mlkemEncapsulate(bobPqSpk);
      pq = pqSecret(sharedSecret);
      s.pqSendCt = cipherText;
    }
    const { rk, ck } = kdfRoot(p, s.RK, dhOut, pq);
    zero(s.RK);
    s.RK = rk;
    s.CKs = ck;
    zero(dhOut);
    zero(pq);
    return s;
  } catch (e) {
    wipeState(s);
    throw e;
  }
}

/**
 * Bob: his SPK (and PQSPK, hybrid) is his initial pair, so his first
 * dhRatchet step matches Alice's: DH(spk.sec, alice.DHs.pub) == DH(alice.DHs.sec, spk.pub).
 */
export function initBob(
  p: RatchetPrims,
  rootKey: Uint8Array,
  spk: { publicKey: Uint8Array; secretKey: Uint8Array },
  pqSpk: { publicKey: Uint8Array; secretKey: Uint8Array } | null,
): CoreState {
  if (rootKey.length !== 32 || spk.publicKey.length !== 32 || spk.secretKey.length !== 32) {
    throw new RatchetCoreError(RC.EBADLEN, 'Ratchet: bad init');
  }
  return {
    DHs: { publicKey: Uint8Array.from(spk.publicKey), secretKey: Uint8Array.from(spk.secretKey) },
    DHr: null,
    RK: Uint8Array.from(rootKey),
    PQs: pqSpk ? { publicKey: Uint8Array.from(pqSpk.publicKey), secretKey: Uint8Array.from(pqSpk.secretKey) } : null,
    PQr: null,
    pqSendCt: null,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    skipped: [],
  };
}

export function ratchetEncrypt(
  p: RatchetPrims,
  s: CoreState,
  plaintext: Uint8Array,
): { state: CoreState; header: CoreHeader; ciphertext: Uint8Array; nonce: Uint8Array } {
  if (!s.CKs) throw new RatchetCoreError(RC.NO_CHAIN, 'Cannot encrypt without a sender chain key');
  const w = copyState(s);
  const { ck, mk } = kdfChain(p, w.CKs!);
  zero(w.CKs);
  w.CKs = ck;
  const nonce = p.randomBytes(24);
  let ciphertext: Uint8Array;
  try {
    ciphertext = p.secretbox(plaintext, nonce, mk);
  } catch (e) {
    wipeState(w);
    throw e;
  } finally {
    zero(mk);
  }
  const header: CoreHeader = { ratchetKey: Uint8Array.from(w.DHs.publicKey), n: w.Ns, pn: w.PN };
  // PQ material for this sending chain rides on EVERY message of it, so a
  // lost chain head does not strand the chain (the peer uses it on its turn).
  if (w.PQs && w.pqSendCt) {
    header.pqPub = Uint8Array.from(w.PQs.publicKey);
    header.pqCt = Uint8Array.from(w.pqSendCt);
  }
  w.Ns += 1;
  return { state: w, header, ciphertext, nonce };
}

function findSkipped(s: CoreState, pub: Uint8Array, n: number): number {
  for (let i = 0; i < s.skipped.length; i++) {
    if (s.skipped[i].n === n && bytesEqual(s.skipped[i].pub, pub)) return i;
  }
  return -1;
}

/** Keep at most MAX_SKIPPED_KEYS: evict the lowest n first (ties: oldest first). */
function enforceLimit(s: CoreState): void {
  while (s.skipped.length > MAX_SKIPPED_KEYS) {
    let min = 0;
    for (let i = 1; i < s.skipped.length; i++) if (s.skipped[i].n < s.skipped[min].n) min = i;
    zero(s.skipped[min].mk);
    s.skipped.splice(min, 1);
  }
}

function skipUntil(p: RatchetPrims, s: CoreState, until: number): void {
  if (s.Nr + MAX_SKIPPED_KEYS < until) throw new RatchetCoreError(RC.TOO_MANY_SKIPPED, 'Too many skipped messages');
  while (s.Nr < until) {
    if (!s.CKr) throw new RatchetCoreError(RC.NO_CHAIN, 'Cannot skip messages without receiver chain key');
    const { ck, mk } = kdfChain(p, s.CKr);
    zero(s.CKr);
    s.CKr = ck;
    const i = findSkipped(s, s.DHr!, s.Nr);
    if (i >= 0) {
      zero(s.skipped[i].mk);
      s.skipped[i].mk = mk; // same (pub, n): replace in place, keep its position
    } else {
      s.skipped.push({ pub: Uint8Array.from(s.DHr!), n: s.Nr, mk });
    }
    s.Nr += 1;
  }
  enforceLimit(s);
}

function dhRatchet(p: RatchetPrims, s: CoreState, h: CoreHeader): void {
  // Validate the DH and the PQ material BEFORE touching any counter or key.
  const dh1 = dh(p, s.DHs.secretKey, h.ratchetKey);
  const hybrid = !!s.PQs;
  if (hybrid && (!h.pqPub || !h.pqCt)) {
    zero(dh1);
    throw new RatchetCoreError(RC.DOWNGRADE, 'Ratchet: missing PQ material on hybrid session — possible downgrade attack');
  }
  let pq1: Uint8Array | null = null;
  if (hybrid) {
    if (h.pqCt!.length !== MLKEM_CT || h.pqPub!.length !== MLKEM_PUB) {
      zero(dh1);
      throw new RatchetCoreError(RC.PQ, 'Ratchet: bad PQ material');
    }
    pq1 = pqSecret(p.mlkemDecapsulate(h.pqCt!, s.PQs!.secretKey));
  }

  s.PN = s.Ns;
  s.Ns = 0;
  s.Nr = 0;
  s.DHr = Uint8Array.from(h.ratchetKey);
  if (hybrid) s.PQr = Uint8Array.from(h.pqPub!);

  const r1 = kdfRoot(p, s.RK, dh1, pq1);
  zero(s.RK);
  zero(s.CKr);
  s.RK = r1.rk;
  s.CKr = r1.ck;
  zero(dh1);
  zero(pq1);

  zero(s.DHs.secretKey);
  s.DHs = p.x25519Keypair();
  if (hybrid) {
    zero(s.PQs!.secretKey);
    s.PQs = p.mlkemKeygen();
  }

  const dh2 = dh(p, s.DHs.secretKey, s.DHr);
  let pq2: Uint8Array | null = null;
  if (hybrid && s.PQr) {
    const { cipherText, sharedSecret } = p.mlkemEncapsulate(s.PQr);
    pq2 = pqSecret(sharedSecret);
    s.pqSendCt = cipherText;
  }
  const r2 = kdfRoot(p, s.RK, dh2, pq2);
  zero(s.RK);
  zero(s.CKs);
  s.RK = r2.rk;
  s.CKs = r2.ck;
  zero(dh2);
  zero(pq2);
}

/**
 * Decrypt one message. Returns the plaintext and the advanced state, or
 * `null` when the message does not authenticate (the caller's state is
 * untouched: a forged message never advances or burns anything). Throws
 * `RatchetCoreError` for a message the ratchet refuses outright.
 */
export function ratchetDecrypt(
  p: RatchetPrims,
  s: CoreState,
  h: CoreHeader,
  ciphertext: Uint8Array,
  nonce: Uint8Array,
): { state: CoreState; plaintext: Uint8Array } | null {
  const hit = findSkipped(s, h.ratchetKey, h.n);
  if (hit >= 0) {
    const pt = p.secretboxOpen(ciphertext, nonce, s.skipped[hit].mk);
    if (!pt) return null; // a forgery does not burn the stored key
    const w = copyState(s);
    zero(w.skipped[hit].mk);
    w.skipped.splice(hit, 1);
    return { state: w, plaintext: pt };
  }

  const w = copyState(s);
  try {
    if (!w.DHr || !bytesEqual(h.ratchetKey, w.DHr)) {
      skipUntil(p, w, h.pn);
      dhRatchet(p, w, h);
    }
    skipUntil(p, w, h.n);
    if (!w.CKr) throw new RatchetCoreError(RC.NO_CHAIN, 'No receiver chain key');
    const { ck, mk } = kdfChain(p, w.CKr);
    zero(w.CKr);
    w.CKr = ck;
    w.Nr += 1;
    let pt: Uint8Array | null;
    try {
      pt = p.secretboxOpen(ciphertext, nonce, mk);
    } finally {
      zero(mk);
    }
    if (!pt) {
      wipeState(w);
      return null;
    }
    return { state: w, plaintext: pt };
  } catch (e) {
    wipeState(w);
    throw e;
  }
}

/** Drop skipped keys older than `Nr - maxAge` (shrinks the forward-secrecy window). */
export function trimSkipped(s: CoreState, maxAge: number): CoreState {
  const w = copyState(s);
  const cutoff = w.Nr - maxAge;
  w.skipped = w.skipped.filter((e) => {
    if (e.n < cutoff) {
      zero(e.mk);
      return false;
    }
    return true;
  });
  return w;
}

/**
 * Normalize an imported (pre-F-1b) state: drop skipped keys that are not
 * (32-byte key, u32 n, 32-byte message key), then apply the cap.
 */
export function normalizeImported(s: CoreState): CoreState {
  const w = copyState(s);
  w.skipped = w.skipped.filter((e) => e.pub.length === 32 && e.mk.length === 32 && Number.isInteger(e.n) && e.n >= 0);
  enforceLimit(w);
  return w;
}
