import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { hkdfSHA256, hmacSHA256 } from './kdf';

export interface RatchetState {
  // Diffie-Hellman Ratchet state
  DHs: { publicKey: Uint8Array; secretKey: Uint8Array }; // Our current DH pair
  DHr: Uint8Array | null; // Contact's current public DH key

  // Root Chain state
  RK: Uint8Array;

  // Sending and Receiving Chain states
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;

  // Message counters
  Ns: number;
  Nr: number;
  PN: number; // Number of messages in previous sending chain

  // Skipped message keys: (header.dh_pub_b64 || header.n) -> MessageKey
  MKSKIPPED: Map<string, Uint8Array>;

  // Optional X3DH initialization parameters for the recipient's trial decryption
  x3dhInit?: {
    aliceEKB64: string;
    spkId: number;
    opkId: number | null;
    /**
     * PQXDH (v2): base64 ML-KEM-768 ciphertext (1088 bytes) produced by the
     * sender encapsulating to the recipient's PQSPK. Present iff the handshake
     * negotiated v2; rides inside the sealed init so the recipient can
     * decapsulate. Absent ⇒ classic v1 handshake.
     */
    pqCtB64?: string;
  };

  // Wall-clock time (ms) at which this session was established via X3DH. Used by
  // the transport layer to grant a grace period so a stale, in-flight message on
  // the OLD session cannot trigger a desync-recovery teardown of a freshly
  // negotiated session. Not key material; safe to persist in cleartext-of-session.
  createdAtMs?: number;
}

const ROOT_INFO = new TextEncoder().encode('AegisLinkRoot');
const MESSAGE_KEY_CONSTANT = new Uint8Array([0x01]);
const CHAIN_KEY_CONSTANT = new Uint8Array([0x02]);

/**
 * Forward-secrecy bound: hard cap on how many out-of-order message keys we will
 * retain. Lower than Signal's default 2000 to shrink the post-hoc decryption
 * window if the encrypted DB is ever recovered. Cost: clients that miss more
 * than MAX_SKIPPED_KEYS messages on a single chain will lose those messages.
 */
export const MAX_SKIPPED_KEYS = 50;

/**
 * Reject all-zero X25519 shared secrets. A peer ratchet public key (DHr) comes
 * straight off the wire and is never signed, so a malicious relay could swap it
 * for a low-order point and force a known DH output. Throwing here aborts the
 * ratchet step before any chain key is derived from a degenerate secret.
 */
function assertNonZeroDH(dh: Uint8Array): Uint8Array {
  let acc = 0;
  for (let i = 0; i < dh.length; i++) acc |= dh[i];
  if (acc === 0) throw new Error('Ratchet: all-zero DH output — low-order point attack');
  return dh;
}

/** Zero a message key buffer in place so it doesn't linger in memory. */
function zeroize(buf: Uint8Array): void {
  for (let i = 0; i < buf.length; i++) buf[i] = 0;
}

/**
 * Parse a skipped-key map entry. Keys are of the form `${pubB64}:${n}`.
 * Returns the integer `n` or NaN if the key isn't well-formed.
 */
function parseSkippedN(mapKey: string): number {
  const idx = mapKey.lastIndexOf(':');
  if (idx < 0) return NaN;
  const n = parseInt(mapKey.slice(idx + 1), 10);
  return Number.isFinite(n) ? n : NaN;
}

/**
 * Enforce MAX_SKIPPED_KEYS by evicting the lowest message numbers first.
 * The first map entry inserted is, by JS spec, the oldest, but we order by
 * the parsed `n` to be robust against insertion order changes after revival.
 * Evicted message keys are zeroized before deletion.
 */
