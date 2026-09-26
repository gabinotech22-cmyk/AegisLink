/**
 * Regression (audit 2026-06-30, "zeroization coverage"): ratchetEncrypt wipes
 * the per-message key once the message is sealed, also when sealing throws.
 *
 * Since F-1b phase 3 the ratchet runs in the key vault of the main process:
 * the message key never reaches the renderer at all (this test). The vault's
 * algorithm wipes it (`src/main/crypto/vault/__tests__/ratchet.test.ts`).
 * Twin: `mobile/src/crypto/signal/__tests__/ratchet.zeroize.test.ts`.
 */
import { describe, it, expect, vi } from 'vitest';

const facadeSeals: Uint8Array[] = [];

vi.mock('../../sodium', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../sodium')>();
  const secretbox = Object.assign(
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array => {
      facadeSeals.push(key);
      return real.nacl.secretbox(msg, nonce, key);
    },
    real.nacl.secretbox,
  );
  return { ...real, nacl: { ...real.nacl, secretbox } };
});

const { nacl } = await import('../../sodium');
const { initRatchet, ratchetEncrypt, ratchetDecrypt } = await import('../ratchet');

describe('ratchetEncrypt message-key zeroization', () => {
  it('no message key ever reaches the renderer: the vault seals the message itself', () => {
    const root = nacl.randomBytes(32);
    const spk = nacl.box.keyPair();
    const alice = initRatchet('self', root, spk.publicKey, true);
    const bob = initRatchet('self', root, new Uint8Array(), false, spk);

    for (const text of ['one', 'two']) {
      facadeSeals.length = 0;
      const m = ratchetEncrypt(alice, new TextEncoder().encode(text));
      expect(facadeSeals).toHaveLength(0);
      const out = ratchetDecrypt(bob, m.header, m.ciphertext, m.nonce);
      expect(out && new TextDecoder().decode(out)).toBe(text);
    }
  });
});
