/**
 * F-1 B2: the mobile facade runs on native libsodium (`modules/aegis-sodium`;
 * under Jest its Node stand-in, real libsodium via sodium-native). These tests
 * pin the contract the rest of the app relies on:
 *   - identical bytes to the TweetNaCl / @noble implementation it replaced;
 *   - TweetNaCl's error classes and messages at the edges;
 *   - the deliberate, stricter libsodium semantics (fail closed);
 *   - the native return codes are never ignored.
 * The shipped C core is tested the same way by
 * `modules/aegis-sodium/test/differential.mjs` (CI job `aegis-sodium-native`).
 */
import tweetnacl from 'tweetnacl';
import { hmac } from '@noble/hashes/hmac.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 as nobleSha256 } from '@noble/hashes/sha2.js';
import { argon2id as nobleArgon2id } from '@noble/hashes/argon2.js';
import { pbkdf2 as noblePbkdf2 } from '@noble/hashes/pbkdf2.js';
import { ml_kem768 as nobleMlKem } from '@noble/post-quantum/ml-kem.js';
import { nacl, hmacSha256, hkdfSha256, argon2id } from '../sodium';
import { verifyDetached } from '../ed25519';

const rand = (n: number): Uint8Array => tweetnacl.randomBytes(n);
const randInt = (max: number): number => Math.floor(Math.random() * (max + 1));

