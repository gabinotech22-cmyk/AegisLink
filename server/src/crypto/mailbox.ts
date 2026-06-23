/**
 * AegisLink — Blind mailbox IDs, relay side (sealed-sender Fase 4, Slice 1).
 *
 * Parity with the client primitive (mobile/src/crypto/mailbox.ts). The relay
 * only ever needs two operations:
 *   - recompute a mailbox's routing id from its signing public key, and
 *   - verify an Ed25519 possession proof over an auth challenge.
 *
 * The relay never learns the aegisId behind a mailbox: it authenticates a socket
 * purely by "you hold the secret for this signing key", and routes by the id
 * `SHA256(signPublicKey)[0:16]` that it recomputes from that proven key. Binding
 * the id to the key is what makes this hijack-proof — claiming another mailbox's
 * id would need a SHA-256 second preimage.
 *
 * See docs/SEALED-SENDER-ARCHITECTURE.md §3.4 / Fase 4.
 */

import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { createHash } from 'node:crypto';

const { encodeBase64 } = naclUtil;

/** Routing-id length in bytes (128-bit). Must match the client primitive. */
export const MAILBOX_ID_BYTES = 16;

/**
 * `mailboxId = base64(SHA256(signPublicKey)[0:16])`. Byte-identical to the
 * client's `mailboxIdForSignPublicKey`. The relay recomputes this from a key
 * whose possession the client just proved.
 */
export function mailboxIdForSignPublicKey(signPublicKey: Uint8Array): string {
  const digest = createHash('sha256').update(Buffer.from(signPublicKey)).digest();
  return encodeBase64(Uint8Array.from(digest.subarray(0, MAILBOX_ID_BYTES)));
}

/**
 * Verify an Ed25519 possession proof: `signature` must be a valid signature over
 * `challenge` under `signPublicKey`. Returns false (never throws) on malformed
 * input.
 */
export function verifyMailboxAuth(
  signPublicKey: Uint8Array,
  challenge: Uint8Array,
  signature: Uint8Array
): boolean {
  if (signPublicKey.length !== nacl.sign.publicKeyLength) return false;
  if (signature.length !== nacl.sign.signatureLength) return false;
  return nacl.sign.detached.verify(challenge, signature, signPublicKey);
}
