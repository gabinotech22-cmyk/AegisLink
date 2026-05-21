/**
 * resolveDID.ts
 *
 * DID resolution for AegisLink.
 *
 * did:key DIDs are resolved entirely client-side — no network needed.
 * did:ethr DIDs will be resolved via the relay's /web3/did/resolve endpoint
 * (currently returns 501 — reserved for future on-chain anchoring).
 *
 * Privacy note: Resolution of a remote did:key by a third party reveals that
 * you are looking up that DID. Use the relay endpoint only when necessary.
 */

import { publicKeyFromDID } from './deriveDID';

export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  keyAgreement: string[];
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  publicKeyMultibase: string;
}

/**
 * Resolves a did:key DID to a minimal DID Document locally.
 * No network request is made.
 */
export function resolveKeyDID(did: string): DIDDocument {
  if (!did.startsWith('did:key:z')) {
    throw new Error(`resolveKeyDID: expected did:key:z..., got ${did}`);
  }
  // The multibase-encoded key identifier is the part after 'did:key:'
  const keyId = did.slice('did:key:'.length);
  // Validate the key is parseable.
  publicKeyFromDID(did);

  const verificationMethodId = `${did}#${keyId}`;
  const vm: VerificationMethod = {
    id: verificationMethodId,
    type: 'Ed25519VerificationKey2020',
    controller: did,
    publicKeyMultibase: keyId,
  };

  return {
    '@context': [
      'https://www.w3.org/ns/did/v1',
      'https://w3id.org/security/suites/ed25519-2020/v1',
    ],
    id: did,
    verificationMethod: [vm],
    authentication: [verificationMethodId],
    assertionMethod: [verificationMethodId],
    keyAgreement: [verificationMethodId],
  };
}

/**
 * Resolves a DID by method.
 * - did:key → resolved locally
 * - did:ethr → reserved, throws NOT_IMPLEMENTED
 */
export async function resolveDID(did: string): Promise<DIDDocument> {
  if (did.startsWith('did:key:')) {
    return resolveKeyDID(did);
  }
  if (did.startsWith('did:ethr:')) {
    throw new Error('did:ethr resolution is not yet implemented (on-chain anchoring planned)');
  }
  throw new Error(`Unsupported DID method: ${did}`);
}
