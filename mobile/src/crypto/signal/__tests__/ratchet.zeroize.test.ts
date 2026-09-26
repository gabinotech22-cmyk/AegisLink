/**
 * Regression (audit 2026-06-30, "zeroization coverage"): ratchetEncrypt wipes
 * the per-message key once the message is sealed, also when sealing throws.
 *
 * Since F-1b phase 3 the ratchet runs inside the key vault: the message key
 * never reaches JavaScript at all (first test), and the vault's algorithm
 * wipes it (the TypeScript twin of the C core is checked here; the C core
 * wipes with sodium_memzero). Twin:
 * `desktop/src/renderer/crypto/signal/__tests__/ratchet.zeroize.test.ts`.
 */
const mockFacadeSeals: Uint8Array[] = [];

jest.mock('../../sodium', () => {
  const real = jest.requireActual('../../sodium');
  const secretbox = Object.assign(
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array => {
      mockFacadeSeals.push(key);
      return real.nacl.secretbox(msg, nonce, key);
    },
    real.nacl.secretbox,
  );
  return { ...real, nacl: { ...real.nacl, secretbox } };
});

import { nacl } from '../../sodium';
import { initRatchet, ratchetEncrypt, ratchetDecrypt } from '../ratchet';
import * as core from '../../../../modules/aegis-sodium/jest/ratchetCore';
import { nodePrims } from '../../../../modules/aegis-sodium/jest/nodeRatchet';

describe('ratchetEncrypt message-key zeroization', () => {
  it('no message key ever reaches JavaScript: the vault seals the message itself', () => {
    const root = nacl.randomBytes(32);
    const spk = nacl.box.keyPair();
    const alice = initRatchet('self', root, spk.publicKey, true);
    const bob = initRatchet('self', root, new Uint8Array(), false, spk);

    for (const text of ['one', 'two']) {
      mockFacadeSeals.length = 0;
      const m = ratchetEncrypt(alice, new TextEncoder().encode(text));
      expect(mockFacadeSeals).toHaveLength(0);
      const out = ratchetDecrypt(bob, m.header, m.ciphertext, m.nonce);
      expect(out && new TextDecoder().decode(out)).toBe(text);
    }
  });

  function recordingPrims(fail: { on: boolean }, seen: Uint8Array[]): core.RatchetPrims {
    return {
      ...nodePrims,
      secretbox: (m, n, k) => {
        seen.push(k);
        if (fail.on) throw new Error('seal failed');
        return nodePrims.secretbox(m, n, k);
      },
    };
  }

  it('the vault algorithm zeroes the message key after sealing', () => {
    const seen: Uint8Array[] = [];
    const p = recordingPrims({ on: false }, seen);
    const spk = nacl.box.keyPair();
    const s = core.initAlice(p, nacl.randomBytes(32), spk.publicKey, null);
    core.ratchetEncrypt(p, s, new TextEncoder().encode('x'));
    expect(seen).toHaveLength(1);
    expect(seen[0].length).toBe(32);
    expect(seen[0].every((b) => b === 0)).toBe(true);
  });

  it('the vault algorithm zeroes the message key even when sealing throws', () => {
    const seen: Uint8Array[] = [];
    const p = recordingPrims({ on: true }, seen);
    const spk = nacl.box.keyPair();
    const s = core.initAlice(p, nacl.randomBytes(32), spk.publicKey, null);
    expect(() => core.ratchetEncrypt(p, s, new TextEncoder().encode('x'))).toThrow('seal failed');
    expect(seen).toHaveLength(1);
    expect(seen[0].every((b) => b === 0)).toBe(true);
  });
});
