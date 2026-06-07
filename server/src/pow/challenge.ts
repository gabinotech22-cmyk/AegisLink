/**
 * Proof-of-Work challenge store — in-memory only.
 * No IP is persisted anywhere. The Map key is the opaque challenge token;
 * the IP is used solely by the rate limiter in express and never stored here.
 */

import { createHash, randomBytes } from 'node:crypto';

/** Difficulty: number of leading zero BITS required in SHA-256(nonce + challenge). */
export const POW_DIFFICULTY = 14; // ~16 k hashes on average — trivial for a real client, costly for bulk bots

/** Challenge TTL in milliseconds. */
const CHALLENGE_TTL_MS = 300_000;

interface ChallengeEntry {
  challenge: string; // hex
  expiresAt: number;
}

// Keyed by challenge string itself — no IP stored.
const store = new Map<string, ChallengeEntry>();

// Lazy GC: prune expired entries whenever a new challenge is issued.
function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

export function issueChallenge(): { challenge: string; difficulty: number; expiresAt: number } {
  pruneExpired();
  const challenge = randomBytes(32).toString('hex');
  const expiresAt = Date.now() + CHALLENGE_TTL_MS;
  store.set(challenge, { challenge, expiresAt });
  return { challenge, difficulty: POW_DIFFICULTY, expiresAt };
}

/**
 * Verify that SHA-256(nonce + challenge) has at least `POW_DIFFICULTY` leading zero bits.
 * Consumes the challenge (one-time use) on success.
 * Returns an error string on failure, null on success.
 */
export function verifyPoW(challenge: string, nonce: string): string | null {
  const entry = store.get(challenge);
  if (!entry) return 'challenge_unknown';
  if (Date.now() > entry.expiresAt) {
    store.delete(challenge);
    return 'challenge_expired';
  }

  // Validate nonce is a reasonable hex string (max 16 bytes / 32 hex chars)
  if (!/^[0-9a-f]{1,32}$/.test(nonce)) return 'invalid_nonce_format';

  const digest = createHash('sha256')
    .update(nonce + challenge)
    .digest();

  if (!hasLeadingZeroBits(digest, POW_DIFFICULTY)) return 'insufficient_pow';

  // One-time use — consume immediately on success.
  store.delete(challenge);
  return null;
}

function hasLeadingZeroBits(buf: Buffer, bits: number): boolean {
  let remaining = bits;
  for (const byte of buf) {
    if (remaining <= 0) break;
    const check = remaining >= 8 ? 8 : remaining;
    const mask = 0xff & (0xff << (8 - check));
    if ((byte & mask) !== 0) return false;
    remaining -= 8;
  }
  return true;
}
