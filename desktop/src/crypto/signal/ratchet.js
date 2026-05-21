import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { hkdfSHA256, hmacSHA256 } from './kdf.js';

const ROOT_INFO = new TextEncoder().encode('AegisLinkRoot');
const MESSAGE_KEY_CONSTANT = new Uint8Array([0x01]);
const CHAIN_KEY_CONSTANT = new Uint8Array([0x02]);

export const MAX_SKIPPED_KEYS = 50;

function zeroize(buf) {
  if (!buf) return;
  for (let i = 0; i < buf.length; i++) buf[i] = 0;
}

function parseSkippedN(mapKey) {
  const idx = mapKey.lastIndexOf(':');
  if (idx < 0) return NaN;
  const n = parseInt(mapKey.slice(idx + 1), 10);
  return Number.isFinite(n) ? n : NaN;
}

function enforceSkippedKeyLimit(state) {
  if (state.MKSKIPPED.size <= MAX_SKIPPED_KEYS) return;
  const entries = [];
  for (const k of state.MKSKIPPED.keys()) entries.push({ key: k, n: parseSkippedN(k) });
  entries.sort((a, b) => a.n - b.n);
  const toEvict = state.MKSKIPPED.size - MAX_SKIPPED_KEYS;
  for (let i = 0; i < toEvict; i++) {
    const mk = state.MKSKIPPED.get(entries[i].key);
    zeroize(mk);
    state.MKSKIPPED.delete(entries[i].key);
  }
}

export function trimOldSkippedKeys(state, maxAge) {
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

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function kdfRoot(rk, dhOut) {
  const derived = hkdfSHA256(dhOut, rk, ROOT_INFO, 64);
  const newRK = derived.slice(0, 32);
  const newCK = derived.slice(32, 64);
  zeroize(derived);
  return { newRK, newCK };
}

function kdfChain(ck) {
  const messageKey = hmacSHA256(ck, MESSAGE_KEY_CONSTANT);
  const newCK = hmacSHA256(ck, CHAIN_KEY_CONSTANT);
  return { newCK, messageKey };
}

export function initRatchet(rootKey, contactDHPublicKey, isAlice, initialDHs) {
  const dhPair = initialDHs
    ? { publicKey: new Uint8Array(initialDHs.publicKey), secretKey: new Uint8Array(initialDHs.secretKey) }
    : nacl.box.keyPair();
  const state = {
    DHs: dhPair,
    DHr: isAlice ? contactDHPublicKey : null,
    RK: rootKey,
    CKs: null,
    CKr: null,
    Ns: 0,
    Nr: 0,
    PN: 0,
    MKSKIPPED: new Map(),
  };
  if (isAlice) {
    const dhOut = nacl.scalarMult(dhPair.secretKey, contactDHPublicKey);
    const { newRK, newCK } = kdfRoot(rootKey, dhOut);
    state.RK = newRK;
    state.CKs = newCK;
    zeroize(dhOut);
  }
  return state;
}

export function encryptRatchet(state, plaintext) {
  if (!state.CKs) throw new Error('Cannot encrypt without a sender chain key');
  const { newCK, messageKey } = kdfChain(state.CKs);
  const oldCKs = state.CKs;
  state.CKs = newCK;
  zeroize(oldCKs);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ciphertext = nacl.secretbox(plaintext, nonce, messageKey);
  const header = { ratchetKey: state.DHs.publicKey, n: state.Ns, pn: state.PN };
  state.Ns += 1;
  zeroize(messageKey);
  return { ciphertext, nonce, header };
}

// Mobile-name alias for backward parity with the mobile API surface.
export const ratchetEncrypt = encryptRatchet;

function trySkipMessageKeys(state, untilN) {
  if (state.Nr + MAX_SKIPPED_KEYS < untilN) throw new Error('Too many skipped messages');
  while (state.Nr < untilN) {
    if (!state.CKr) throw new Error('Cannot skip messages without receiver chain key');
    const { newCK, messageKey } = kdfChain(state.CKr);
    const oldCKr = state.CKr;
    state.CKr = newCK;
    zeroize(oldCKr);
    const mkKey = encodeBase64(state.DHr) + ':' + state.Nr;
    state.MKSKIPPED.set(mkKey, messageKey);
    state.Nr += 1;
  }
  enforceSkippedKeyLimit(state);
}

function dhRatchet(state, header) {
  state.PN = state.Ns;
  state.Ns = 0;
  state.Nr = 0;
  state.DHr = header.ratchetKey;
  const dhOut1 = nacl.scalarMult(state.DHs.secretKey, state.DHr);
  const { newRK: rk1, newCK: ckr } = kdfRoot(state.RK, dhOut1);
  const oldRK1 = state.RK;
  const oldCKr = state.CKr;
  state.RK = rk1;
  state.CKr = ckr;
  zeroize(oldRK1);
  if (oldCKr) zeroize(oldCKr);
  zeroize(dhOut1);

  const oldDHs = state.DHs;
  state.DHs = nacl.box.keyPair();
  zeroize(oldDHs.secretKey);

  const dhOut2 = nacl.scalarMult(state.DHs.secretKey, state.DHr);
  const { newRK: rk2, newCK: cks } = kdfRoot(state.RK, dhOut2);
  const oldRK2 = state.RK;
  const oldCKs = state.CKs;
  state.RK = rk2;
  state.CKs = cks;
  zeroize(oldRK2);
  if (oldCKs) zeroize(oldCKs);
  zeroize(dhOut2);
}

export function decryptRatchet(state, header, ciphertext, nonce) {
  const mkKey = encodeBase64(header.ratchetKey) + ':' + header.n;
  if (state.MKSKIPPED.has(mkKey)) {
    const mk = state.MKSKIPPED.get(mkKey);
    state.MKSKIPPED.delete(mkKey);
    let pt;
    try {
      pt = nacl.secretbox.open(ciphertext, nonce, mk);
    } finally {
      zeroize(mk);
    }
    return pt;
  }
  if (!state.DHr || !bytesEqual(header.ratchetKey, state.DHr)) {
    trySkipMessageKeys(state, header.pn);
    dhRatchet(state, header);
  }
  trySkipMessageKeys(state, header.n);
  if (!state.CKr) throw new Error('No receiver chain key');
  const { newCK, messageKey } = kdfChain(state.CKr);
  const oldCKr = state.CKr;
  state.CKr = newCK;
  zeroize(oldCKr);
  state.Nr += 1;
  let plaintext;
  try {
    plaintext = nacl.secretbox.open(ciphertext, nonce, messageKey);
  } finally {
    zeroize(messageKey);
  }
  return plaintext;
}

// Mobile-name alias.
export const ratchetDecrypt = decryptRatchet;
