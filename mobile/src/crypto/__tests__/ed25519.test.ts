/**
 * ed25519.test.ts — regression for Ed25519 signature malleability (external
 * review 2026-09-23). TweetNaCl accepts S >= L; verifyDetached must not.
 * Twins: mobile/src/crypto/__tests__, desktop/src/renderer/crypto/__tests__,
 * server/src/__tests__ (golden rules #5 and #11).
 */
import fs from 'fs';
import path from 'path';
import nacl from 'tweetnacl';
import { verifyDetached, isCanonicalScalar } from '../ed25519';

const SRC_ROOT = path.resolve(__dirname, '../..');

/** Returns a copy of `sig` with S replaced by S + L (the malleated twin). */
function malleate(sig: Uint8Array): Uint8Array {
  const out = sig.slice();
  let carry = 0;
  for (let i = 0; i < 32; i++) {
    const v = out[32 + i] + L_LE[i] + carry;
    out[32 + i] = v & 0xff;
    carry = v >> 8;
  }
  return out;
}

const L_LE = [
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58, 0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x10,
];

describe('verifyDetached — rejects malleable (non-canonical S) Ed25519 signatures', () => {
  const kp = nacl.sign.keyPair();
  const msg = new TextEncoder().encode('aegislink ed25519 canonical-S regression');
  const sig = nacl.sign.detached(msg, kp.secretKey);

  it('accepts a valid signature', () => {
    expect(verifyDetached(msg, sig, kp.publicKey)).toBe(true);
  });

  it('rejects the S + L twin that raw TweetNaCl accepts', () => {
    const twin = malleate(sig);
    expect(Array.from(twin)).not.toEqual(Array.from(sig));
    // Proves the bug this helper exists for: TweetNaCl alone accepts the twin.
    expect(nacl.sign.detached.verify(msg, twin, kp.publicKey)).toBe(true);
    expect(isCanonicalScalar(twin)).toBe(false);
    expect(verifyDetached(msg, twin, kp.publicKey)).toBe(false);
  });

  it('rejects S == L and S = 2^256 - 1', () => {
    const eqL = sig.slice();
    eqL.set(L_LE, 32);
    expect(isCanonicalScalar(eqL)).toBe(false);
    const max = sig.slice();
    max.fill(0xff, 32);
    expect(verifyDetached(msg, max, kp.publicKey)).toBe(false);
  });

  it('accepts S == L - 1 as canonical', () => {
    const lMinus1 = sig.slice();
    lMinus1.set(L_LE, 32);
    lMinus1[32] -= 1;
    expect(isCanonicalScalar(lMinus1)).toBe(true);
  });

  it('returns false (no throw) on a wrong-length signature', () => {
    expect(verifyDetached(msg, sig.subarray(0, 63), kp.publicKey)).toBe(false);
    expect(verifyDetached(msg, new Uint8Array(65), kp.publicKey)).toBe(false);
  });

  it('rejects a signature over a different message', () => {
    const other = new TextEncoder().encode('different');
    expect(verifyDetached(other, sig, kp.publicKey)).toBe(false);
  });
});

describe('no direct nacl.sign.detached.verify in production code', () => {
  it('every Ed25519 verification goes through verifyDetached', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p);
        } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
          const src = fs.readFileSync(p, 'utf8');
          if (/sign\.detached\.verify\(/.test(src) && !p.endsWith(`${path.sep}ed25519.ts`)) offenders.push(p);
        }
      }
    };
    walk(SRC_ROOT);
    expect(offenders).toEqual([]);
  });
});
