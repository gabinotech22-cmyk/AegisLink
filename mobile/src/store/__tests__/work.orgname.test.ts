/**
 * Unit tests for the workspace name encryption scheme used in store/work.ts.
 *
 * We mirror the exact crypto logic here (nacl secretbox, sha256 key derivation)
 * to validate the round-trip without having to export private helpers.
 *
 * Tests:
 *   1. encrypt → decrypt round-trip returns the original name.
 *   2. Different secret keys produce different ciphertexts (key isolation).
 *   3. A truncated ciphertext fails gracefully (returns null, not throws).
 *   4. Plaintext fallback: if decryption fails, the raw server value is returned as-is.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';

// ------ Mirror the private helpers from store/work.ts ------

const DOMAIN_TAG = new TextEncoder().encode('aegis.work.orgname.v1');

function deriveOrgNameKey(secretKeyB64: string): Uint8Array {
  const sk = decodeBase64(secretKeyB64);
  const material = new Uint8Array(DOMAIN_TAG.length + sk.length);
  material.set(DOMAIN_TAG, 0);
  material.set(sk, DOMAIN_TAG.length);
  return sha256(material);
}

function encryptOrgName(name: string, secretKeyB64: string): string {
  const key = deriveOrgNameKey(secretKeyB64);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(new TextEncoder().encode(name), nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return encodeBase64(out);
}

function decryptOrgName(encrypted: string, secretKeyB64: string): string | null {
  try {
    const key = deriveOrgNameKey(secretKeyB64);
    const data = decodeBase64(encrypted);
    const nonce = data.slice(0, nacl.secretbox.nonceLength);
    const ct = data.slice(nacl.secretbox.nonceLength);
    const pt = nacl.secretbox.open(ct, nonce, key);
    if (!pt) return null;
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

// ------

function genSecretKeyB64(): string {
  return encodeBase64(nacl.randomBytes(32));
}

describe('Work org name encryption', () => {
  it('round-trips a plain org name through encrypt → decrypt', () => {
    const sk = genSecretKeyB64();
    const name = 'Acme Corp Security Team';
    const encrypted = encryptOrgName(name, sk);
    const decrypted = decryptOrgName(encrypted, sk);
    expect(decrypted).toBe(name);
  });

  it('round-trips Unicode org name', () => {
    const sk = genSecretKeyB64();
    const name = 'équipe sécurité 🔐';
    expect(decryptOrgName(encryptOrgName(name, sk), sk)).toBe(name);
  });

  it('different secret keys produce different ciphertexts', () => {
    const sk1 = genSecretKeyB64();
    const sk2 = genSecretKeyB64();
    const name = 'Red Team';
    const ct1 = encryptOrgName(name, sk1);
    const ct2 = encryptOrgName(name, sk2);
    expect(ct1).not.toBe(ct2);
  });

  it('two encryptions of the same name differ (random nonce)', () => {
    const sk = genSecretKeyB64();
    const name = 'Ops';
    const ct1 = encryptOrgName(name, sk);
    const ct2 = encryptOrgName(name, sk);
    expect(ct1).not.toBe(ct2);
  });

  it('decryptOrgName returns null for wrong key', () => {
    const sk = genSecretKeyB64();
    const wrongSk = genSecretKeyB64();
    const ct = encryptOrgName('Secret', sk);
    expect(decryptOrgName(ct, wrongSk)).toBeNull();
  });

  it('decryptOrgName returns null for truncated ciphertext', () => {
    const sk = genSecretKeyB64();
    const ct = encryptOrgName('Short', sk);
    // Truncate to just a few bytes — too short to parse
    const truncated = encodeBase64(decodeBase64(ct).slice(0, 4));
    expect(decryptOrgName(truncated, sk)).toBeNull();
  });

  it('fallback: plain text server value is returned unchanged when decryption fails', () => {
    // Simulate the maybeDecryptOrgName fallback in the store
    const rawName = 'PlaintextOrgFromOldServer';
    const sk = genSecretKeyB64();
    const result = decryptOrgName(rawName, sk) ?? rawName;
    expect(result).toBe(rawName);
  });
});
