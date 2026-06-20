import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { fingerprintHex, fingerprintWords } from '../fingerprint';

/**
 * Safety-number fingerprint (desktop). The hex form is the AUTHORITATIVE
 * 128-bit identifier; the words are a 64-bit human-memorable mnemonic. These
 * tests pin: determinism, the documented bit-widths, and that distinct keys
 * almost always produce distinct fingerprints.
 */
describe('fingerprint (desktop)', () => {
  const key = nacl.box.keyPair().publicKey;

  it('fingerprintHex is deterministic for the same key', () => {
    expect(fingerprintHex(key)).toEqual(fingerprintHex(key));
  });

  it('fingerprintWords is deterministic for the same key', () => {
    expect(fingerprintWords(key)).toEqual(fingerprintWords(key));
  });

  it('hex carries 128 bits — 8 groups of 4 hex chars (32 chars total)', () => {
    const groups = fingerprintHex(key);
    expect(groups).toHaveLength(8);
    for (const g of groups) expect(g).toMatch(/^[0-9a-f]{4}$/);
    expect(groups.join('')).toHaveLength(32); // 32 hex chars = 128 bits
  });

  it('words carry 64 bits — 8 words, each one byte from the 256-word list', () => {
    const words = fingerprintWords(key);
    expect(words).toHaveLength(8); // 8 bytes = 64 bits
    for (const w of words) expect(typeof w).toBe('string');
  });

  it('distinct keys produce distinct hex fingerprints', () => {
    const other = nacl.box.keyPair().publicKey;
    expect(fingerprintHex(key)).not.toEqual(fingerprintHex(other));
  });
});