describe('mobile sodium facade (native libsodium)', () => {
  it('is byte-identical to TweetNaCl and @noble on random inputs', () => {
    for (let i = 0; i < 100; i++) {
      const a = tweetnacl.box.keyPair();
      const b = tweetnacl.box.keyPair();
      const msg = rand(randInt(300));
      const nonce = rand(24);
      const key = rand(32);
      const boxed = nacl.box(msg, nonce, b.publicKey, a.secretKey);
      expect(boxed).toEqual(tweetnacl.box(msg, nonce, b.publicKey, a.secretKey));
      expect(nacl.box.open(boxed, nonce, a.publicKey, b.secretKey)).toEqual(msg);
      expect(nacl.box.before(b.publicKey, a.secretKey)).toEqual(tweetnacl.box.before(b.publicKey, a.secretKey));
      expect(nacl.box.keyPair.fromSecretKey(a.secretKey).publicKey).toEqual(a.publicKey);
      expect(nacl.secretbox(msg, nonce, key)).toEqual(tweetnacl.secretbox(msg, nonce, key));
      expect(nacl.secretbox.open(tweetnacl.secretbox(msg, nonce, key), nonce, key)).toEqual(msg);
      const n = rand(32);
      expect(nacl.scalarMult(n, b.publicKey)).toEqual(tweetnacl.scalarMult(n, b.publicKey));
      expect(nacl.scalarMult.base(n)).toEqual(tweetnacl.scalarMult.base(n));
      const seed = rand(32);
      const kp = nacl.sign.keyPair.fromSeed(seed);
      expect(kp).toEqual(tweetnacl.sign.keyPair.fromSeed(seed));
      const sig = nacl.sign.detached(msg, kp.secretKey);
      expect(sig).toEqual(tweetnacl.sign.detached(msg, kp.secretKey));
      expect(nacl.sign.detached.verify(msg, sig, kp.publicKey)).toBe(true);
      const hkey = rand(randInt(200));
      expect(hmacSha256(hkey, msg)).toEqual(hmac(nobleSha256, hkey, msg));
      const salt = randInt(1) ? rand(randInt(64)) : undefined;
      const info = randInt(1) ? rand(randInt(64)) : undefined;
      const len = 1 + randInt(200);
      expect(hkdfSha256(msg, salt, info, len)).toEqual(hkdf(nobleSha256, msg, salt, info, len));
    }
  });

  it('open returns null on a bad MAC or a too-short box', () => {
    const key = rand(32);
    const nonce = rand(24);
    const c = nacl.secretbox(new Uint8Array([1, 2, 3]), nonce, key);
    c[0] ^= 1;
    expect(nacl.secretbox.open(c, nonce, key)).toBeNull();
    expect(nacl.secretbox.open(new Uint8Array(15), nonce, key)).toBeNull();
    const kp = nacl.box.keyPair();
    expect(nacl.box.open(new Uint8Array(40), nonce, kp.publicKey, kp.secretKey)).toBeNull();
    expect(nacl.box.open(new Uint8Array(3), nonce, kp.publicKey, kp.secretKey)).toBeNull();
  });

  it('seals and opens empty messages', () => {
    const key = rand(32);
    const nonce = rand(24);
    const c = nacl.secretbox(new Uint8Array(0), nonce, key);
    expect(c).toEqual(tweetnacl.secretbox(new Uint8Array(0), nonce, key));
    expect(nacl.secretbox.open(c, nonce, key)).toEqual(new Uint8Array(0));
  });

  it('keeps TweetNaCl error classes and messages, in the same check order', () => {
    const k = rand(32);
    const n = rand(24);
    const cases: Array<[() => unknown, () => unknown]> = [
      [() => nacl.secretbox(new Uint8Array(1), rand(23), k), () => tweetnacl.secretbox(new Uint8Array(1), rand(23), k)],
      [() => nacl.secretbox(new Uint8Array(1), n, rand(31)), () => tweetnacl.secretbox(new Uint8Array(1), n, rand(31))],
      [() => nacl.box(new Uint8Array(1), n, rand(31), k), () => tweetnacl.box(new Uint8Array(1), n, rand(31), k)],
      [() => nacl.box(new Uint8Array(1), rand(1), k, rand(33)), () => tweetnacl.box(new Uint8Array(1), rand(1), k, rand(33))],
      [() => nacl.box(new Uint8Array(1), rand(1), k, k), () => tweetnacl.box(new Uint8Array(1), rand(1), k, k)],
      [() => nacl.scalarMult(rand(31), k), () => tweetnacl.scalarMult(rand(31), k)],
      [() => nacl.scalarMult(k, rand(33)), () => tweetnacl.scalarMult(k, rand(33))],
      [() => nacl.sign.detached(new Uint8Array(1), rand(32)), () => tweetnacl.sign.detached(new Uint8Array(1), rand(32))],
      [() => nacl.sign.detached.verify(new Uint8Array(1), rand(63), k), () => tweetnacl.sign.detached.verify(new Uint8Array(1), rand(63), k)],
      [() => nacl.sign.keyPair.fromSeed(rand(31)), () => tweetnacl.sign.keyPair.fromSeed(rand(31))],
      [() => nacl.box.keyPair.fromSecretKey(rand(31)), () => tweetnacl.box.keyPair.fromSecretKey(rand(31))],
      [() => nacl.secretbox([1] as unknown as Uint8Array, n, k), () => tweetnacl.secretbox([1] as unknown as Uint8Array, n, k)],
    ];
    for (const [ours, theirs] of cases) {
      let want: Error | undefined;
      try {
        theirs();
      } catch (e) {
        want = e as Error;
      }
      expect(want).toBeDefined();
      expect(ours).toThrow(want!.constructor as ErrorConstructor);
      expect(ours).toThrow(want!.message);
    }
  });

  it('verify is constant-time equality with TweetNaCl semantics', () => {
    const x = rand(32);
    expect(nacl.verify(x, new Uint8Array(x))).toBe(true);
    expect(nacl.verify(x, rand(32))).toBe(false);
    expect(nacl.verify(x, x.subarray(0, 16))).toBe(false);
    expect(nacl.verify(new Uint8Array(0), new Uint8Array(0))).toBe(false);
  });

  it('fails closed on low-order X25519 keys (TweetNaCl derived a key from zero)', () => {
    const sk = rand(32);
    const zero = new Uint8Array(32);
    expect(() => nacl.scalarMult(sk, zero)).toThrow(/low-order/);
    expect(() => nacl.box.before(zero, sk)).toThrow(/low-order/);
    expect(() => nacl.box(new Uint8Array(1), rand(24), zero, sk)).toThrow(/low-order/);
    // TweetNaCl happily returns the all-zero point:
    expect(tweetnacl.scalarMult(sk, zero)).toEqual(zero);
  });

  it('rejects the small-order "universal" Ed25519 signature TweetNaCl accepts', () => {
    const identity = new Uint8Array(32);
    identity[0] = 1;
    const sig = new Uint8Array(64);
    sig.set(identity, 0); // R = identity, S = 0
    const msg = new TextEncoder().encode('any message at all');
    expect(tweetnacl.sign.detached.verify(msg, sig, identity)).toBe(true);
    expect(nacl.sign.detached.verify(msg, sig, identity)).toBe(false);
    expect(verifyDetached(msg, sig, identity)).toBe(false);
  });

  it('bounds HKDF output like RFC 5869', () => {
    expect(() => hkdfSha256(rand(32), undefined, undefined, 0)).toThrow(/length/);
    expect(() => hkdfSha256(rand(32), undefined, undefined, 255 * 32 + 1)).toThrow(/length/);
    expect(hkdfSha256(rand(32), undefined, undefined, 255 * 32)).toHaveLength(255 * 32);
  });

  it('randomBytes is fresh and fills the requested length', () => {
    const a = nacl.randomBytes(64);
    const b = nacl.randomBytes(64);
    expect(a).toHaveLength(64);
    expect(a).not.toEqual(b);
    expect(nacl.randomBytes(0)).toHaveLength(0);
  });
});

