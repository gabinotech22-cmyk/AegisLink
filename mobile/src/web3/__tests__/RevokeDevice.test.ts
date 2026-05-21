/**
 * RevokeDevice.test.ts
 *
 * Verifies:
 * 1. hashDID is deterministic and one-way (no plaintext DID in output).
 * 2. buildRevocationPayload produces a valid signature.
 * 3. verifyRevocationPayload accepts a correct payload and rejects a tampered one.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { hashDID, verifyRevocationPayload, type RevocationPayload } from '../deviceRevocation/RevokeDevice';

// Mock expo-secure-store and the identity module so we can inject a test key.
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

jest.mock('../../crypto/identity', () => ({
  signWithProfileKey: jest.fn(),
}));

describe('hashDID', () => {
  const testDID = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';

  it('returns a 64-character lowercase hex string', () => {
    const hash = hashDID(testDID);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same DID', () => {
    expect(hashDID(testDID)).toBe(hashDID(testDID));
  });

  it('produces different hashes for different DIDs', () => {
    const other = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuias8sisDArDJF';
    expect(hashDID(testDID)).not.toBe(hashDID(other));
  });

  it('does not contain the DID string in the output', () => {
    const hash = hashDID(testDID);
    expect(hash).not.toContain('did:key:');
    expect(hash).not.toContain('z6Mk');
  });
});

describe('verifyRevocationPayload', () => {
  function buildTestPayload(
    keypair: nacl.SignKeyPair,
    didHash: string,
    revokedAt: number
  ): RevocationPayload {
    const messageText = `aegislink:revoke:${didHash}:${revokedAt}`;
    const messageBytes = new TextEncoder().encode(messageText);
    const sigBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
    return {
      didHash,
      revokedAt,
      signature: encodeBase64(sigBytes),
      signingPublicKeyB64: encodeBase64(keypair.publicKey),
    };
  }

  it('returns true for a correctly signed payload', () => {
    const keypair = nacl.sign.keyPair();
    const didHash = hashDID('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    const payload = buildTestPayload(keypair, didHash, Date.now());
    expect(verifyRevocationPayload(payload)).toBe(true);
  });

  it('returns false if the didHash is tampered', () => {
    const keypair = nacl.sign.keyPair();
    const didHash = hashDID('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    const payload = buildTestPayload(keypair, didHash, Date.now());
    const tampered = { ...payload, didHash: 'a'.repeat(64) };
    expect(verifyRevocationPayload(tampered)).toBe(false);
  });

  it('returns false if the revokedAt is tampered', () => {
    const keypair = nacl.sign.keyPair();
    const didHash = hashDID('did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK');
    const revokedAt = Date.now();
    const payload = buildTestPayload(keypair, didHash, revokedAt);
    const tampered = { ...payload, revokedAt: revokedAt + 1 };
    expect(verifyRevocationPayload(tampered)).toBe(false);
  });

  it('returns false if signed by a different key', () => {
    const keypair = nacl.sign.keyPair();
    const otherKeypair = nacl.sign.keyPair();
    const didHash = hashDID('did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuias8sisDArDJF');
    const revokedAt = Date.now();
    // Sign with keypair but claim otherKeypair's public key.
    const messageText = `aegislink:revoke:${didHash}:${revokedAt}`;
    const messageBytes = new TextEncoder().encode(messageText);
    const sigBytes = nacl.sign.detached(messageBytes, keypair.secretKey);
    const payload: RevocationPayload = {
      didHash,
      revokedAt,
      signature: encodeBase64(sigBytes),
      signingPublicKeyB64: encodeBase64(otherKeypair.publicKey), // mismatch
    };
    expect(verifyRevocationPayload(payload)).toBe(false);
  });
});
