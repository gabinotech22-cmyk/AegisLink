import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { hmacSHA256, hkdfSHA256 } from './signal/kdf';

// ---------------------------------------------------------------------------
// Sender Key scheme for E2EE group/channel messaging (Signal-style).
//
// Each member owns a SenderKey: a 32-byte symmetric chain key plus a
// monotonic iteration counter. Messages are encrypted with a per-message key
// derived from the chain key, then the chain key ratchets forward via
// HMAC-SHA256, giving forward secrecy. SenderKeys are distributed to other
// members individually, sealed with NaCl box against their X25519 identity key.
// ---------------------------------------------------------------------------

export interface SenderKey {
  chainKey: Uint8Array; // 32 bytes — current ratchet position
  iteration: number; // monotonically increasing
}

export interface SenderKeyDistributionMessage {
  channelId: string;
  iteration: number;
  // Encrypted for a specific recipient:
  // NaCl box({chainKey, iteration, senderAegisId} JSON, recipientPublicKey, senderSecretKey, nonce)
  //
  // SEALED-SENDER (Phase 3b): the distributor's `senderAegisId` is NOT a wire
  // field — it lives INSIDE the box. The relay therefore never learns who
  // re-keyed a group (it only routes by the recipient aegisId). The box itself
  // is authenticated (Poly1305): a successful open against a candidate sender's
  // X25519 key proves the blob was sealed by that sender's static secret, so the
  // recipient recovers + verifies `senderAegisId` by trial-opening against its
  // group roster. See openSenderKeyDistribution.
  ciphertextB64: string;
  nonceB64: string;
}

// Domain-separation labels for the KDF steps.
const RATCHET_LABEL = decodeUTF8('AegisLink-SenderKey-Ratchet');
const MESSAGE_KEY_LABEL = 'AegisLink-SenderKey-MessageKey';

/** Generate a fresh SenderKey for a channel. */
export function generateSenderKey(): SenderKey {
  return { chainKey: nacl.randomBytes(32), iteration: 0 };
}

/** Ratchet the chain key forward (HMAC-SHA256 with a constant label). One-way. */
export function ratchetSenderKey(sk: SenderKey): SenderKey {
  const nextChainKey = hmacSHA256(sk.chainKey, RATCHET_LABEL);
  return { chainKey: nextChainKey, iteration: sk.iteration + 1 };
}

/**
 * Hard cap on how far a receiver may fast-forward a SenderKey chain to reach a
 * message's `iteration` (parity with the Double Ratchet's MAX_SKIPPED_KEYS).
 * Without a cap, a single group message carrying a huge `iteration` would force
 * an unbounded HMAC loop on the JS thread (DoS). Messages beyond this gap are
 * dropped rather than processed.
 */
export const MAX_SENDERKEY_SKIP = 2000;

/**
 * Advance a SenderKey forward to `targetIteration`, refusing jumps larger than
 * MAX_SENDERKEY_SKIP. Returns the advanced key, or null if the target is in the
 * past or too far ahead. Intermediate chain keys are zeroized as the chain moves
 * (golden rule #9 — zeroize key intermediates).
 */
export function advanceSenderKeyTo(sk: SenderKey, targetIteration: number): SenderKey | null {
  if (!Number.isInteger(targetIteration) || targetIteration < sk.iteration) return null;
  if (targetIteration - sk.iteration > MAX_SENDERKEY_SKIP) return null;
  let cur = sk;
  while (cur.iteration < targetIteration) {
    const next = ratchetSenderKey(cur);
    if (cur !== sk) cur.chainKey.fill(0); // wipe the evicted intermediate
    cur = next;
  }
  return cur;
}

/** Derive the 32-byte message encryption key from the current chain key. */
export function deriveMessageKey(sk: SenderKey): Uint8Array {
  return hkdfSHA256(sk.chainKey, undefined, MESSAGE_KEY_LABEL, 32);
}

/**
 * Encrypt a message body with the sender's current SenderKey.
 * Returns ciphertext + nonce and the ratcheted-forward SenderKey, which the
 * caller MUST persist before emitting (forward secrecy).
 */
export function encryptChannelMessage(
  body: string,
  senderKey: SenderKey
): { ciphertextB64: string; nonceB64: string; newSenderKey: SenderKey } {
  const messageKey = deriveMessageKey(senderKey);
  try {
    const nonce = nacl.randomBytes(24);
    const ciphertext = nacl.secretbox(decodeUTF8(body), nonce, messageKey);
    return {
      ciphertextB64: encodeBase64(ciphertext),
      nonceB64: encodeBase64(nonce),
      newSenderKey: ratchetSenderKey(senderKey),
    };
  } finally {
    messageKey.fill(0); // zeroize the per-message key (golden rule #9)
  }
}

/**
 * Decrypt a message using the sender's SenderKey at the correct iteration.
 * Throws if the MAC is invalid (tampered ciphertext or wrong key).
 */
export function decryptChannelMessage(
  ciphertextB64: string,
  nonceB64: string,
  senderKey: SenderKey
): string {
  const ciphertext = decodeBase64(ciphertextB64);
  const nonce = decodeBase64(nonceB64);
  // Validate nonce length before use — parity with openWithCallKey/openEnvelope,
  // so a malformed wire field fails with a domain error, never degrades silently.
  if (nonce.length !== nacl.secretbox.nonceLength) {
    throw new Error('decryptChannelMessage: invalid nonce length');
  }
  const messageKey = deriveMessageKey(senderKey);
  try {
    const plaintext = nacl.secretbox.open(ciphertext, nonce, messageKey);
    if (!plaintext) {
      throw new Error('decryptChannelMessage: MAC verification failed');
    }
    return encodeUTF8(plaintext);
  } finally {
    messageKey.fill(0); // zeroize the per-message key (golden rule #9)
  }
}

