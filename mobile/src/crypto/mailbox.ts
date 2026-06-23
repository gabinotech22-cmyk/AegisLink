/**
 * AegisLink — Blind mailbox IDs (sealed-sender Fase 4 SPIKE, mobile)
 *
 * STATUS: isolated spike, NOT wired into the live transport. Mirrors how the
 * Fase 0 sealed-envelope spike was introduced (framework-free, fully tested,
 * off the live path) so mobile/desktop/server can later share one audited
 * construction. See docs/SEALED-SENDER-ARCHITECTURE.md §3.4 / Fase 4.
 *
 * GOAL: hide the *recipient* (`to`) from the relay, the second half of
 * sealed-sender. Fases 1-3 already remove the sender (`from`); the relay still
 * routes by `aegisId` in `to`. Here the relay routes by a rotating, opaque
 * **mailbox ID** and never learns the aegisId at any point — not in routing,
 * not in socket auth.
 *
 * MODEL (deterministic per-epoch derivation):
 *  - A user has a 32-byte **mailbox root secret**, generated once on-device.
 *  - The root is shared with each contact ONCE over the E2EE channel (X3DH /
 *    profile_update ride-along, same path as the delivery token). It never
 *    reaches the relay.
 *  - Both sides derive the CURRENT mailbox deterministically from the root and
 *    the epoch (e.g. day index): the per-epoch Ed25519 signing key is
 *    `HKDF(root, epoch)` and the routing id is `SHA256(signPublicKey)[0:16]`.
 *    No per-epoch re-sharing is needed — rotation is automatic and silent.
 *  - Binding the id to the signing public key (id = H(pubkey)) is what makes
 *    mailbox auth hijack-proof: the relay recomputes the id from a key whose
 *    possession the client just proved, so nobody can claim another mailbox's
 *    id without a SHA-256 second preimage.
 *  - The owner proves possession of the current mailbox to the relay via
 *    challenge-response over the mailbox's Ed25519 key (same shape as today's
 *    aegisId auth, but the relay only ever sees the rotating mailboxId).
 *  - A sender addresses `to = mailboxId(recipientRoot, epoch)` instead of the
 *    aegisId. The relay sees only `{ mailboxTo, ciphertext, nonce, epk }` —
 *    neither real `from` nor real `to`.
 *
 * IRREDUCIBLE LIMIT (documented, not solved here): the relay still knows
 * "mailbox X is connected on this socket now". Rotation prevents cross-epoch
 * relinking; temporal correlation and the push provider remain (Fases 5+),
 * the same residual Signal/SimpleX live with.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';

/** Opaque mailbox identifier length (128-bit — collision-safe routing handle). */
export const MAILBOX_ID_BYTES = 16;

/** Default rotation period: one mailbox per UTC day. */
export const MAILBOX_EPOCH_MS = 24 * 60 * 60 * 1000;

/** HKDF domain separator for mailbox derivation. */
const MAILBOX_INFO_PREFIX = 'AegisLinkMailbox';

/** Ed25519 seed length derived from (root, epoch). */
const SEED_LEN = 32;

/** A mailbox derived for one epoch: the routing id plus its auth keypair. */
export interface Mailbox {
  /** 16-byte opaque routing id the relay sees. */
  mailboxId: Uint8Array;
  /** Base64 of `mailboxId`, for the wire / registration. */
  mailboxIdB64: string;
  /** Ed25519 public key the relay stores to verify possession proofs. */
  signPublicKey: Uint8Array;
  /** Ed25519 secret key the owner uses to sign auth challenges (never shared). */
  signSecretKey: Uint8Array;
  /** The epoch this mailbox is valid for. */
  epoch: number;
}

/**
 * Generate a fresh 32-byte mailbox root secret. Shared with contacts over E2EE,
 * never with the relay. One per identity (or per profile).
 */
export function generateMailboxRoot(): Uint8Array {
  return nacl.randomBytes(32);
}

