/**
 * `boxBefore` composes crypto_box_beforenm from sodium-native's X25519 and
 * Salsa20 (sodium-native exposes neither beforenm nor HSalsa20). Public-channel
 * approvals derive their wrap key from it and must agree byte-for-byte with
 * mobile (libsodium crypto_box_beforenm) — TweetNaCl's `box.before` is the
 * oracle here, as in `sodium-native.differential.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { boxBefore } from '../sodium/boxBefore';
import { runSodiumOp, MAX_SYNC_ARG_BYTES } from '../sodium/ops';

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');

describe('boxBefore (crypto_box_beforenm on sodium-native)', () => {
  it('matches TweetNaCl box.before on random key pairs', () => {
    for (let i = 0; i < 200; i++) {
      const a = nacl.box.keyPair();
      const b = nacl.box.keyPair();
      expect(hex(boxBefore(b.publicKey, a.secretKey))).toBe(hex(nacl.box.before(b.publicKey, a.secretKey)));
    }
  });

  it('is symmetric and opens a box sealed with the full key pair', () => {
    const a = nacl.box.keyPair();
    const b = nacl.box.keyPair();
    const k = boxBefore(b.publicKey, a.secretKey);
    expect(hex(k)).toBe(hex(boxBefore(a.publicKey, b.secretKey)));
    const nonce = nacl.randomBytes(24);
    const sealed = nacl.box(new Uint8Array([1, 2, 3]), nonce, b.publicKey, a.secretKey);
    expect(nacl.box.open.after(sealed, nonce, k)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('throws on a low-order public key instead of deriving a key from zero', () => {
    const sk = nacl.randomBytes(32);
    expect(() => boxBefore(new Uint8Array(32), sk)).toThrow(/low-order/);
  });

  it('rejects wrong lengths and non-byte arguments', () => {
    expect(() => boxBefore(new Uint8Array(31), new Uint8Array(32))).toThrow('bad public key size');
    expect(() => boxBefore(new Uint8Array(32), new Uint8Array(33))).toThrow('bad secret key size');
    expect(() => boxBefore([1] as unknown as Uint8Array, new Uint8Array(32))).toThrow(TypeError);
  });

  it('is reachable over the IPC op table, with verify', () => {
    const a = nacl.box.keyPair();
    const b = nacl.box.keyPair();
    const r = runSodiumOp('boxBefore', [b.publicKey, a.secretKey], MAX_SYNC_ARG_BYTES);
    expect(r.ok && hex(r.value as Uint8Array)).toBe(hex(nacl.box.before(b.publicKey, a.secretKey)));
    const x = nacl.randomBytes(32);
    expect(runSodiumOp('verify', [x, new Uint8Array(x)], MAX_SYNC_ARG_BYTES)).toEqual({ ok: true, value: true });
    expect(runSodiumOp('verify', [x, new Uint8Array(32)], MAX_SYNC_ARG_BYTES)).toEqual({ ok: true, value: false });
    expect(runSodiumOp('verify', [x, x.subarray(0, 16)], MAX_SYNC_ARG_BYTES)).toEqual({ ok: true, value: false });
    expect(runSodiumOp('verify', [new Uint8Array(0), new Uint8Array(0)], MAX_SYNC_ARG_BYTES)).toEqual({ ok: true, value: false });
  });
});
