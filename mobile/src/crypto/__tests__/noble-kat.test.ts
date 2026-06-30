/**
 * Cross-platform Known-Answer Test (KAT) for @noble/hashes.
 *
 * Audit-finding H3: mobile pins @noble/hashes v1.x while desktop pins v2.x.
 * The algorithms (SHA-256, HMAC, HKDF, PBKDF2) are version-independent, but to
 * guarantee mobile↔desktop crypto parity (golden rule #5) this test asserts the
 * library produces the exact bytes of public RFC test vectors. The desktop suite
 * (`desktop/src/renderer/crypto/__tests__/noble-kat.test.ts`) asserts the SAME
 * vectors against its v2 build — if either platform's library ever changes output,
 * its KAT fails. Keep the two files in lock-step.
 */
import { sha256 } from '@noble/hashes/sha2';
import { hmac } from '@noble/hashes/hmac';
import { hkdf } from '@noble/hashes/hkdf';
import { pbkdf2 } from '@noble/hashes/pbkdf2';

const ascii = (s: string): Uint8Array => Uint8Array.from(s, (c) => c.charCodeAt(0));
const hex = (s: string): Uint8Array =>
  new Uint8Array((s.match(/.{2}/g) ?? []).map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('@noble/hashes cross-platform KAT (H3 parity lock)', () => {
  it('SHA-256("abc") matches the FIPS-180 vector', () => {
    expect(toHex(sha256(ascii('abc')))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('HMAC-SHA256 matches RFC 4231 test case 2', () => {
    const mac = hmac(sha256, ascii('Jefe'), ascii('what do ya want for nothing?'));
    expect(toHex(mac)).toBe(
      '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843',
    );
  });

  it('HKDF-SHA256 matches RFC 5869 test case 1', () => {
    const okm = hkdf(sha256, hex('0b'.repeat(22)), hex('000102030405060708090a0b0c'), hex('f0f1f2f3f4f5f6f7f8f9'), 42);
    expect(toHex(okm)).toBe(
      '3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865',
    );
  });

  it('PBKDF2-SHA256("password","salt",c=1,dkLen=32) matches the reference vector', () => {
    const dk = pbkdf2(sha256, ascii('password'), ascii('salt'), { c: 1, dkLen: 32 });
    expect(toHex(dk)).toBe(
      '120fb6cffcf8b32c43e7225256c4f837a86548c92ccc35480805987cb70be17b',
    );
  });
});
