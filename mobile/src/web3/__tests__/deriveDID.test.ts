/**
 * deriveDID.test.ts
 *
 * Tests the round-trip: publicKey → DID → publicKey
 * and validates the multicodec prefix and multibase encoding.
 */

import nacl from 'tweetnacl';
import { deriveDIDFromPublicKey, publicKeyFromDID } from '../did/deriveDID';

describe('deriveDIDFromPublicKey', () => {
  it('produces a did:key:z... identifier', () => {
    const { publicKey } = nacl.sign.keyPair();
    const did = deriveDIDFromPublicKey(publicKey);
    expect(did).toMatch(/^did:key:z[1-9A-HJ-NP-Za-km-z]+$/);
  });

  it('round-trips: DID → publicKey returns the original key', () => {
    const { publicKey } = nacl.sign.keyPair();
    const did = deriveDIDFromPublicKey(publicKey);
    const recovered = publicKeyFromDID(did);
    expect(recovered).toEqual(publicKey);
  });

  it('produces a deterministic DID for the same key', () => {
    const { publicKey } = nacl.sign.keyPair();
    const did1 = deriveDIDFromPublicKey(publicKey);
    const did2 = deriveDIDFromPublicKey(publicKey);
    expect(did1).toBe(did2);
  });

  it('produces different DIDs for different keys', () => {
    const kp1 = nacl.sign.keyPair();
    const kp2 = nacl.sign.keyPair();
    expect(deriveDIDFromPublicKey(kp1.publicKey)).not.toBe(
      deriveDIDFromPublicKey(kp2.publicKey)
    );
  });

  it('throws for a key that is not 32 bytes', () => {
    expect(() => deriveDIDFromPublicKey(new Uint8Array(16))).toThrow('32 bytes');
    expect(() => deriveDIDFromPublicKey(new Uint8Array(64))).toThrow('32 bytes');
  });
});

describe('publicKeyFromDID', () => {
  it('throws for a non-did:key:z DID', () => {
    expect(() => publicKeyFromDID('did:ethr:0xabc')).toThrow('did:key:z');
  });

  it('throws for a key with the wrong multicodec prefix', () => {
    // Manually encode a secp256k1 key prefix (0xe7, 0x01) to simulate wrong method.
    const { base58 } = require('@scure/base');
    const fakePrefix = new Uint8Array([0xe7, 0x01, ...new Uint8Array(32)]);
    const encoded = base58.encode(fakePrefix);
    const fakeDID = `did:key:z${encoded}`;
    expect(() => publicKeyFromDID(fakeDID)).toThrow('Ed25519');
  });
});
