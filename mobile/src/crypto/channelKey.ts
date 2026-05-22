import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64, encodeUTF8, decodeUTF8 } from 'tweetnacl-util';
import { hmacSHA256, hkdfSHA256 } from './signal/kdf';

// ---------------------------------------------------------------------------
// Sender Key scheme for Work channel E2EE (Signal-style group messaging).
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
  senderAegisId: string;
  channelId: string;
  chainKeyB64: string; // diagnostic / metadata only — the real key is sealed below
  iteration: number;
  // Encrypted for a specific recipient:
  // NaCl box(SenderKey JSON, recipientPublicKey, senderSecretKey, nonce)
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
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.secretbox(decodeUTF8(body), nonce, messageKey);
  return {
    ciphertextB64: encodeBase64(ciphertext),
    nonceB64: encodeBase64(nonce),
    newSenderKey: ratchetSenderKey(senderKey),
  };
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
  const messageKey = deriveMessageKey(senderKey);
  const ciphertext = decodeBase64(ciphertextB64);
  const nonce = decodeBase64(nonceB64);
  const plaintext = nacl.secretbox.open(ciphertext, nonce, messageKey);
  if (!plaintext) {
    throw new Error('decryptChannelMessage: MAC verification failed');
  }
  return encodeUTF8(plaintext);
}

function serializeSenderKey(sk: SenderKey): Uint8Array {
  return decodeUTF8(
    JSON.stringify({ chainKeyB64: encodeBase64(sk.chainKey), iteration: sk.iteration })
  );
}

function deserializeSenderKey(bytes: Uint8Array): SenderKey {
  const parsed = JSON.parse(encodeUTF8(bytes)) as { chainKeyB64: string; iteration: number };
  const chainKey = decodeBase64(parsed.chainKeyB64);
  if (chainKey.length !== 32) {
    throw new Error('deserializeSenderKey: invalid chainKey length');
  }
  return { chainKey, iteration: parsed.iteration };
}

/** Seal a SenderKey for delivery to a specific recipient (NaCl box). */
export function sealSenderKeyFor(
  sk: SenderKey,
  channelId: string,
  senderAegisId: string,
  recipientPublicKeyB64: string,
  senderSecretKeyB64: string
): SenderKeyDistributionMessage {
  const nonce = nacl.randomBytes(24);
  const ciphertext = nacl.box(
    serializeSenderKey(sk),
    nonce,
    decodeBase64(recipientPublicKeyB64),
    decodeBase64(senderSecretKeyB64)
  );
  return {
    senderAegisId,
    channelId,
    chainKeyB64: encodeBase64(sk.chainKey),
    iteration: sk.iteration,
    ciphertextB64: encodeBase64(ciphertext),
    nonceB64: encodeBase64(nonce),
  };
}

/** Open a SenderKey distribution message addressed to us. Throws on failure. */
export function openSenderKeyDistribution(
  msg: SenderKeyDistributionMessage,
  mySecretKeyB64: string,
  senderPublicKeyB64: string
): SenderKey {
  const opened = nacl.box.open(
    decodeBase64(msg.ciphertextB64),
    decodeBase64(msg.nonceB64),
    decodeBase64(senderPublicKeyB64),
    decodeBase64(mySecretKeyB64)
  );
  if (!opened) {
    throw new Error('openSenderKeyDistribution: failed to decrypt sealed SenderKey');
  }
  return deserializeSenderKey(opened);
}