describe('argon2id (native, async)', () => {
  const enc = new TextEncoder();

  it('matches @noble Argon2id, including 32-byte and domain-string salts', async () => {
    const cases: Array<[Uint8Array, Uint8Array, { t: number; m: number; dkLen: number }]> = [
      [enc.encode('1234'), rand(16), { t: 2, m: 19456, dkLen: 32 }],
      [enc.encode('4321'), enc.encode('aegislink:panic:v1:'), { t: 1, m: 2048, dkLen: 32 }],
      [enc.encode('a passphrase'), rand(32), { t: 1, m: 256, dkLen: 32 }],
      [new Uint8Array(0), rand(8), { t: 1, m: 8, dkLen: 16 }],
    ];
    for (const [pwd, salt, o] of cases) {
      const want = nobleArgon2id(pwd, salt, { ...o, p: 1 });
      expect(await argon2id(pwd, salt, { ...o, p: 1 })).toEqual(want);
    }
  });

  it('rejects out-of-range parameters before calling native code', async () => {
    const pwd = enc.encode('x');
    const bad: Array<[Uint8Array, { t: number; m: number; dkLen: number }, RegExp]> = [
      [rand(7), { t: 1, m: 64, dkLen: 32 }, /salt/],
      [rand(65), { t: 1, m: 64, dkLen: 32 }, /salt/],
      [rand(16), { t: 0, m: 64, dkLen: 32 }, /t must/],
      [rand(16), { t: 1, m: 7, dkLen: 32 }, /m must/],
      [rand(16), { t: 1, m: 262145, dkLen: 32 }, /m must/],
      [rand(16), { t: 1, m: 64, dkLen: 15 }, /dkLen/],
      [rand(16), { t: 1.5, m: 64, dkLen: 32 }, /t must/],
    ];
    for (const [salt, o, msg] of bad) {
      await expect(argon2id(pwd, salt, { ...o, p: 1 })).rejects.toThrow(msg);
    }
    await expect(argon2id(pwd, rand(16), { t: 1, m: 64, dkLen: 32, p: 2 as 1 })).rejects.toThrow(/p = 1/);
    await expect(argon2id('x' as unknown as Uint8Array, rand(16), { t: 1, m: 64, dkLen: 32, p: 1 })).rejects.toThrow(
      TypeError,
    );
  });
});

