import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { deriveAegisId, keyMatchesAegisId, normalizeAegisId } from '../aegisId';

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

describe('aegisId derivation', () => {
  it('derives a well-formed, deterministic id from a key', () => {
    const { publicKey } = nacl.box.keyPair();
    const id = deriveAegisId(publicKey);
    expect(id).toMatch(AEGIS_ID_RE);
    expect(deriveAegisId(publicKey)).toBe(id);
  });

  it('throws on a too-short key', () => {
    expect(() => deriveAegisId(new Uint8Array(6))).toThrow();
  });
});

describe('keyMatchesAegisId — ID↔key binding', () => {
  it('accepts a key paired with its OWN derived id', () => {
    const { publicKey } = nacl.box.keyPair();
    const id = deriveAegisId(publicKey);
    expect(keyMatchesAegisId(encodeBase64(publicKey), id)).toBe(true);
  });

  it('is case-insensitive and trims the id', () => {
    const { publicKey } = nacl.box.keyPair();
    const id = deriveAegisId(publicKey);
    expect(keyMatchesAegisId(encodeBase64(publicKey), `  ${id.toLowerCase()}  `)).toBe(true);
    expect(normalizeAegisId(` ${id.toLowerCase()} `)).toBe(id);
  });

  it('REJECTS a key substituted under another contact’s id (the attack)', () => {
    const alice = nacl.box.keyPair();
    const mallory = nacl.box.keyPair();
    const aliceId = deriveAegisId(alice.publicKey);
    // Mallory's key presented under Alice's ID — a tampered QR or lying relay.
    expect(keyMatchesAegisId(encodeBase64(mallory.publicKey), aliceId)).toBe(false);
  });

  it('returns false (never throws) on malformed input', () => {
    expect(keyMatchesAegisId('not valid base64 !!!', 'AAA-AAAA-AAAA')).toBe(false);
    expect(keyMatchesAegisId('', '')).toBe(false);
    // A 31-byte key (too short to derive) must not match anything.
    expect(keyMatchesAegisId(encodeBase64(new Uint8Array(3)), 'AAA-AAAA-AAAA')).toBe(false);
  });
});