function enforceSkippedKeyLimit(state: RatchetState): void {
  if (state.MKSKIPPED.size <= MAX_SKIPPED_KEYS) return;
  const entries: Array<{ key: string; n: number }> = [];
  for (const k of state.MKSKIPPED.keys()) {
    entries.push({ key: k, n: parseSkippedN(k) });
  }
  entries.sort((a, b) => a.n - b.n);
  const toEvict = state.MKSKIPPED.size - MAX_SKIPPED_KEYS;
  for (let i = 0; i < toEvict; i++) {
    const ev = entries[i];
    const mk = state.MKSKIPPED.get(ev.key);
    if (mk) zeroize(mk);
    state.MKSKIPPED.delete(ev.key);
  }
}

/**
 * Drop any skipped keys whose message number is older than `state.Nr - maxAge`.
 * Use this to actively shrink the FS window past inactivity, e.g. on app
 * background or on schedule. Zeroizes evicted keys.
 */
export function trimOldSkippedKeys(state: RatchetState, maxAge: number): void {
  if (maxAge < 0) return;
  const cutoff = state.Nr - maxAge;
  for (const [k, mk] of state.MKSKIPPED) {
    const n = parseSkippedN(k);
    if (Number.isFinite(n) && n < cutoff) {
      zeroize(mk);
      state.MKSKIPPED.delete(k);
    }
  }
}