/** The epoch index for a wall-clock time, given the rotation period. */
export function epochFor(nowMs: number, epochMs: number = MAILBOX_EPOCH_MS): number {
  return Math.floor(nowMs / epochMs);
}

/** Encode an epoch as 8 big-endian bytes without relying on BigInt (Hermes-safe). */
function epochBytesBE(epoch: number): Uint8Array {
  const b = new Uint8Array(8);
  const hi = Math.floor(epoch / 0x100000000);
  const lo = epoch >>> 0;
  b[0] = (hi >>> 24) & 0xff;
  b[1] = (hi >>> 16) & 0xff;
  b[2] = (hi >>> 8) & 0xff;
  b[3] = hi & 0xff;
  b[4] = (lo >>> 24) & 0xff;
  b[5] = (lo >>> 16) & 0xff;
  b[6] = (lo >>> 8) & 0xff;
  b[7] = lo & 0xff;
  return b;
}

function mailboxInfo(epoch: number): Uint8Array {
  const prefix = new TextEncoder().encode(MAILBOX_INFO_PREFIX);
  const ep = epochBytesBE(epoch);
  const out = new Uint8Array(prefix.length + ep.length);
  out.set(prefix, 0);
  out.set(ep, prefix.length);
  return out;
}

/**
 * Derive the 16-byte routing id from a mailbox signing public key:
 * `mailboxId = SHA256(signPublicKey)[0:16]`. Binding the id to the key is what
 * lets the relay recompute the id from a key whose possession the client just
 * proved (hijack-proof: claiming another mailbox's id needs a SHA-256 second
 * preimage), and lets a sender compute the recipient's id from the signing key
 * it derives off the shared root.
 */
export function mailboxIdForSignPublicKey(
  signPublicKey: Uint8Array
): { mailboxId: Uint8Array; mailboxIdB64: string } {
  const mailboxId = sha256(signPublicKey).slice(0, MAILBOX_ID_BYTES);
  return { mailboxId, mailboxIdB64: encodeBase64(mailboxId) };
}

/**
 * Derive the mailbox (auth keypair + routing id) for a given root and epoch.
 * Deterministic: the same `(root, epoch)` always yields the same mailbox, so
 * the owner and every contact holding the root compute identical ids without
 * any per-epoch coordination. The intermediate KDF seed is zeroized.
 */
export function deriveMailbox(root: Uint8Array, epoch: number): Mailbox {
  const seed = hkdf(sha256, root, undefined, mailboxInfo(epoch), SEED_LEN);
  try {
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const { mailboxId, mailboxIdB64 } = mailboxIdForSignPublicKey(kp.publicKey);
    return {
      mailboxId,
      mailboxIdB64,
      signPublicKey: kp.publicKey,
      signSecretKey: kp.secretKey,
      epoch,
    };
  } finally {
    seed.fill(0);
  }
}

/** Convenience: derive the mailbox valid right now. */
export function currentMailbox(root: Uint8Array, nowMs: number, epochMs: number = MAILBOX_EPOCH_MS): Mailbox {
  return deriveMailbox(root, epochFor(nowMs, epochMs));
}

/**
 * Sign a relay-issued auth challenge with the mailbox secret (proof of
 * possession). The relay verifies it against the registered `signPublicKey`
 * without ever learning the aegisId behind the mailbox.
 */
export function mailboxAuthProof(signSecretKey: Uint8Array, challenge: Uint8Array): Uint8Array {
  return nacl.sign.detached(challenge, signSecretKey);
}

/** Relay-side verification of a mailbox possession proof. */
export function verifyMailboxAuth(
  signPublicKey: Uint8Array,
  challenge: Uint8Array,
  signature: Uint8Array
): boolean {
  if (signPublicKey.length !== 32 || signature.length !== 64) return false;
  return nacl.sign.detached.verify(challenge, signature, signPublicKey);
}
