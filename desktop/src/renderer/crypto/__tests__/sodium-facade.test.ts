/**
 * F-1 renderer facade: it runs on native libsodium in the main process over
 * IPC. These tests pin the contract the rest of the renderer relies on:
 *   - fail closed when the preload bridge is missing (no JS fallback);
 *   - errors keep TweetNaCl's class and message across the IPC envelope;
 *   - the async attachment variants produce the same bytes as the sync ones.
 * (The vitest alias replaces `./sodiumIpcBridge` inside the facade only; the
 * real bridge module is imported here by a different specifier.)
 */
import { describe, it, expect } from 'vitest';
import { sodiumBridge } from '../sodium/sodiumIpcBridge';
import { nacl, secretboxAsync, secretboxOpenAsync } from '../sodium';

describe('renderer sodium facade', () => {
  it('the real bridge fails closed without window.aegis.sodium', () => {
    expect(() => sodiumBridge()).toThrow(/native crypto bridge unavailable/);
  });

  it('re-throws primitive errors with TweetNaCl class and message', () => {
    expect(() => nacl.secretbox(new Uint8Array(1), new Uint8Array(23), new Uint8Array(32))).toThrow('bad nonce size');
    expect(() => nacl.sign.detached(new Uint8Array(1), new Uint8Array(32))).toThrow('bad secret key size');
    expect(() => nacl.secretbox([1] as unknown as Uint8Array, new Uint8Array(24), new Uint8Array(32))).toThrow(TypeError);
  });

  it('open returns null on MAC failure across the bridge', () => {
    const key = nacl.randomBytes(32);
    const nonce = nacl.randomBytes(24);
    const c = nacl.secretbox(new Uint8Array([1, 2, 3]), nonce, key);
    c[0] ^= 1;
    expect(nacl.secretbox.open(c, nonce, key)).toBeNull();
  });

  it('async attachment variants match the sync primitive', async () => {
    const key = nacl.randomBytes(32);
    const nonce = nacl.randomBytes(24);
    const file = nacl.randomBytes(200_000);
    const sealed = await secretboxAsync(file, nonce, key);
    expect(sealed).toEqual(nacl.secretbox(file, nonce, key));
    expect(await secretboxOpenAsync(sealed, nonce, key)).toEqual(file);
    sealed[5] ^= 1;
    expect(await secretboxOpenAsync(sealed, nonce, key)).toBeNull();
  });

  it('key pairs cross the bridge as plain Uint8Arrays', () => {
    const kp = nacl.box.keyPair();
    expect(Object.getPrototypeOf(kp.publicKey)).toBe(Uint8Array.prototype);
    expect(nacl.scalarMult.base(kp.secretKey)).toEqual(kp.publicKey);
  });
});