describe('native return codes are never ignored', () => {
  it('a native failure the JS checks did not predict throws instead of returning garbage', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../modules/aegis-sodium', () => {
        const real = jest.requireActual('../../../modules/aegis-sodium/jest/nodeBackend');
        return { __esModule: true, ...real, default: { ...real.default, secretboxEasy: () => -2, hmacsha256: () => -1 } };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const facade = require('../sodium') as typeof import('../sodium');
      expect(() => facade.nacl.secretbox(new Uint8Array(1), rand(24), rand(32))).toThrow(/secretbox failed/);
      expect(() => facade.hmacSha256(rand(32), rand(8))).toThrow(/hmacSha256 failed/);
    });
  });

  it('a rejected or malformed native argon2id result throws instead of returning a key', async () => {
    const results: Array<() => Promise<number[]>> = [
      () => Promise.reject(new Error('aegis_argon2id failed: -2')),
      () => Promise.resolve([1, 2, 3]),
    ];
    for (const result of results) {
      let facade!: typeof import('../sodium');
      jest.isolateModules(() => {
        jest.doMock('../../../modules/aegis-sodium', () => {
          const real = jest.requireActual('../../../modules/aegis-sodium/jest/nodeBackend');
          return { __esModule: true, ...real, default: { ...real.default, argon2id: result } };
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        facade = require('../sodium') as typeof import('../sodium');
      });
      await expect(facade.argon2id(new Uint8Array(1), rand(16), { t: 1, m: 64, p: 1, dkLen: 32 })).rejects.toThrow(
        /argon2id failed/,
      );
    }
  });

  it('refuses to load when libsodium does not initialize', () => {
    jest.isolateModules(() => {
      jest.doMock('../../../modules/aegis-sodium', () => {
        const real = jest.requireActual('../../../modules/aegis-sodium/jest/nodeBackend');
        return { __esModule: true, ...real, default: { ...real.default, init: () => -2 } };
      });
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      expect(() => require('../sodium')).toThrow(/failed to initialize/);
    });
  });
});

describe('powSha256 (native, async)', () => {
  it('fails closed on a native rejection or a malformed nonce', async () => {
    const results = [
      () => Promise.reject(new Error('aegis_pow_sha256 failed: -2')),
      () => Promise.resolve('0000000'),
      () => Promise.resolve('0000000G'),
      () => Promise.resolve(undefined),
    ];
    for (const result of results) {
      let facade!: typeof import('../sodium');
      jest.isolateModules(() => {
        jest.doMock('../../../modules/aegis-sodium', () => {
          const real = jest.requireActual('../../../modules/aegis-sodium/jest/nodeBackend');
          return { __esModule: true, ...real, default: { ...real.default, powSha256: result } };
        });
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        facade = require('../sodium') as typeof import('../sodium');
      });
      await expect(facade.powSha256(new Uint8Array([0x61]), 1)).rejects.toThrow(/pow_?sha256 failed/i);
    }
  });

  it('rejects out-of-range parameters before calling native code', async () => {
    const { powSha256 } = await import('../sodium');
    await expect(powSha256(new Uint8Array(0), 1)).rejects.toThrow(/challenge/);
    await expect(powSha256(new Uint8Array(513), 1)).rejects.toThrow(/challenge/);
    await expect(powSha256(new Uint8Array(1), 33)).rejects.toThrow(/difficulty/);
    await expect(powSha256(new Uint8Array(1), -1)).rejects.toThrow(/difficulty/);
    await expect(powSha256(new Uint8Array(1), 1.5)).rejects.toThrow(/difficulty/);
  });
});

