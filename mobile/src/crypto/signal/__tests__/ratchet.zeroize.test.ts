/**
 * Regression (audit 2026-06-30, "zeroization coverage"): ratchetEncrypt wipes
 * the per-message key once the message is sealed, also when sealing throws. Twin:
 * `desktop/src/renderer/crypto/signal/__tests__/ratchet.zeroize.test.ts`.
 */
const mockSeenKeys: Uint8Array[] = [];
const mockFailSeal = { on: false };

jest.mock('../../sodium', () => {
  const real = jest.requireActual('../../sodium');
  const secretbox = Object.assign(
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array => {
      mockSeenKeys.push(key);
      if (mockFailSeal.on) throw new Error('seal failed');
      return real.nacl.secretbox(msg, nonce, key);
    },
    real.nacl.secretbox,
  );
  return { ...real, nacl: { ...real.nacl, secretbox } };
});

import { nacl } from '../../sodium';
import { initRatchet, ratchetEncrypt, ratchetDecrypt } from '../ratchet';

describe('ratchetEncrypt message-key zeroization', () => {
  it('zeroes the message key after sealing, and the message still decrypts', () => {
    const root = nacl.randomBytes(32);
    const spk = nacl.box.keyPair();
    const alice = initRatchet(new Uint8Array(root), spk.publicKey, true);
    const bob = initRatchet(new Uint8Array(root), new Uint8Array(), false, spk);

    for (const text of ['one', 'two']) {
      mockSeenKeys.length = 0;
      const m = ratchetEncrypt(alice, new TextEncoder().encode(text));
      expect(mockSeenKeys).toHaveLength(1);
      expect(mockSeenKeys[0].length).toBe(32);
      expect(mockSeenKeys[0].every((b) => b === 0)).toBe(true);
      const out = ratchetDecrypt(bob, m.header, m.ciphertext, m.nonce);
      expect(out && new TextDecoder().decode(out)).toBe(text);
    }
  });

  it('zeroes the message key even when sealing throws', () => {
    const root = nacl.randomBytes(32);
    const spk = nacl.box.keyPair();
    const alice = initRatchet(new Uint8Array(root), spk.publicKey, true);
    mockSeenKeys.length = 0;
    mockFailSeal.on = true;
    try {
      expect(() => ratchetEncrypt(alice, new TextEncoder().encode('x'))).toThrow('seal failed');
    } finally {
      mockFailSeal.on = false;
    }
    expect(mockSeenKeys).toHaveLength(1);
    expect(mockSeenKeys[0].every((b) => b === 0)).toBe(true);
  });
});
