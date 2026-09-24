/**
 * F-1 differential test: the native libsodium backend (`crypto/sodium/native.ts`)
 * must be a drop-in for TweetNaCl — identical bytes on random inputs, and
 * TweetNaCl's contract at the edges (error messages, null on auth failure,
 * plain Uint8Array results). TweetNaCl stays a devDependency only as this
 * oracle. The deliberate, stricter differences are asserted explicitly.
 * Twin: `desktop/src/main/crypto/__tests__/sodium-native.differential.test.ts`
 * (which also asserts both `native.ts` copies stay byte-identical).
 */
import tweetnacl from 'tweetnacl';
import * as native from '../crypto/sodium/native.js';

const rnd = (n: number): Uint8Array => tweetnacl.randomBytes(n);
const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const SIZES = [0, 1, 31, 32, 33, 64, 1000, 4096];

describe('native libsodium backend ≡ TweetNaCl (bytes)', () => {
  it('secretbox / box / scalarMult / sign match on random inputs', () => {
    for (let i = 0; i < 64; i++) {
      const msg = rnd(SIZES[i % SIZES.length]);
      const nonce = rnd(24);
      const key = rnd(32);
      const a = tweetnacl.box.keyPair();
      const b = tweetnacl.box.keyPair();
      const seed = rnd(32);
      const signKp = tweetnacl.sign.keyPair.fromSeed(seed);

      expect(hex(native.secretbox(msg, nonce, key))).toBe(hex(tweetnacl.secretbox(msg, nonce, key)));
      const sealed = tweetnacl.secretbox(msg, nonce, key);
      expect(hex(native.secretboxOpen(sealed, nonce, key)!)).toBe(hex(msg));

      const boxed = tweetnacl.box(msg, nonce, b.publicKey, a.secretKey);
      expect(hex(native.box(msg, nonce, b.publicKey, a.secretKey))).toBe(hex(boxed));
      expect(hex(native.boxOpen(boxed, nonce, a.publicKey, b.secretKey)!)).toBe(hex(msg));

      expect(hex(native.scalarMult(a.secretKey, b.publicKey))).toBe(hex(tweetnacl.scalarMult(a.secretKey, b.publicKey)));
      expect(hex(native.scalarMultBase(a.secretKey))).toBe(hex(a.publicKey));
      expect(hex(native.boxKeyPairFromSecretKey(a.secretKey).publicKey)).toBe(hex(a.publicKey));

      const kp = native.signKeyPairFromSeed(seed);
      expect(hex(kp.publicKey)).toBe(hex(signKp.publicKey));
      expect(hex(kp.secretKey)).toBe(hex(signKp.secretKey));
      const sig = native.signDetached(msg, kp.secretKey);
      expect(hex(sig)).toBe(hex(tweetnacl.sign.detached(msg, signKp.secretKey)));
      expect(native.signVerifyDetached(msg, sig, kp.publicKey)).toBe(true);
    }
  });

  it('fresh key pairs are valid and interoperate with TweetNaCl', () => {
    const a = native.boxKeyPair();
    expect(hex(tweetnacl.scalarMult.base(a.secretKey))).toBe(hex(a.publicKey));
    const s = native.signKeyPair();
    const msg = rnd(50);
    expect(tweetnacl.sign.detached.verify(msg, native.signDetached(msg, s.secretKey), s.publicKey)).toBe(true);
  });
});

describe('native libsodium backend — TweetNaCl contract at the edges', () => {
  const key = rnd(32);
  const nonce = rnd(24);

  it('open returns null on MAC failure and on a too-short ciphertext', () => {
    const c = native.secretbox(rnd(10), nonce, key);
    c[3] ^= 1;
    expect(native.secretboxOpen(c, nonce, key)).toBeNull();
    expect(native.secretboxOpen(new Uint8Array(15), nonce, key)).toBeNull();
    const a = native.boxKeyPair();
    expect(native.boxOpen(new Uint8Array(3), nonce, a.publicKey, a.secretKey)).toBeNull();
  });

  it('wrong sizes throw with the same messages as TweetNaCl', () => {
    const cases: Array<[() => unknown, () => unknown]> = [
      [() => native.secretbox(rnd(1), rnd(23), key), () => tweetnacl.secretbox(rnd(1), rnd(23), key)],
      [() => native.secretbox(rnd(1), nonce, rnd(31)), () => tweetnacl.secretbox(rnd(1), nonce, rnd(31))],
      [() => native.boxOpen(rnd(20), nonce, rnd(31), rnd(32)), () => tweetnacl.box.open(rnd(20), nonce, rnd(31), rnd(32))],
      [() => native.box(rnd(1), nonce, rnd(32), rnd(33)), () => tweetnacl.box(rnd(1), nonce, rnd(32), rnd(33))],
      [() => native.box(rnd(1), rnd(25), rnd(32), rnd(32)), () => tweetnacl.box(rnd(1), rnd(25), rnd(32), rnd(32))],
      [() => native.signDetached(rnd(1), rnd(32)), () => tweetnacl.sign.detached(rnd(1), rnd(32))],
      [() => native.signVerifyDetached(rnd(1), rnd(63), rnd(32)), () => tweetnacl.sign.detached.verify(rnd(1), rnd(63), rnd(32))],
      [() => native.signVerifyDetached(rnd(1), rnd(64), rnd(31)), () => tweetnacl.sign.detached.verify(rnd(1), rnd(64), rnd(31))],
      [() => native.signKeyPairFromSeed(rnd(16)), () => tweetnacl.sign.keyPair.fromSeed(rnd(16))],
      [() => native.scalarMult(rnd(31), rnd(32)), () => tweetnacl.scalarMult(rnd(31), rnd(32))],
      [() => native.scalarMultBase(rnd(33)), () => tweetnacl.scalarMult.base(rnd(33))],
    ];
    for (const [ours, theirs] of cases) {
      let expected = '';
      try {
        theirs();
      } catch (e) {
        expected = (e as Error).message;
      }
      expect(expected).not.toBe('');
      expect(ours).toThrow(expected);
    }
  });

  it('rejects non-Uint8Array input like TweetNaCl', () => {
    expect(() => native.secretbox([1, 2] as unknown as Uint8Array, nonce, key)).toThrow(TypeError);
  });

  it('returns plain Uint8Arrays, never Buffers (their JSON form differs)', () => {
    const outs = [native.randomBytes(8), native.secretbox(rnd(4), nonce, key), native.signKeyPair().publicKey];
    for (const o of outs) expect(Object.getPrototypeOf(o)).toBe(Uint8Array.prototype);
  });

  it('verify: constant-time equality with TweetNaCl semantics', () => {
    const x = rnd(32);
    expect(native.verify(x, x.slice())).toBe(true);
    const y = x.slice();
    y[31] ^= 1;
    expect(native.verify(x, y)).toBe(false);
    expect(native.verify(x, x.subarray(0, 31))).toBe(false);
    expect(native.verify(new Uint8Array(0), new Uint8Array(0))).toBe(false);
  });
});

describe('native libsodium backend — deliberate fail-closed differences', () => {
  it('scalarMult throws on a low-order point (TweetNaCl returned all zeros)', () => {
    const sk = rnd(32);
    const zeroPoint = new Uint8Array(32);
    expect(Array.from(tweetnacl.scalarMult(sk, zeroPoint)).every((b) => b === 0)).toBe(true);
    expect(() => native.scalarMult(sk, zeroPoint)).toThrow(/low-order/);
  });
});
