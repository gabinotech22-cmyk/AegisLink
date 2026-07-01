import nacl from 'tweetnacl';
import { decodeUTF8, encodeUTF8, decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { ratchetEncrypt, ratchetDecrypt, type RatchetState } from './signal/ratchet';
import { stripAndPad, unpad } from './metadata';
import { sealEnvelope, openEnvelope as openSealedEnvelope, type SealedWire } from './sealedSender';

export interface InnerRatchet {
  ratchetKeyB64: string;
  n: number;
  pn: number;
  ciphertextB64: string;
  nonceB64: string;
  // Hybrid PQ ratchet (R1): present only on the first message of a NEW
  // sending chain (Ns === 0) on a session that has ML-KEM-768 material. See
  // ratchetEncrypt/dhRatchet in signal/ratchet.ts. Absent ⇒ classic v1 chain
  // turn or the session predates R1.
  pqPubB64?: string;
  pqCtB64?: string;
}

/**
 * Rebuild a ratchet header from its wire form. SINGLE point of truth — every
 * decrypt path (v1, v2, and the socket client's init-adoption path) MUST use
 * this. A hand-rolled copy that forgets pqPubB64/pqCtB64 makes a hybrid
 * receiver reject the first chain-turn message as a downgrade attack
 * ("missing PQ material on hybrid session") and no fresh v2 session can ever
 * be established.
 */
export function parseRatchetHeader(r: InnerRatchet): {
  ratchetKey: Uint8Array; n: number; pn: number; pqPub?: Uint8Array; pqCt?: Uint8Array;
} {
  return {
    ratchetKey: decodeBase64(r.ratchetKeyB64),
    n: r.n,
    pn: r.pn,
    ...(r.pqPubB64 ? { pqPub: decodeBase64(r.pqPubB64) } : {}),
    ...(r.pqCtB64 ? { pqCt: decodeBase64(r.pqCtB64) } : {}),
  };
}

interface InnerPayload {
  v: number;
  from: string;
  ratchet: InnerRatchet;
  x3dh?: Record<string, unknown>;
  [key: string]: unknown;
}

const PROTOCOL_VERSION = 2; // Upgraded to V2 for Signal Protocol

export interface EncryptedEnvelope {
  ciphertextB64: string;
  nonceB64: string;
}

export interface DecryptedInner {
  from: string;
  body: string;
  newState: RatchetState;
}

export function encryptMessage(
  plaintext: string,
  senderAegisId: string,
  recipientPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
  ratchetState: RatchetState
): { envelope: EncryptedEnvelope; newState: RatchetState } {
  // 1. Encrypt via Double Ratchet
  const payloadBytes = decodeUTF8(plaintext);
  const ratchetOut = ratchetEncrypt(ratchetState, payloadBytes);

  // 2. Wrap in Sealed Sender envelope
  const innerPayload: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    from: senderAegisId,
    ratchet: {
      ratchetKeyB64: encodeBase64(ratchetOut.header.ratchetKey),
      n: ratchetOut.header.n,
      pn: ratchetOut.header.pn,
      ciphertextB64: encodeBase64(ratchetOut.ciphertext),
      nonceB64: encodeBase64(ratchetOut.nonce),
      ...(ratchetOut.header.pqPub ? { pqPubB64: encodeBase64(ratchetOut.header.pqPub) } : {}),
      ...(ratchetOut.header.pqCt ? { pqCtB64: encodeBase64(ratchetOut.header.pqCt) } : {}),
    },
  };

  if (ratchetState.x3dhInit) {
    innerPayload.x3dh = ratchetState.x3dhInit;
  }

  // Pad to fixed bucket BEFORE encryption — wire length must not leak plaintext size.
  const innerBytes = stripAndPad(innerPayload);

  const outerNonce = nacl.randomBytes(nacl.box.nonceLength);
  const outerCiphertext = nacl.box(innerBytes, outerNonce, recipientPublicKey, mySecretKey);

  const newState = { ...ratchetState };
  delete newState.x3dhInit;

  return {
    envelope: {
      ciphertextB64: encodeBase64(outerCiphertext),
      nonceB64: encodeBase64(outerNonce),
    },
    newState
  };
}

