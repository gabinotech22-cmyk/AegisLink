/**
 * AegisLink — Sealed call session (sealed-sender Phase 2, desktop)
 *
 * Byte-for-byte parity with mobile/src/crypto/callSession.ts (rule #5). Hides the
 * caller's identity from the relay for 1:1 call signaling: the relay stops
 * stamping `from`; the sender's identity travels sealed and authenticated INSIDE
 * the call:invite, exactly like envelope:v2 (docs/SEALED-SENDER-ARCHITECTURE §5,
 * Fase 2).
 *
 * Cost model (Fase 0 finding): a fresh per-MESSAGE asymmetric seal is too
 * expensive for ICE trickle. Mitigation: ONE sealed-sender handshake per call
 * carries a random symmetric session key `callKey`; every later signaling message
 * (answer, ICE) is sealed with `nacl.secretbox` under that key.
 *
 *   call:invite  → sealEnvelope({ offer, k: callKey })   (asymmetric, once)
 *   call:answer  → secretbox(answer, callKey)             (symmetric)
 *   call:ice     → secretbox(candidate, callKey)          (symmetric)
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { sealEnvelope, openEnvelope, type SealedWire } from './sealedSender';

/** Bumped if the inner call-handshake JSON shape changes. */
export const CALL_SESSION_VERSION = 1;

/** Result of sealing a call invite: the wire (no `from`) plus the session key. */
export interface SealedCallInvite {
  /** Sealed-sender wire object (ciphertext/nonce/epk) — carries NO sender id. */
  wire: SealedWire;
  /** 32-byte symmetric key (raw) securing the rest of this call's signaling. */
  callKey: Uint8Array;
}

/** Authenticated result of opening a call invite. */
export interface OpenedCallInvite {
  /** Caller aegisId, recovered from inside the sealed payload and authenticated. */
  from: string;
  /** The sealed SDP offer (opaque string the caller put in). */
  offer: string;
  /** Symmetric session key for the rest of this call's signaling. */
  callKey: Uint8Array;
  /** Inner timestamp (ms) the caller stamped. */
  ts: number;
}

interface CallHandshakeInner {
  v: number;
  /** The application's sealed SDP offer payload (opaque to this layer). */
  offer: string;
  /** Base64 random 32-byte call session key. */
  k: string;
}

/**
 * Seal a call invite for `recipientBoxPublicKey`. Generates a fresh random
 * session key, embeds it with the offer, and authenticates the caller via the
 * Phase 1 sealed-sender construction (ephemeral box + inner Ed25519 signature).
 */
export function sealCallInvite(
  recipientBoxPublicKey: Uint8Array,
  callerAegisId: string,
  callerSigningSecretKey: Uint8Array,
  offer: string,
  nowMs: number,
): SealedCallInvite {
  const callKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const inner: CallHandshakeInner = {
    v: CALL_SESSION_VERSION,
    offer,
    k: encodeBase64(callKey),
  };
  const wire = sealEnvelope(
    recipientBoxPublicKey,
    callerAegisId,
    callerSigningSecretKey,
    JSON.stringify(inner),
    nowMs,
  );
  return { wire, callKey };
}

/**
 * Open and authenticate a call invite. Mirrors `openEnvelope`: opens with our
 * box secret + the per-message epk (no need to know the sender first), then
 * verifies the inner Ed25519 signature against the claimed `from`.
 *
 * @returns the authenticated invite or null on ANY failure.
 */
export function openCallInvite(
  wire: SealedWire,
  myBoxSecretKey: Uint8Array,
  resolveSigningKey: (from: string) => Uint8Array | null,
  nowMs: number,
): OpenedCallInvite | null {
  const opened = openEnvelope(wire, myBoxSecretKey, resolveSigningKey, nowMs);
  if (!opened) return null;

  let inner: CallHandshakeInner;
  try {
    inner = JSON.parse(opened.payload) as CallHandshakeInner;
  } catch {
    return null;
  }
  if (inner.v !== CALL_SESSION_VERSION) return null;
  if (typeof inner.offer !== 'string' || typeof inner.k !== 'string') return null;

  let callKey: Uint8Array;
  try {
    callKey = decodeBase64(inner.k);
  } catch {
    return null;
  }
  if (callKey.length !== nacl.secretbox.keyLength) return null;

  return { from: opened.from, offer: inner.offer, callKey, ts: opened.ts };
}

/** Sealed symmetric wire for post-handshake signaling (answer / ICE). */
export interface CallKeyWire {
  /** Base64 secretbox ciphertext. */
  ciphertext: string;
  /** Base64 24-byte nonce. */
  nonce: string;
}

/**
 * Seal a post-handshake signaling message (SDP answer, ICE candidate) under the
 * call session key. Fast symmetric crypto — safe for high-frequency ICE trickle.
 */
export function sealWithCallKey(callKey: Uint8Array, plaintext: string): CallKeyWire {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(new TextEncoder().encode(plaintext), nonce, callKey);
  return { ciphertext: encodeBase64(ct), nonce: encodeBase64(nonce) };
}

/** Open a post-handshake signaling message. Returns null on tamper / bad key. */
export function openWithCallKey(callKey: Uint8Array, wire: CallKeyWire): string | null {
  let ct: Uint8Array;
  let nonce: Uint8Array;
  try {
    ct = decodeBase64(wire.ciphertext);
    nonce = decodeBase64(wire.nonce);
  } catch {
    return null;
  }
  if (nonce.length !== nacl.secretbox.nonceLength) return null;
  const opened = nacl.secretbox.open(ct, nonce, callKey);
  if (!opened) return null;
  return new TextDecoder().decode(opened);
}
