/**
 * AegisLink — Sealed-sender envelope (Phase 1, desktop)
 *
 * Verbatim port of mobile/src/crypto/sealedSender.ts and the server Phase 0
 * module. Kept byte-for-byte identical across platforms so all three share one
 * audited construction (golden rule #5 — parity). See
 * docs/SEALED-SENDER-ARCHITECTURE.md §3.
 *
 * Outer envelope layer for sealed-sender v2: seals under a PER-MESSAGE EPHEMERAL
 * keypair and authenticates the sender with an Ed25519 signature over the inner
 * payload. The wire carries NO sender identity (only { ciphertext, nonce, epk });
 * the relay never sees `from`. The recipient authenticates the sender by
 * verifying the inner signature against the signing key it already holds for
 * that contact (unknown sender → reject; first contact bootstraps over v1 X3DH).
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

/** Protocol version for the sealed inner payload. */
export const SEALED_SENDER_VERSION = 1;

/** Maximum clock skew tolerated on the inner `ts` (replay window guard). */
export const SEALED_TS_SKEW_MS = 60_000;

/** What travels on the wire. Contains NO sender identity. */
export interface SealedWire {
  ciphertext: string;
  nonce: string;
  epk: string;
}

/** The authenticated, decrypted result of opening a sealed envelope. */
export interface OpenedEnvelope {
  from: string;
  payload: string;
  ts: number;
}

interface SealedInner {
  v: number;
  from: string;
  payload: string;
  ts: number;
}

export function sealEnvelope(
  recipientBoxPublicKey: Uint8Array,
  senderAegisId: string,
  senderSigningSecretKey: Uint8Array,
  payload: string,
  nowMs: number,
): SealedWire {
  if (recipientBoxPublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error('sealEnvelope: invalid recipient public key length');
  }
  const inner: SealedInner = { v: SEALED_SENDER_VERSION, from: senderAegisId, payload, ts: nowMs };
  const innerBytes = new TextEncoder().encode(JSON.stringify(inner));

  const sig = nacl.sign.detached(innerBytes, senderSigningSecretKey);

  const sealedPlain = new TextEncoder().encode(
    JSON.stringify({ i: encodeBase64(innerBytes), s: encodeBase64(sig) }),
  );

  const ephemeral = nacl.box.keyPair();
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  try {
    const ciphertext = nacl.box(sealedPlain, nonce, recipientBoxPublicKey, ephemeral.secretKey);
    return {
      ciphertext: encodeBase64(ciphertext),
      nonce: encodeBase64(nonce),
      epk: encodeBase64(ephemeral.publicKey),
    };
  } finally {
    ephemeral.secretKey.fill(0);
  }
}

export function openEnvelope(
  wire: SealedWire,
  myBoxSecretKey: Uint8Array,
  resolveSigningKey: (from: string) => Uint8Array | null,
  nowMs: number,
): OpenedEnvelope | null {
  let ciphertext: Uint8Array;
  let nonce: Uint8Array;
  let epk: Uint8Array;
  try {
    ciphertext = decodeBase64(wire.ciphertext);
    nonce = decodeBase64(wire.nonce);
    epk = decodeBase64(wire.epk);
  } catch {
    return null;
  }
  if (nonce.length !== nacl.box.nonceLength) return null;
  if (epk.length !== nacl.box.publicKeyLength) return null;

  const sealedPlain = nacl.box.open(ciphertext, nonce, epk, myBoxSecretKey);
  if (!sealedPlain) return null;

  let outer: { i: string; s: string };
  try {
    outer = JSON.parse(new TextDecoder().decode(sealedPlain)) as { i: string; s: string };
  } catch {
    return null;
  }
  if (typeof outer.i !== 'string' || typeof outer.s !== 'string') return null;

  let innerBytes: Uint8Array;
  let sig: Uint8Array;
  try {
    innerBytes = decodeBase64(outer.i);
    sig = decodeBase64(outer.s);
  } catch {
    return null;
  }

  let inner: SealedInner;
  try {
    inner = JSON.parse(new TextDecoder().decode(innerBytes)) as SealedInner;
  } catch {
    return null;
  }
  if (inner.v !== SEALED_SENDER_VERSION) return null;
  if (typeof inner.from !== 'string' || typeof inner.payload !== 'string') return null;
  if (typeof inner.ts !== 'number') return null;

  if (Math.abs(nowMs - inner.ts) > SEALED_TS_SKEW_MS) return null;

  const signingPub = resolveSigningKey(inner.from);
  if (!signingPub || signingPub.length !== nacl.sign.publicKeyLength) return null;
  if (!nacl.sign.detached.verify(innerBytes, sig, signingPub)) return null;

  return { from: inner.from, payload: inner.payload, ts: inner.ts };
}