export function openEnvelope(
  envelope: EncryptedEnvelope,
  senderPublicKey: Uint8Array,
  mySecretKey: Uint8Array
): InnerPayload | null {
  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
  try {
    ciphertext = decodeBase64(envelope.ciphertextB64);
    nonce = decodeBase64(envelope.nonceB64);
  } catch {
    return null;
  }
  if (nonce.length !== nacl.box.nonceLength) return null;

  const opened = nacl.box.open(ciphertext, nonce, senderPublicKey, mySecretKey);
  if (!opened) return null;

  const parsed = unpad(opened);
  if (!parsed) return null;
  if (parsed.v !== PROTOCOL_VERSION) return null;
  if (typeof parsed.from !== 'string' || !parsed.ratchet) return null;
  return parsed as InnerPayload;
}

export function tryDecryptMessage(
  envelope: EncryptedEnvelope,
  senderPublicKey: Uint8Array,
  mySecretKey: Uint8Array,
  ratchetState: RatchetState
): DecryptedInner | null {
  const parsed = openEnvelope(envelope, senderPublicKey, mySecretKey);
  if (!parsed) return null;

  // Work on a clone so a failed/throwing ratchetDecrypt cannot leave the
  // caller's live RatchetState half-advanced (chain key rotated but message
  // rejected). Only the cloned, successfully-advanced state is returned; the
  // caller must persist `newState` and discard the original.
  const working = cloneRatchetState(ratchetState);

  try {
    // 2. Decrypt Inner Double Ratchet payload
    const rHeader = parseRatchetHeader(parsed.ratchet);
    const rCiphertext = decodeBase64(parsed.ratchet.ciphertextB64);
    const rNonce = decodeBase64(parsed.ratchet.nonceB64);

    const plaintextBytes = ratchetDecrypt(working, rHeader, rCiphertext, rNonce);
    if (!plaintextBytes) return null;

    return {
      from: parsed.from,
      body: encodeUTF8(plaintextBytes),
      newState: working
    };
  } catch {
    return null;
  }
}

// ─── Sealed-sender v2 (Phase 1) ──────────────────────────────────────────────
//
// Same Double Ratchet inner as v1, but the OUTER envelope is the per-message
// ephemeral sealed-sender box (crypto/sealedSender.ts) instead of the legacy
// static-key nacl.box. The wire carries no `from` and is unlinkable to the
// sender's static X25519 key. v2 is for ESTABLISHED sessions only — it never
// carries an x3dhInit (first contact bootstraps over v1), so the recipient must
// already hold the sender's signing key to authenticate.

/**
 * Encrypt for an established contact using the sealed-sender v2 outer envelope.
 * @param senderSigningSecretKey the sender's 64-byte Ed25519 secret (signs the
 *        sealed inner so the recipient can authenticate `from`).
 * @param nowMs current time (ms) stamped inside the sealed envelope.
 */
export function encryptMessageV2(
  plaintext: string,
  senderAegisId: string,
  recipientPublicKey: Uint8Array,
  senderSigningSecretKey: Uint8Array,
  ratchetState: RatchetState,
  nowMs: number,
): { wire: SealedWire; newState: RatchetState } {
  const payloadBytes = decodeUTF8(plaintext);
  const ratchetOut = ratchetEncrypt(ratchetState, payloadBytes);

  // Inner is identical to v1 minus x3dh (v2 never bootstraps a handshake).
  const innerPayload: Record<string, unknown> = {
    v: PROTOCOL_VERSION,
    from: senderAegisId,
    ratchet: {
      ratchetKeyB64: encodeBase64(ratchetOut.header.ratchetKey),
      n: ratchetOut.header.n,
      pn: ratchetOut.header.pn,
      ciphertextB64: encodeBase64(ratchetOut.ciphertext),
      nonceB64: encodeBase64(ratchetOut.nonce),
      ...(ratchetOut.header.pqPub ? { pqPubB64: encodeBase64(ratchetOut.header.pqPub) } : {}),
      ...(ratchetOut.header.pqCt ? { pqCtB64: encodeBase64(ratchetOut.header.pqCt) } : {}),
    },
  };

  // Pad to a fixed bucket BEFORE sealing — wire length must not leak size.
  const innerBytes = stripAndPad(innerPayload);
  const wire = sealEnvelope(
    recipientPublicKey,
    senderAegisId,
    senderSigningSecretKey,
    encodeBase64(innerBytes),
    nowMs,
  );

  const newState = { ...ratchetState };
  delete newState.x3dhInit;
  return { wire, newState };
}