describe('ml_kem768 (native)', () => {
  it('is byte-identical to @noble/post-quantum and reads keys it made', async () => {
    const { ml_kem768 } = await import('../sodium');
    for (let i = 0; i < 20; i++) {
      const seed = rand(64);
      const mine = ml_kem768.keygen(seed);
      const theirs = nobleMlKem.keygen(seed);
      expect(mine.publicKey).toEqual(theirs.publicKey);
      expect(mine.secretKey).toEqual(theirs.secretKey);
      expect(ml_kem768.getPublicKey(theirs.secretKey)).toEqual(theirs.publicKey);
      // A key stored by the old code (@noble, no seed) decapsulates natively...
      const stored = nobleMlKem.keygen();
      const e = nobleMlKem.encapsulate(stored.publicKey);
      expect(ml_kem768.decapsulate(e.cipherText, stored.secretKey)).toEqual(e.sharedSecret);
      // ...and a peer still on @noble decapsulates what we encapsulate.
      const mineE = ml_kem768.encapsulate(stored.publicKey);
      expect(nobleMlKem.decapsulate(mineE.cipherText, stored.secretKey)).toEqual(mineE.sharedSecret);
      // Implicit rejection: a tampered ciphertext gives @noble's pseudo-random secret, no throw.
      const bad = e.cipherText.slice();
      bad[i] ^= 1;
      expect(ml_kem768.decapsulate(bad, stored.secretKey)).toEqual(nobleMlKem.decapsulate(bad, stored.secretKey));
    }
  });

  it('getPublicKey returns a copy, not a view into the secret key', async () => {
    const { ml_kem768 } = await import('../sodium');
    const k = ml_kem768.keygen();
    const pk = ml_kem768.getPublicKey(k.secretKey);
    pk.fill(0);
    expect(ml_kem768.getPublicKey(k.secretKey)).toEqual(k.publicKey);
  });

  it('fails closed: wrong lengths, an invalid public key and a corrupted secret key throw', async () => {
    const { ml_kem768 } = await import('../sodium');
    const k = ml_kem768.keygen();
    const e = ml_kem768.encapsulate(k.publicKey);
    expect(() => ml_kem768.keygen(rand(63))).toThrow(/seed must be 64 bytes/);
    expect(() => ml_kem768.encapsulate(rand(1183))).toThrow(/bad public key size/);
    expect(() => ml_kem768.decapsulate(rand(1087), k.secretKey)).toThrow(/bad ciphertext size/);
    expect(() => ml_kem768.decapsulate(e.cipherText, rand(2399))).toThrow(/bad secret key size/);
    expect(() => ml_kem768.getPublicKey(rand(1184))).toThrow(/bad secret key size/);
    const nonCanonical = k.publicKey.slice();
    nonCanonical[0] = 0xff;
    nonCanonical[1] |= 0x0f;
    expect(() => ml_kem768.encapsulate(nonCanonical)).toThrow(/mlkem768 encapsulate failed/);
    const corrupt = k.secretKey.slice();
    corrupt[1152 + 1184] ^= 1;
    expect(() => ml_kem768.decapsulate(e.cipherText, corrupt)).toThrow(/mlkem768 decapsulate failed/);
    expect(() => ml_kem768.encapsulate('x' as unknown as Uint8Array)).toThrow(TypeError);
  });
});

describe('pbkdf2Sha256 (native, async)', () => {
  it('matches @noble pbkdf2(sha256) and RFC 7914 §11', async () => {
    const { pbkdf2Sha256 } = await import('../sodium');
    const enc = new TextEncoder();
    const rfc = await pbkdf2Sha256(enc.encode('passwd'), enc.encode('salt'), 1, 64);
    expect(Buffer.from(rfc).toString('hex')).toBe(
      '55ac046e56e3089fec1691c22544b605f94185216dde0465e68b9d57c20dacbc49ca9cccf179b645991664b39d77ef317c71b845b1e30bd509112041d3a19783',
    );
    for (const [pwd, salt, c] of [[rand(20), rand(32), 1000], [new Uint8Array(0), rand(16), 3], [rand(200), new Uint8Array(0), 2]] as const) {
      expect(await pbkdf2Sha256(pwd, salt, c, 32)).toEqual(noblePbkdf2(nobleSha256, pwd, salt, { c, dkLen: 32 }));
    }
  });

  it('rejects out-of-range parameters before calling native code', async () => {
    const { pbkdf2Sha256 } = await import('../sodium');
    await expect(pbkdf2Sha256(rand(4), rand(16), 0, 32)).rejects.toThrow(/iterations/);
    await expect(pbkdf2Sha256(rand(4), rand(16), 1, 65)).rejects.toThrow(/dkLen/);
    await expect(pbkdf2Sha256(rand(4), rand(1025), 1, 32)).rejects.toThrow(/salt/);
  });
});