/** Byte-wise equality — React Native has no Buffer global to call Buffer.compare. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  // Constant-time: no early return on first mismatch. (Golden rule #8.)
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function kdfRoot(rk: Uint8Array, dhOut: Uint8Array): { newRK: Uint8Array; newCK: Uint8Array } {
  // HKDF with RK as salt and dhOut as IKM
  const derived = hkdfSHA256(dhOut, rk, ROOT_INFO, 64);
  const newRK = derived.slice(0, 32);
  const newCK = derived.slice(32, 64);
  zeroize(derived);
  return { newRK, newCK };
}

function kdfChain(ck: Uint8Array): { newCK: Uint8Array; messageKey: Uint8Array } {
  // HMAC-SHA256 based KDF for chains
  const messageKey = hmacSHA256(ck, MESSAGE_KEY_CONSTANT);
  const newCK = hmacSHA256(ck, CHAIN_KEY_CONSTANT);
  return { newCK, messageKey };
}

export function initRatchet(
  rootKey: Uint8Array,
  contactDHPublicKey: Uint8Array,
  isAlice: boolean,
  initialDHs?: { publicKey: Uint8Array; secretKey: Uint8Array }
): RatchetState {
  // Bob (receiver) MUST start with his SPK pair as DHs so that the first
  // dhRatchet step matches Alice's: DH(bobSPK.sec, alice.DHs.pub) ==
  // DH(alice.DHs.sec, bobSPK.pub). A random pair breaks key agreement.
  // We defensively copy initialDHs so that zeroizing it later doesn't wipe the caller's shared SPK.
  const dhPair = initialDHs
    ? { publicKey: new Uint8Array(initialDHs.publicKey), secretKey: new Uint8Array(initialDHs.secretKey) }
    : nacl.box.keyPair();
  const state: RatchetState = {
    DHs: dhPair,
    DHr: isAlice ? contactDHPublicKey : null,
    RK: rootKey,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
    createdAtMs: Date.now(),
  };

  if (isAlice) {
    // Alice sends the first message, she needs to do the first DH ratchet step immediately
    const dhOut = assertNonZeroDH(nacl.scalarMult(dhPair.secretKey, contactDHPublicKey));
    const { newRK, newCK } = kdfRoot(rootKey, dhOut);
    state.RK = newRK;
    state.CKs = newCK;
    zeroize(dhOut);
  }
  return state;
}

export function ratchetEncrypt(state: RatchetState, plaintext: Uint8Array): {
  ciphertext: Uint8Array;
  nonce: Uint8Array;
  header: { ratchetKey: Uint8Array; n: number; pn: number };
} {
  if (!state.CKs) {
    throw new Error('Cannot encrypt without a sender chain key');
  }

  const { newCK, messageKey } = kdfChain(state.CKs);
  const oldCKs = state.CKs;
  state.CKs = newCK;
  zeroize(oldCKs);

  // Encrypt with messageKey (XSalsa20-Poly1305 via tweetnacl.secretbox)
  // Message key is 32 bytes
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, messageKey);

  const header = {
    ratchetKey: state.DHs.publicKey,
    n: state.Ns,
    pn: state.PN,
  };

  state.Ns += 1;

  zeroize(messageKey);

  return { ciphertext, nonce, header };
}

function trySkipMessageKeys(state: RatchetState, untilN: number) {
  // Hard cap: never skip past MAX_SKIPPED_KEYS messages in a single jump,
  // even if the receiver buffer has room. Limits attacker-induced key growth.
  if (state.Nr + MAX_SKIPPED_KEYS < untilN) {
    throw new Error('Too many skipped messages');
  }
  while (state.Nr < untilN) {
    if (!state.CKr) throw new Error('Cannot skip messages without receiver chain key');
    const { newCK, messageKey } = kdfChain(state.CKr);
    const oldCKr = state.CKr;
    state.CKr = newCK;
    zeroize(oldCKr);
    // Store skipped message key — base64 via tweetnacl-util (no Buffer in RN)
    const mkKey = encodeBase64(state.DHr!) + ':' + state.Nr;
    state.MKSKIPPED.set(mkKey, messageKey);
    state.Nr += 1;
  }
  // Evict oldest entries if we are over the cap (e.g. multiple skip batches).
  enforceSkippedKeyLimit(state);
}

function dhRatchet(state: RatchetState, header: { ratchetKey: Uint8Array; pn: number }) {
  // Validate the incoming ratchet key produces a sound DH BEFORE mutating any
  // counters/keys, so a low-order-point header cannot corrupt the live state.
  const dhOut1 = assertNonZeroDH(nacl.scalarMult(state.DHs.secretKey, header.ratchetKey));

  state.PN = state.Ns;
  state.Ns = 0;
  state.Nr = 0;
  state.DHr = header.ratchetKey;

  // Step 1: use the pre-validated DH to derive CKr
  const { newRK: rk1, newCK: ckr } = kdfRoot(state.RK, dhOut1);
  const oldRK1 = state.RK;
  const oldCKr = state.CKr;
  state.RK = rk1;
  state.CKr = ckr;
  zeroize(oldRK1);
  if (oldCKr) zeroize(oldCKr);
  zeroize(dhOut1);

  // Step 2: Generate a new DH pair for ourselves
  const oldDHs = state.DHs;
  state.DHs = nacl.box.keyPair();
  zeroize(oldDHs.secretKey);

  // Step 3: DH using our NEW DHs and the DHr to derive CKs
  const dhOut2 = assertNonZeroDH(nacl.scalarMult(state.DHs.secretKey, state.DHr));
  const { newRK: rk2, newCK: cks } = kdfRoot(state.RK, dhOut2);
  const oldRK2 = state.RK;
  const oldCKs = state.CKs;
  state.RK = rk2;
  state.CKs = cks;
  zeroize(oldRK2);
  if (oldCKs) zeroize(oldCKs);
  zeroize(dhOut2);
}

/**
 * Deep-copy a RatchetState so decryption can run speculatively and only be
 * committed if the message authenticates. Copies every Uint8Array and the
 * skipped-key Map so mutations on the clone never touch the live state.
 */
function cloneState(state: RatchetState): RatchetState {
  const skipped = new Map<string, Uint8Array>();
  for (const [k, v] of state.MKSKIPPED) skipped.set(k, new Uint8Array(v));
  return {
    DHs: {
      publicKey: new Uint8Array(state.DHs.publicKey),
      secretKey: new Uint8Array(state.DHs.secretKey),
    },
    DHr: state.DHr ? new Uint8Array(state.DHr) : null,
    RK: new Uint8Array(state.RK),
    CKs: state.CKs ? new Uint8Array(state.CKs) : null,
    CKr: state.CKr ? new Uint8Array(state.CKr) : null,
    Ns: state.Ns,
    Nr: state.Nr,
    PN: state.PN,
    MKSKIPPED: skipped,
    x3dhInit: state.x3dhInit,
    createdAtMs: state.createdAtMs,
  };
}