/**
 * Serialize the SEALED inner — the chain key, iteration AND the distributor's
 * `senderAegisId`. The sender identity rides inside the box (Phase 3b sealed
 * sender) so it never reaches the relay.
 */
function serializeSealedSenderKey(sk: SenderKey, senderAegisId: string): Uint8Array {
  return decodeUTF8(
    JSON.stringify({ chainKeyB64: encodeBase64(sk.chainKey), iteration: sk.iteration, senderAegisId })
  );
}

function deserializeSealedSenderKey(bytes: Uint8Array): { senderKey: SenderKey; senderAegisId: string } {
  const parsed = JSON.parse(encodeUTF8(bytes)) as {
    chainKeyB64: string; iteration: number; senderAegisId: string;
  };
  const chainKey = decodeBase64(parsed.chainKeyB64);
  if (chainKey.length !== 32) {
    throw new Error('deserializeSealedSenderKey: invalid chainKey length');
  }
  if (typeof parsed.senderAegisId !== 'string' || parsed.senderAegisId.length === 0) {
    throw new Error('deserializeSealedSenderKey: missing senderAegisId');
  }
  return { senderKey: { chainKey, iteration: parsed.iteration }, senderAegisId: parsed.senderAegisId };
}

/** Seal a SenderKey for delivery to a specific recipient (NaCl box). The
 *  distributor's `senderAegisId` is sealed INSIDE the box — never on the wire. */
export function sealSenderKeyFor(
  sk: SenderKey,
  channelId: string,
  senderAegisId: string,
  recipientPublicKeyB64: string,
  senderSecretKeyB64: string
): SenderKeyDistributionMessage {
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.box(
    serializeSealedSenderKey(sk, senderAegisId),
    nonce,
    decodeBase64(recipientPublicKeyB64),
    decodeBase64(senderSecretKeyB64)
  );
  return {
    channelId,
    iteration: sk.iteration,
    ciphertextB64: encodeBase64(ciphertext),
    nonceB64: encodeBase64(nonce),
  };
}

/**
 * Number of SenderKey seals performed between event-loop yields. Each seal is a
 * pure-JS X25519 scalarmult (~0.44 ms in Node, ~tens of ms under Hermes), so a
 * large group (up to MAX_GROUP_MEMBERS = 1024) would block the JS thread for
 * many seconds if sealed in one synchronous burst. 32 keeps each chunk well
 * under a frame budget's worth of work between paints.
 */
export const SEAL_CHUNK_SIZE = 32;

/** Yield a macrotask so the single JS thread can paint/respond between chunks. */
const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Seal one SenderKey for many recipients, yielding to the event loop every
 * SEAL_CHUNK_SIZE boxes so a large re-key never freezes the UI. The work is
 * still O(N) — yielding makes it non-blocking, not faster. The returned
 * distributions preserve `recipients` order and tag each with its aegisId so
 * the caller can map them straight to a fan-out batch.
 */
export async function sealSenderKeyForRecipients(
  sk: SenderKey,
  channelId: string,
  senderAegisId: string,
  senderSecretKeyB64: string,
  recipients: ReadonlyArray<{ aegisId: string; publicKeyB64: string }>
): Promise<Array<SenderKeyDistributionMessage & { aegisId: string }>> {
  const out: Array<SenderKeyDistributionMessage & { aegisId: string }> = [];
  for (let i = 0; i < recipients.length; i++) {
    const r = recipients[i];
    const dist = sealSenderKeyFor(sk, channelId, senderAegisId, r.publicKeyB64, senderSecretKeyB64);
    out.push({ ...dist, aegisId: r.aegisId });
    if ((i + 1) % SEAL_CHUNK_SIZE === 0 && i + 1 < recipients.length) {
      await yieldToEventLoop();
    }
  }
  return out;
}

/**
 * Try to open a SenderKey distribution addressed to us, against ONE candidate
 * sender X25519 key. Returns `{ senderKey, senderAegisId }` on success or `null`
 * on any failure — null (not throw) so the caller can trial-decrypt across a
 * group roster without knowing the sender up front (the sender is not on the
 * wire; Phase 3b sealed sender). A successful NaCl box open authenticates the
 * blob as sealed by `candidateSenderPublicKeyB64`'s owner (Poly1305), and we
 * additionally assert the recovered `senderAegisId` is non-empty.
 */
export function openSenderKeyDistribution(
  msg: Pick<SenderKeyDistributionMessage, 'ciphertextB64' | 'nonceB64'>,
  mySecretKeyB64: string,
  candidateSenderPublicKeyB64: string
): { senderKey: SenderKey; senderAegisId: string } | null {
  let opened: Uint8Array | null;
  try {
    opened = nacl.box.open(
      decodeBase64(msg.ciphertextB64),
      decodeBase64(msg.nonceB64),
      decodeBase64(candidateSenderPublicKeyB64),
      decodeBase64(mySecretKeyB64)
    );
  } catch {
    return null;
  }
  if (!opened) return null;
  try {
    return deserializeSealedSenderKey(opened);
  } catch {
    return null;
  }
}
