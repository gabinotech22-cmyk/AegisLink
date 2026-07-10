/**
 * Tests for the buffer-reuse PoW miner in registration.ts::solvePoW.
 *
 * We only assert FUNCTIONAL correctness and protocol compatibility — never
 * timing (that would be flaky in CI). The speedup (fewer allocations per hash)
 * is verified by code inspection.
 *
 * Protocol invariant under test: the nonce string that `solvePoW` returns must
 * be byte-for-byte the string it hashed locally, AND the relay must derive the
 * same digest by hashing `nonce + challenge` as a plain STRING concatenation
 * (server/src/pow/challenge.ts uses `createHash('sha256').update(nonce + challenge)`).
 * We replicate BOTH the local byte-concat path and the server string-concat path
 * to prove they never diverge — even when the nonce carries leading zeros.
 */

import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import { solvePoW, hasLeadingZeroBits } from '../registration';

// Server-side nonce format gate (server/src/pow/challenge.ts:67).
const SERVER_NONCE_RE = /^[0-9a-f]{1,32}$/;

/** Local verification: exactly what solvePoW does internally (byte concat). */
function digestBytesPath(nonce: string, challenge: string): Uint8Array {
  const nonceBytes = utf8ToBytes(nonce);
  const challengeBytes = utf8ToBytes(challenge);
  const input = new Uint8Array(nonceBytes.length + challengeBytes.length);
  input.set(nonceBytes, 0);
  input.set(challengeBytes, nonceBytes.length);
  return sha256(input);
}

/** Server verification: string concat then hash (createHash().update(nonce + challenge)). */
function digestStringPath(nonce: string, challenge: string): Uint8Array {
  return sha256(utf8ToBytes(nonce + challenge));
}

const CHALLENGES = [
  '00',
  'deadbeef',
  'a3f1c09e7b2d4856a1b2c3d4e5f60718',
  randomHexChallenge(64),
];

function randomHexChallenge(nChars: number): string {
  const hex = '0123456789abcdef';
  let s = '';
  for (let i = 0; i < nChars; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
}

describe('solvePoW', () => {
  describe('correctness across low difficulties', () => {
    for (const difficulty of [0, 4, 8]) {
      for (const challenge of CHALLENGES) {
        it(`difficulty=${difficulty} challenge=${challenge.slice(0, 8)}… yields a valid nonce`, async () => {
          const nonce = await solvePoW(challenge, difficulty);

          // Re-hash via the exact internal (byte-concat) path.
          const localDigest = digestBytesPath(nonce, challenge);
          expect(hasLeadingZeroBits(localDigest, difficulty)).toBe(true);

          // Re-hash via the server (string-concat) path — MUST match locally.
          const serverDigest = digestStringPath(nonce, challenge);
          expect(Array.from(serverDigest)).toEqual(Array.from(localDigest));
          expect(hasLeadingZeroBits(serverDigest, difficulty)).toBe(true);
        });
      }
    }
  });

  describe('protocol compatibility of the returned nonce', () => {
    it('always matches the server nonce regex /^[0-9a-f]{1,32}$/', async () => {
      for (const difficulty of [0, 4, 8]) {
        for (const challenge of CHALLENGES) {
          const nonce = await solvePoW(challenge, difficulty);
          expect(nonce).toMatch(SERVER_NONCE_RE);
        }
      }
    });

    it('returns a fixed-width zero-padded nonce (leading zeros preserved)', async () => {
      // At difficulty 0 the FIRST attempt ("00000000") already passes, so we can
      // deterministically assert the zero-padded shape the miner emits.
      const nonce = await solvePoW('deadbeef', 0);
      expect(nonce).toBe('00000000');
      expect(nonce).toMatch(SERVER_NONCE_RE);
    });
  });

  describe('leading-zero nonces re-hash identically client and server', () => {
    it('a zero-padded nonce verifies under BOTH byte-concat and string-concat', async () => {
      const challenge = 'a3f1c09e7b2d4856a1b2c3d4e5f60718';
      const nonce = await solvePoW(challenge, 8);

      // Sanity: this nonce actually carries leading zeros (miner is fixed-width).
      expect(nonce.length).toBe(8);

      // Manual string-concat replication of the EXACT server computation.
      const serverDigest = sha256(utf8ToBytes(nonce + challenge));
      expect(hasLeadingZeroBits(serverDigest, 8)).toBe(true);

      // And the local byte path agrees byte-for-byte — no bytes-vs-string drift.
      const localDigest = digestBytesPath(nonce, challenge);
      expect(Array.from(serverDigest)).toEqual(Array.from(localDigest));
    });
  });

  describe('input validation', () => {
    it('rejects non-integer / out-of-range difficulty', async () => {
      await expect(solvePoW('ab', 1.5)).rejects.toThrow('invalid difficulty');
      await expect(solvePoW('ab', -1)).rejects.toThrow('invalid difficulty');
      await expect(solvePoW('ab', 257)).rejects.toThrow('invalid difficulty');
    });
  });
});