/**
 * Copy every field of `src` into `dst` in place, zeroizing the byte buffers
 * that `dst` previously held so no key material lingers. Used to atomically
 * commit a speculative decryption back onto the live ratchet state.
 */
function commitState(dst: RatchetState, src: RatchetState): void {
  zeroize(dst.DHs.secretKey);
  if (dst.CKs) zeroize(dst.CKs);
  if (dst.CKr) zeroize(dst.CKr);
  zeroize(dst.RK);
  for (const v of dst.MKSKIPPED.values()) zeroize(v);

  dst.DHs = src.DHs;
  dst.DHr = src.DHr;
  dst.RK = src.RK;
  dst.CKs = src.CKs;
  dst.CKr = src.CKr;
  dst.Ns = src.Ns;
  dst.Nr = src.Nr;
  dst.PN = src.PN;
  dst.MKSKIPPED = src.MKSKIPPED;
  dst.x3dhInit = src.x3dhInit;
  dst.createdAtMs = src.createdAtMs;
}

/** Zeroize all key material held by a discarded speculative clone. */
function discardState(s: RatchetState): void {
  zeroize(s.DHs.secretKey);
  if (s.CKs) zeroize(s.CKs);
  if (s.CKr) zeroize(s.CKr);
  zeroize(s.RK);
  for (const v of s.MKSKIPPED.values()) zeroize(v);
}

export function ratchetDecrypt(
  state: RatchetState,
  header: { ratchetKey: Uint8Array; n: number; pn: number },
  ciphertext: Uint8Array,
  nonce: Uint8Array
): Uint8Array | null {
  // Check skipped message keys. Only consume the stored key if the message
  // actually authenticates — a forged ciphertext must not burn a real key.
  const mkKey = encodeBase64(header.ratchetKey) + ':' + header.n;
  if (state.MKSKIPPED.has(mkKey)) {
    const mk = state.MKSKIPPED.get(mkKey)!;
    const pt = nacl.secretbox.open(ciphertext, nonce, mk);
    if (pt) {
      // Authenticated: consume and wipe the key (it must never be reused).
      state.MKSKIPPED.delete(mkKey);
      zeroize(mk);
    }
    // On MAC failure leave the skipped key in place; a later genuine message
    // for this (DH, n) can still be decrypted. Returns null for the forgery.
    return pt;
  }

  // Transactional ratchet advance: run the (possibly DH-ratcheting) state
  // mutation on a CLONE, attempt to authenticate, and only commit back to the
  // live state if decryption succeeds. This prevents a malicious relay from
  // desynchronising the ratchet by injecting a message with a valid-looking
  // header but a forged ciphertext (Signal Double Ratchet spec §3.4).
  const work = cloneState(state);

  let plaintext: Uint8Array | null = null;
  try {
    if (!work.DHr || !bytesEqual(header.ratchetKey, work.DHr)) {
      trySkipMessageKeys(work, header.pn);
      dhRatchet(work, header);
    }

    trySkipMessageKeys(work, header.n);

    if (!work.CKr) throw new Error('No receiver chain key');
    const { newCK, messageKey } = kdfChain(work.CKr);
    const oldCKr = work.CKr;
    work.CKr = newCK;
    zeroize(oldCKr);
    work.Nr += 1;

    try {
      plaintext = nacl.secretbox.open(ciphertext, nonce, messageKey);
    } finally {
      // Wipe message key right after secretbox.open — it must never be reused.
      zeroize(messageKey);
    }
  } catch (e) {
    discardState(work);
    throw e;
  }

  if (plaintext) {
    commitState(state, work); // authenticated → adopt the advanced ratchet
  } else {
    discardState(work); // forged/corrupt → live state is untouched
  }
  return plaintext;
}
