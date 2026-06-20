/**
 * pow.challenge.test.ts — security roadmap Ola 9 (A-2)
 *
 * The PoW difficulty is now parameterised per challenge and BOUND AT ISSUANCE,
 * so registration can demand a harder proof than blob upload and a client cannot
 * solve at a lower difficulty than it was issued (anti-downgrade). Also covers
 * the one-time-use (consume) contract.
 */

import { createHash } from 'node:crypto';
import { issueChallenge, verifyPoW, POW_DIFFICULTY } from '../pow/challenge.js';

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

function solve(challenge: string, difficulty: number): string {
  let n = 0;
  for (;;) {
    const nonce = n.toString(16);
    const digest = createHash('sha256').update(nonce + challenge).digest();
    if (hasLeadingZeroBits(digest, difficulty)) return nonce;
    n++;
  }
}

describe('PoW challenge — A-2 difficulty binding', () => {
  it('issueChallenge() returns the default difficulty', () => {
    const { difficulty } = issueChallenge();
    expect(difficulty).toBe(POW_DIFFICULTY);
  });

  it('honours a custom (higher) difficulty passed at issuance', () => {
    const c = issueChallenge(8);
    expect(c.difficulty).toBe(8);
    const nonce = solve(c.challenge, 8);
    expect(verifyPoW(c.challenge, nonce)).toBeNull();
  });

  it('rejects a solution that meets less than the issued difficulty (anti-downgrade)', () => {
    // Issued at 20 bits; submit a nonce that almost certainly meets far fewer.
    const c = issueChallenge(20);
    // Find a nonce with at least 4 but (overwhelmingly likely) < 20 leading zeros.
    let nonce = '0';
    for (let n = 0; ; n++) {
      const cand = n.toString(16);
      const d = createHash('sha256').update(cand + c.challenge).digest();
      if (hasLeadingZeroBits(d, 4) && !hasLeadingZeroBits(d, 20)) { nonce = cand; break; }
    }
    expect(verifyPoW(c.challenge, nonce)).toBe('insufficient_pow');
  });

  it('consumes a challenge on success (one-time use)', () => {
    const c = issueChallenge(6);
    const nonce = solve(c.challenge, 6);
    expect(verifyPoW(c.challenge, nonce)).toBeNull();
    // Second attempt: challenge already consumed.
    expect(verifyPoW(c.challenge, nonce)).toBe('challenge_unknown');
  });

  it('rejects an unknown challenge', () => {
    expect(verifyPoW('f'.repeat(64), '0')).toBe('challenge_unknown');
  });
});
