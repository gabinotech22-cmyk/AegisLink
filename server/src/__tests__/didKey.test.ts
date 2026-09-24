/**
 * didKey.test.ts — server did:key derivation must match the clients exactly.
 *
 * The vectors were produced with the mobile implementation
 * (mobile/src/web3/did/deriveDID.ts, @scure/base): if the relay and the app
 * disagreed on the DID string, the hash the relay stores on account deletion
 * would never match the DID a verifier resolves, and deactivation would silently
 * never show.
 */
import nacl from 'tweetnacl';
import {
  base58btcDecode,
  base58btcEncode,
  didHashHex,
  didKeyDocument,
  didKeyFromEd25519,
  ed25519FromDidKey,
} from '../crypto/didKey.js';

// Ed25519 key from seed 0x00..0x1f — same vector as the mobile deriveDID test.
const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const VECTOR = {
  publicKeyHex: '03a107bff3ce10be1d70dd18e74bc09967e4d6309ba50d5f1ddc8664125531b8',
  did: 'did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd',
  didHash: 'ef9b53055830b478d663ad000e5df0ac756d3a128b50d61cfe44d93e0e61a379',
};
// Example from the did:key specification.
const SPEC = {
  did: 'did:key:z6MkiTBz1ymuepAQ4HEHYSF1H8quG5GLVVQR3djdX3mDooWp',
  publicKeyHex: '3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29',
};

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');

describe('did:key derivation (parity with mobile)', () => {
  it('derives the same DID and hash as the mobile client', () => {
    const { publicKey } = nacl.sign.keyPair.fromSeed(SEED);
    expect(hex(publicKey)).toBe(VECTOR.publicKeyHex);
    expect(didKeyFromEd25519(publicKey)).toBe(VECTOR.did);
    expect(didHashHex(VECTOR.did)).toBe(VECTOR.didHash);
  });

  it('parses the did:key spec example back to its key', () => {
    const pk = ed25519FromDidKey(SPEC.did);
    expect(pk && hex(pk)).toBe(SPEC.publicKeyHex);
    expect(didKeyFromEd25519(Buffer.from(SPEC.publicKeyHex, 'hex'))).toBe(SPEC.did);
  });

  it('round-trips random keys', () => {
    for (let i = 0; i < 20; i++) {
      const { publicKey } = nacl.sign.keyPair();
      expect(hex(ed25519FromDidKey(didKeyFromEd25519(publicKey))!)).toBe(hex(publicKey));
    }
  });

  it('refuses a key of the wrong size', () => {
    expect(() => didKeyFromEd25519(new Uint8Array(31))).toThrow();
  });
});

describe('ed25519FromDidKey rejects anything but a canonical Ed25519 did:key', () => {
  it.each([
    ['another method', 'did:ethr:0xabc'],
    ['missing multibase z', VECTOR.did.replace('did:key:z', 'did:key:')],
    // A leading '1' is a zero byte: same key material, different string → it
    // would hash differently and dodge a deactivation lookup.
    ['non-canonical leading zero', VECTOR.did.replace('did:key:z', 'did:key:z1')],
    ['character outside base58', `${VECTOR.did.slice(0, -1)}0`],
    ['truncated', VECTOR.did.slice(0, -4)],
    // X25519 multicodec (0xec01) instead of Ed25519 (0xed01).
    ['wrong multicodec', `did:key:z${base58btcEncode(Uint8Array.from([0xec, 0x01, ...new Uint8Array(32).fill(7)]))}`],
  ])('%s', (_label, did) => {
    expect(ed25519FromDidKey(did)).toBeNull();
  });
});

describe('base58btc', () => {
  it('keeps leading zero bytes as leading 1s', () => {
    const bytes = Uint8Array.from([0, 0, 1, 2, 3]);
    const enc = base58btcEncode(bytes);
    expect(enc.startsWith('11')).toBe(true);
    expect(hex(base58btcDecode(enc)!)).toBe(hex(bytes));
  });

  it('returns null on invalid characters', () => {
    expect(base58btcDecode('0OIl')).toBeNull();
  });
});

describe('didKeyDocument', () => {
  it('builds a W3C document whose only key is the did:key itself', () => {
    const doc = didKeyDocument(VECTOR.did);
    const vmId = `${VECTOR.did}#${VECTOR.did.slice('did:key:'.length)}`;
    expect(doc.id).toBe(VECTOR.did);
    expect(doc.verificationMethod).toEqual([
      {
        id: vmId,
        type: 'Ed25519VerificationKey2020',
        controller: VECTOR.did,
        publicKeyMultibase: VECTOR.did.slice('did:key:'.length),
      },
    ]);
    for (const rel of ['authentication', 'assertionMethod', 'capabilityInvocation', 'capabilityDelegation'] as const) {
      expect(doc[rel]).toEqual([vmId]);
    }
    // No derived X25519 key: AegisLink never encrypts to one (see didKey.ts).
    expect(doc).not.toHaveProperty('keyAgreement');
  });
});
