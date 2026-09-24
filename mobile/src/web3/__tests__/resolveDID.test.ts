/**
 * resolveDID.test.ts — local DID resolution, in parity with the relay resolver
 * (server/src/routes/web3.ts GET /web3/did/resolve, crypto/didKey.ts).
 */

import nacl from 'tweetnacl';
import { deriveDIDFromPublicKey } from '../did/deriveDID';
import { DIDResolutionError, resolveDID, resolveKeyDID } from '../did/resolveDID';

const SEED = Uint8Array.from({ length: 32 }, (_, i) => i);
const VECTOR_DID = 'did:key:z6MkehRgf7yJbgaGfYsdoAsKdBPE3dj2CYhowQdcjqSJgvVd';

describe('resolveKeyDID', () => {
  it('builds the same W3C document the relay serves', () => {
    const did = deriveDIDFromPublicKey(nacl.sign.keyPair.fromSeed(SEED).publicKey);
    expect(did).toBe(VECTOR_DID);
    const multibase = did.slice('did:key:'.length);
    const vmId = `${did}#${multibase}`;
    expect(resolveKeyDID(did)).toEqual({
      '@context': [
        'https://www.w3.org/ns/did/v1',
        'https://w3id.org/security/suites/ed25519-2020/v1',
      ],
      id: did,
      verificationMethod: [
        { id: vmId, type: 'Ed25519VerificationKey2020', controller: did, publicKeyMultibase: multibase },
      ],
      authentication: [vmId],
      assertionMethod: [vmId],
      capabilityInvocation: [vmId],
      capabilityDelegation: [vmId],
    });
  });

  it('does not advertise a keyAgreement key (AegisLink never encrypts to a derived X25519 key)', () => {
    expect(resolveKeyDID(VECTOR_DID)).not.toHaveProperty('keyAgreement');
  });

  it.each([
    ['non-canonical alias', VECTOR_DID.replace('did:key:z', 'did:key:z1')],
    ['missing multibase prefix', VECTOR_DID.replace('did:key:z', 'did:key:')],
    ['garbage', 'did:key:zNotAKey'],
  ])('rejects %s with invalidDid', (_label, did) => {
    expect(() => resolveKeyDID(did)).toThrow(DIDResolutionError);
    try {
      resolveKeyDID(did);
    } catch (e) {
      expect((e as DIDResolutionError).code).toBe('invalidDid');
    }
  });
});

describe('resolveDID', () => {
  it('resolves did:key locally', async () => {
    await expect(resolveDID(VECTOR_DID)).resolves.toMatchObject({ id: VECTOR_DID });
  });

  it.each(['did:ethr:0xb9c5714089478a327f09197987f16f9e5d936e8a', 'did:web:example.com'])(
    'rejects %s with methodNotSupported',
    async (did) => {
      await expect(resolveDID(did)).rejects.toMatchObject({ code: 'methodNotSupported' });
    },
  );
});
