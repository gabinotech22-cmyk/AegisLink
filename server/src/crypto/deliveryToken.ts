/**
 * AegisLink — Delivery token (Phase 0 spike)
 *
 * Anti-abuse gate for sealed-sender (docs/SEALED-SENDER-ARCHITECTURE.md §3.3).
 * Because sealed-sender submissions are NOT authenticated as a sender, the relay
 * needs a way to reject spam to a recipient without learning who is sending.
 *
 * A recipient generates a high-entropy delivery token, registers ONLY its hash
 * with the relay, and shares the raw token with contacts over the E2EE X3DH
 * channel. To send a sealed message to `to`, the sender presents the raw token;
 * the relay checks `sha256(token) === storedHash(to)`. Knowing the token proves
 * the sender is an authorized contact of `to` without revealing the sender.
 *
 * The comparison is constant-time (golden rule #8). Tokens are rotatable: to
 * revoke a contact, the recipient rotates the token and re-shares it with the
 * remaining contacts over E2EE.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/** Token entropy in bytes. 16 bytes = 128 bits — well above Signal's 96-bit. */
export const DELIVERY_TOKEN_BYTES = 16;

/** Generate a fresh raw delivery token (base64url, no padding). */
export function generateDeliveryToken(): string {
  return randomBytes(DELIVERY_TOKEN_BYTES).toString('base64url');
}

/** Hash a raw token for at-rest storage. The relay stores ONLY this. */
export function hashDeliveryToken(rawToken: string): string {
  return createHash('sha256').update(rawToken, 'utf8').digest('base64');
}

/**
 * Constant-time verification of a presented raw token against a stored hash.
 * Returns false (never throws) on any malformed input.
 */
export function verifyDeliveryToken(rawToken: string, storedHashB64: string): boolean {
  if (typeof rawToken !== 'string' || typeof storedHashB64 !== 'string') return false;
  let presented: Buffer;
  let stored: Buffer;
  try {
    presented = Buffer.from(hashDeliveryToken(rawToken), 'base64');
    stored = Buffer.from(storedHashB64, 'base64');
  } catch {
    return false;
  }
  // timingSafeEqual throws if lengths differ — guard first, but still compare a
  // fixed-length dummy so the early-out itself is not a timing oracle.
  if (presented.length !== stored.length) {
    timingSafeEqual(presented, presented);
    return false;
  }
  return timingSafeEqual(presented, stored);
}
