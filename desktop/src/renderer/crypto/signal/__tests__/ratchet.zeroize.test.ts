/**
 * Regression (audit 2026-06-30, "zeroization coverage"): ratchetEncrypt wipes
 * the per-message key once the message is sealed — also when sealing throws —
 * as mobile's twin does
 * (`mobile/src/crypto/signal/__tests__/ratchet.zeroize.test.ts`). Desktop used
 * to skip the wipe when sealing threw.
 */
import { describe, it, expect, vi } from 'vitest';

const seenKeys: Uint8Array[] = [];
const failSeal = { on: false };

vi.mock('../../sodium', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../sodium')>();
  const secretbox = Object.assign(
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array => {
      seenKeys.push(key);
      if (failSeal.on) throw new Error('seal failed');
      return real.nacl.secretbox(msg, nonce, key);
    },
    real.nacl.secretbox,
  );
  return { ...real, nacl: { ...real.nacl, secretbox } };
});

const { nacl } = await import('../../sodium');
const { initRatchet, ratchetEncrypt, ratchetDecrypt } = await import('../ratchet');

describe('ratchetEncrypt message-key zeroization', () => {
  it('zeroes the message key after sealing, and the message still decrypts', () => {
    const root = nacl.randomBytes(32);
    const spk = nacl.box.keyPair();
    const alice = initRatchet(new Uint8Array(root), spk.publicKey, true);
    const bob = initRatchet(new Uint8Array(root), new Uint8Array(), false, spk);

    for (const text of ['one', 'two']) {
      seenKeys.length = 0;
      const m = ratchetEncrypt(alice, new TextEncoder().encode(text));
      expect(seenKeys).toHaveLength(1);
      expect(seenKeys[0].length).toBe(32);
      expect(seenKeys[0].every((b) => b === 0)).toBe(true);
      const out = ratchetDecrypt(bob, m.header, m.ciphertext, m.nonce);
      expect(out && new TextDecoder().decode(out)).toBe(text);
    }
  });

  it('zeroes the message key even when sealing throws', () => {
    const root = nacl.randomBytes(32);
    const spk = nacl.box.keyPair();
    const alice = initRatchet(new Uint8Array(root), spk.publicKey, true);
    seenKeys.length = 0;
    failSeal.on = true;
    try {
      expect(() => ratchetEncrypt(alice, new TextEncoder().encode('x'))).toThrow('seal failed');
    } finally {
      failSeal.on = false;
    }
    expect(seenKeys).toHaveLength(1);
    expect(seenKeys[0].every((b) => b === 0)).toBe(true);
  });
});
