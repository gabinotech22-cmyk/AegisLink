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

/**
 * Federation F3b — what a FIRST sealed message carries so a recipient who has
 * never heard of us can establish the session and reach us back:
 *   ik    our X25519 identity key (base64) — X3DH binds the session to it and
 *         `keyMatchesAegisId(ik, from)` binds it to the claimed id;
 *   relay the onion of our home relay (null = official) — where our mailbox lives;
 *   root  our mailbox root (base64) — lets them derive our rotating mailbox id.
 * The signing key rides in the sealed-sender layer (`spk`), not here.
 */
export interface FirstContactBlock {
  ik: string;
  relay: string | null;
  root: string;
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
  mySecretKey: VaultKey,
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
  const outerCiphertext = vault.box(mySecretKey, innerBytes, outerNonce, recipientPublicKey);

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
// sender's static X25519 key. Between contacts on the same relay v2 is for
// ESTABLISHED sessions (first contact bootstraps over v1). Across relays there
// is no v1, so v2 may also carry the X3DH init plus a first-contact block
// (federation F3b) when the caller passes `firstContact`.

/**
 * Encrypt for an established contact using the sealed-sender v2 outer envelope.
 * @param senderSigningSecretKey the sender's Ed25519 identity key (vault handle; signs the
 *        sealed inner so the recipient can authenticate `from`).
 * @param nowMs current time (ms) stamped inside the sealed envelope.
 */
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

  // Inner is identical to v1; x3dh rides along ONLY on a first-contact message.
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

  // Pad to a fixed bucket BEFORE sealing — wire length must not leak size.
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
  // The authenticated sealed `from` MUST match the inner claim.
  if (parsed.from !== opened.from) return null;
  if (opened.tofuSigningKeyB64) {
    // A TOFU-authenticated envelope is only acceptable as a BOOTSTRAP: it must
    // carry the x3dh init and a well-formed first-contact block. Anything else
    // from an unknown sender stays rejected.
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
