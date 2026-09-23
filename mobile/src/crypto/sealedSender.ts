/**
 * AegisLink — Sealed-sender envelope (Phase 1, mobile)
 *
 * Verbatim port of the server-side Phase 0 module (server/src/crypto/
 * sealedSender.ts), kept framework-free so mobile, desktop and the server share
 * one audited construction. See docs/SEALED-SENDER-ARCHITECTURE.md §3.
 *
 * This is the OUTER envelope layer for sealed-sender v2. Unlike the legacy
 * outer box in messaging.ts (which seals under the sender's STATIC X25519 key,
 * forcing the recipient to trial-decrypt against each contact pubkey and tying
 * the ciphertext to the sender's long-term key), this seals under a PER-MESSAGE
 * EPHEMERAL keypair and authenticates the sender with an Ed25519 signature over
 * the inner payload. Properties:
 *
 *  - The wire carries NO sender identity — only { ciphertext, nonce, epk }. The
 *    relay never sees `from` (it lives, signed, inside the box).
 *  - The ephemeral key makes the ciphertext unlinkable to the sender's static
 *    X25519 key, even by the recipient.
 *  - The recipient authenticates the sender by verifying the inner signature
 *    against the signing key it already holds for that contact. An unknown
 *    sender (no signing key on file) is rejected — sealed-sender is restricted
 *    to established contacts (first contact bootstraps over v1 X3DH).
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { verifyDetached } from './ed25519';

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
  /** The application payload (opaque string — the v2 ratchet inner, JSON). */
  payload: string;
  /** Inner timestamp (ms) the sender stamped. */
  ts: number;
  /**
   * Set when the signature was verified against a key EMBEDDED in the envelope
   * (first contact, TOFU) rather than one we already held — the caller must
   * pin it on the new contact. Absent for messages from known contacts.
   */
  tofuSigningKeyB64?: string;
}

interface SealedInner {
  v: number;
  from: string;
  payload: string;
  ts: number;
  /**
   * Federation F3b — FIRST-CONTACT bootstrap: the sender's Ed25519 signing
   * public key, base64. Present only on the first message to someone who
   * cannot know our key yet (a contact on another relay reached from a link).
   * The opener uses it ONLY when `resolveSigningKey` has nothing for `from`
   * (trust-on-first-use, pinned afterwards) — never to override a known key.
   */
  spk?: string;
}

/**
 * Seal `payload` for `recipientBoxPublicKey`, embedding and signing the sender's
 * identity inside. Returns the wire object (no `from`).
 */
export function sealEnvelope(
  recipientBoxPublicKey: Uint8Array,
  senderAegisId: string,
  senderSigningSecretKey: Uint8Array,
  payload: string,
  nowMs: number,
  /** First contact (F3b): embed our signing public key so the recipient can verify. */
  senderSigningPublicKeyForFirstContact?: Uint8Array,
): SealedWire {
  if (recipientBoxPublicKey.length !== nacl.box.publicKeyLength) {
    throw new Error('sealEnvelope: invalid recipient public key length');
  }
  const inner: SealedInner = { v: SEALED_SENDER_VERSION, from: senderAegisId, payload, ts: nowMs };
  if (senderSigningPublicKeyForFirstContact) inner.spk = encodeBase64(senderSigningPublicKeyForFirstContact);
  const innerBytes = new TextEncoder().encode(JSON.stringify(inner));

  // Authenticate the sender to the RECIPIENT (not the relay) via Ed25519.
  const sig = nacl.sign.detached(innerBytes, senderSigningSecretKey);

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
 * @param resolveSigningKey maps a claimed `from` aegisId → that contact's
 *                          Ed25519 signing public key, or null if unknown.
 *                          Returning null for non-contacts enforces the
 *                          "sealed-sender only between contacts" rule.
 * @returns the authenticated { from, payload, ts } or null on ANY failure.
 */
export function openEnvelope(
  wire: SealedWire,
  myBoxSecretKey: Uint8Array,
  resolveSigningKey: (from: string) => Uint8Array | null,
  nowMs: number,
  /**
   * F3b: accept an envelope from an UNKNOWN sender when it embeds its signing
   * key (`spk`). Off by default — only the first-contact path opts in, and only
   * when the sender is unknown; a known contact's pinned key always wins.
   */
  opts: { allowFirstContact?: boolean } = {},
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
  // we already hold for the claimed `from`. Unknown sender → reject, unless the
  // caller allowed first contact AND the envelope embeds a key (TOFU; the
  // caller then binds it to the identity via the X3DH init + ID<->key check).
  let signingPub = resolveSigningKey(inner.from);
  let tofu: string | undefined;
  if (!signingPub && opts.allowFirstContact && typeof inner.spk === 'string') {
    try { signingPub = decodeBase64(inner.spk); } catch { return null; }
    tofu = inner.spk;
  }
  if (!signingPub || signingPub.length !== nacl.sign.publicKeyLength) return null;
  if (!verifyDetached(innerBytes, sig, signingPub)) return null;

  const opened: OpenedEnvelope = { from: inner.from, payload: inner.payload, ts: inner.ts };
  if (tofu) opened.tofuSigningKeyB64 = tofu;
  return opened;
}
