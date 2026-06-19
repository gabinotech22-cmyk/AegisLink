/**
 * AegisLink — Sealed-sender envelope (Phase 0 spike)
 *
 * Implements the Signal-style sealed-sender transport described in
 * docs/SEALED-SENDER-ARCHITECTURE.md §3, WITHOUT touching the live envelope
 * path. The goal of this module is to (a) prove the round-trip + authentication
 * properties and (b) let us benchmark the per-message crypto overhead — the real
 * go/no-go for migrating real-time call signaling (ICE trickle is many small
 * messages per call).
 *
 * Properties:
 *  - The sender's `aegisId` (`from`) is sealed INSIDE the box; the relay never
 *    sees it. Only `{ to, ciphertext, nonce, epk }` travel on the wire.
 *  - The box is sealed with a PER-MESSAGE EPHEMERAL keypair, so the relay cannot
 *    tie the ciphertext to the sender's static X25519 key.
 *  - The recipient authenticates the sender by verifying an Ed25519 signature
 *    over the inner payload against the signing key it already holds for that
 *    contact (no relay-issued certificate needed; sealed-sender is restricted to
 *    known contacts). Knowing an aegisId is NOT enough to forge `from`.
 *
 * This module is intentionally framework-free (no DB, no socket) so it can run
 * identically on the server (this file) and be ported verbatim to mobile/desktop
 * in Phase 1.
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

/** Protocol version for the sealed inner payload. */
export const SEALED_SENDER_VERSION = 1;

/** Maximum clock skew tolerated on the inner `ts` (replay window guard). */
export const SEALED_TS_SKEW_MS = 60_000;

/** What travels on the wire. Contains NO sender identity. */
export interface SealedWire {
  /** Base64 NaCl box ciphertext (XSalsa20-Poly1305). */
  ciphertext: string;
  /** Base64 24-byte nonce. */
  nonce: string;
  /** Base64 ephemeral X25519 public key used to seal this single message. */
  epk: string;
}

/** The authenticated, decrypted result of opening a sealed envelope. */
export interface OpenedEnvelope {
  /** Sender aegisId, recovered from inside the sealed payload and authenticated. */
  from: string;
  /** The application payload (opaque string — SDP, ICE JSON, message body, …). */
  payload: string;
  /** Inner timestamp (ms) the sender stamped. */
  ts: number;
}

/** Inner structure that is signed then sealed. */
interface SealedInner {
  v: number;
  from: string;
  payload: string;
  ts: number;
}

/**
 * Seal `payload` for `recipientBoxPublicKey`, embedding and signing the sender's
 * identity inside. Returns the wire object (no `from`).
 *
 * @param recipientBoxPublicKey  recipient's static X25519 public key (32 bytes)
 * @param senderAegisId          sender's aegisId, sealed inside
 * @param senderSigningSecretKey sender's Ed25519 secret key (64 bytes) — signs inner
 * @param payload                opaque application payload
 * @param nowMs                  current time (ms); injectable for tests
 */
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

  // Authenticate the sender to the RECIPIENT (not the relay) via Ed25519.
  const sig = nacl.sign.detached(innerBytes, senderSigningSecretKey);

  // Envelope structure that actually gets boxed: the inner bytes + the signature.
  const sealedPlain = new TextEncoder().encode(
    JSON.stringify({ i: encodeBase64(innerBytes), s: encodeBase64(sig) }),
  );

  // Per-message ephemeral keypair → unlinkable to the sender's static key.
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
    // Zeroize the ephemeral secret — never needed again (golden rule #9).
    ephemeral.secretKey.fill(0);
  }
}

/**
 * Open and authenticate a sealed envelope.
 *
 * @param wire                 the wire object { ciphertext, nonce, epk }
 * @param myBoxSecretKey       recipient's static X25519 secret key
 * @param resolveSigningKey    maps a claimed `from` aegisId → that contact's
 *                             Ed25519 signing public key, or null if unknown.
 *                             Returning null for non-contacts enforces the
 *                             "sealed-sender only between contacts" rule.
 * @param nowMs                current time (ms); injectable for tests
 * @returns the authenticated { from, payload, ts } or null on ANY failure
 *          (bad key, tamper, unknown sender, bad signature, stale/`future` ts).
 */
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

  // Replay/skew guard: reject envelopes too far from now in either direction.
  if (Math.abs(nowMs - inner.ts) > SEALED_TS_SKEW_MS) return null;

  // Authenticate the sender: the signature MUST verify against the signing key
  // we already hold for the claimed `from`. Unknown sender → reject.
  const signingPub = resolveSigningKey(inner.from);
  if (!signingPub || signingPub.length !== nacl.sign.publicKeyLength) return null;
  if (!nacl.sign.detached.verify(innerBytes, sig, signingPub)) return null;

  return { from: inner.from, payload: inner.payload, ts: inner.ts };
}