/**
 * Open + decrypt a sealed-sender v2 envelope. Authenticates the sender via the
 * sealed signature (resolveSigningKey maps `from` → that contact's Ed25519
 * signing pubkey) and binds it to the inner `from` claim before ratcheting.
 * Returns null on ANY failure (caller falls back / drops).
 */
/**
 * Open ONLY the sealed-sender v2 OUTER envelope, returning the inner ratchet
 * payload (NOT yet ratchet-decrypted) — the analogue of v1 `openEnvelope`. Lets
 * the live receive path reuse the exact same downstream (`decryptAndAppend`:
 * session load, ratchet decrypt, glare/desync recovery, dispatch). Authenticates
 * the sender's signature and binds it to the inner `from` claim.
 */
export function openEnvelopeV2(
  wire: SealedWire,
  myBoxSecretKey: Uint8Array,
  resolveSigningKey: (from: string) => Uint8Array | null,
  nowMs: number,
): InnerPayload | null {
  const opened = openSealedEnvelope(wire, myBoxSecretKey, resolveSigningKey, nowMs);
  if (!opened) return null;
  let parsed: InnerPayload | null;
  try {
    parsed = unpad(decodeBase64(opened.payload)) as InnerPayload | null;
  } catch {
    return null;
  }
  if (!parsed || parsed.v !== PROTOCOL_VERSION) return null;
  if (typeof parsed.from !== 'string' || !parsed.ratchet) return null;
  // The authenticated sealed `from` MUST match the inner claim.
  if (parsed.from !== opened.from) return null;
  return parsed;
}

export function decryptMessageV2(
  wire: SealedWire,
  myBoxSecretKey: Uint8Array,
  resolveSigningKey: (from: string) => Uint8Array | null,
  ratchetState: RatchetState,
  nowMs: number,
): DecryptedInner | null {
  const parsed = openEnvelopeV2(wire, myBoxSecretKey, resolveSigningKey, nowMs);
  if (!parsed) return null;

  const working = cloneRatchetState(ratchetState);
  try {
    const rHeader = parseRatchetHeader(parsed.ratchet);
    const plaintextBytes = ratchetDecrypt(
      working,
      rHeader,
      decodeBase64(parsed.ratchet.ciphertextB64),
      decodeBase64(parsed.ratchet.nonceB64),
    );
    if (!plaintextBytes) return null;
    return { from: parsed.from, body: encodeUTF8(plaintextBytes), newState: working };
  } catch {
    return null;
  }
}

/** Deep-clone a RatchetState so mutation during trial decryption is isolated. */
function cloneRatchetState(s: RatchetState): RatchetState {
  const skipped = new Map<string, Uint8Array>();
  for (const [k, v] of s.MKSKIPPED) skipped.set(k, new Uint8Array(v));
  return {
    ...s,
    DHs: { publicKey: new Uint8Array(s.DHs.publicKey), secretKey: new Uint8Array(s.DHs.secretKey) },
    DHr: s.DHr ? new Uint8Array(s.DHr) : null,
    RK: new Uint8Array(s.RK),
    PQs: s.PQs
      ? { publicKey: new Uint8Array(s.PQs.publicKey), secretKey: new Uint8Array(s.PQs.secretKey) }
      : s.PQs,
    PQr: s.PQr ? new Uint8Array(s.PQr) : s.PQr,
    pqSendCt: s.pqSendCt ? new Uint8Array(s.pqSendCt) : s.pqSendCt,
    CKs: s.CKs ? new Uint8Array(s.CKs) : null,
    CKr: s.CKr ? new Uint8Array(s.CKr) : null,
    MKSKIPPED: skipped,
    x3dhInit: s.x3dhInit ? { ...s.x3dhInit } : undefined,
  };
}
