import { nacl } from './sodium';
import { vault, type VaultKey } from './sodium/vault';
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
  /** Federation F3b: first-contact bootstrap block (see FirstContactBlock). */
  fc?: FirstContactBlock;
  [key: string]: unknown;
}

/** Federation F3b — parity with mobile/src/crypto/messaging.ts FirstContactBlock. */
export interface FirstContactBlock {
  ik: string;
  relay: string | null;
  root: string;
}

const PROTOCOL_VERSION = 2;

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
  mySecretKey: VaultKey,
  ratchetState: RatchetState
): { envelope: EncryptedEnvelope; newState: RatchetState } {
  const payloadBytes = decodeUTF8(plaintext);
  const ratchetOut = ratchetEncrypt(ratchetState, payloadBytes);

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

  const innerBytes = stripAndPad(innerPayload);

  const outerNonce = nacl.randomBytes(nacl.box.nonceLength);
  const outerCiphertext = vault.box(mySecretKey, innerBytes, outerNonce, recipientPublicKey);

  const newState = { ...ratchetState };
  delete newState.x3dhInit;

  return {
    envelope: {
      ciphertextB64: encodeBase64(outerCiphertext),
      nonceB64: encodeBase64(outerNonce),
    },
    newState,
  };
}

export function openEnvelope(
  envelope: EncryptedEnvelope,
  senderPublicKey: Uint8Array,
  mySecretKey: VaultKey
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

  const opened = vault.boxOpen(mySecretKey, ciphertext, nonce, senderPublicKey);
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
  mySecretKey: VaultKey,
  ratchetState: RatchetState
): DecryptedInner | null {
  const parsed = openEnvelope(envelope, senderPublicKey, mySecretKey);
  if (!parsed) return null;

  try {
    const rHeader = parseRatchetHeader(parsed.ratchet);
    const rCiphertext = decodeBase64(parsed.ratchet.ciphertextB64);
    const rNonce = decodeBase64(parsed.ratchet.nonceB64);

    const plaintextBytes = ratchetDecrypt(ratchetState, rHeader, rCiphertext, rNonce);
    if (!plaintextBytes) return null;

    return {
      from: parsed.from,
      body: encodeUTF8(plaintextBytes),
      newState: ratchetState,
    };
  } catch {
    return null;
  }
}

// ─── Sealed-sender v2 (Phase 1) ──────────────────────────────────────────────
// Byte-for-byte parity with mobile/src/crypto/messaging.ts. Same Double Ratchet
// inner; OUTER envelope is the per-message ephemeral sealed-sender box
// (crypto/sealedSender.ts) instead of the legacy static-key nacl.box. Same relay:
// ESTABLISHED sessions only. Across relays (federation F3b) v2 may also carry
// the X3DH init + a first-contact block. See docs/SEALED-SENDER-ARCHITECTURE.md §3.

export function encryptMessageV2(
  plaintext: string,
  senderAegisId: string,
  recipientPublicKey: Uint8Array,
  senderSigningSecretKey: VaultKey,
  ratchetState: RatchetState,
  nowMs: number,
  /** F3b: bootstrap a session across relays — includes x3dhInit + fc + spk. */
  firstContact?: { block: FirstContactBlock; senderSigningPublicKey: Uint8Array },
): { wire: SealedWire; newState: RatchetState } {
  const payloadBytes = decodeUTF8(plaintext);
  const ratchetOut = ratchetEncrypt(ratchetState, payloadBytes);

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

  if (firstContact) {
    if (ratchetState.x3dhInit) innerPayload.x3dh = ratchetState.x3dhInit;
    innerPayload.fc = firstContact.block;
  }

  const innerBytes = stripAndPad(innerPayload);
  const wire = sealEnvelope(
    recipientPublicKey,
    senderAegisId,
    senderSigningSecretKey,
    encodeBase64(innerBytes),
    nowMs,
    firstContact?.senderSigningPublicKey,
  );

  const newState = { ...ratchetState };
  delete newState.x3dhInit;
  return { wire, newState };
}

export function openEnvelopeV2(
  wire: SealedWire,
  myBoxSecretKey: VaultKey,
  resolveSigningKey: (from: string) => Uint8Array | null,
  nowMs: number,
  /** F3b: accept a first-contact envelope from an unknown sender (TOFU). */
  opts: { allowFirstContact?: boolean } = {},
): (InnerPayload & { tofuSigningKeyB64?: string }) | null {
  const opened = openSealedEnvelope(wire, myBoxSecretKey, resolveSigningKey, nowMs, opts);
  if (!opened) return null;
  let parsed: InnerPayload | null;
  try {
    parsed = unpad(decodeBase64(opened.payload)) as InnerPayload | null;
  } catch {
    return null;
  }
  if (!parsed || parsed.v !== PROTOCOL_VERSION) return null;
  if (typeof parsed.from !== 'string' || !parsed.ratchet) return null;
  if (parsed.from !== opened.from) return null;
  if (opened.tofuSigningKeyB64) {
    // TOFU is acceptable ONLY as a bootstrap: x3dh init + well-formed fc block.
    const fc = parsed.fc;
    if (!parsed.x3dh || !fc || typeof fc.ik !== 'string' || typeof fc.root !== 'string' || (fc.relay !== null && typeof fc.relay !== 'string')) return null;
    return { ...parsed, tofuSigningKeyB64: opened.tofuSigningKeyB64 };
  }
  return parsed;
}

export function decryptMessageV2(
  wire: SealedWire,
  myBoxSecretKey: VaultKey,
  resolveSigningKey: (from: string) => Uint8Array | null,
  ratchetState: RatchetState,
  nowMs: number,
): DecryptedInner | null {
  const parsed = openEnvelopeV2(wire, myBoxSecretKey, resolveSigningKey, nowMs);
  if (!parsed) return null;

  try {
    const rHeader = parseRatchetHeader(parsed.ratchet);
    const plaintextBytes = ratchetDecrypt(
      ratchetState,
      rHeader,
      decodeBase64(parsed.ratchet.ciphertextB64),
      decodeBase64(parsed.ratchet.nonceB64),
    );
    if (!plaintextBytes) return null;
    return { from: parsed.from, body: encodeUTF8(plaintextBytes), newState: ratchetState };
  } catch {
    return null;
  }
}
