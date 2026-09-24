/**
 * resolveDID.ts
 *
 * Local DID resolution for AegisLink — no network request.
 *
 * AegisLink issues exactly one DID method: did:key over the identity's Ed25519
 * signing key (deriveDID.ts). A did:key is self-describing, so the document is
 * built from the DID alone. The one thing it cannot say locally is whether the
 * owner has since deleted the identity; that deactivation status lives on the
 * relay (GET /web3/did/resolve/:did, W3C DID Resolution) and querying it tells
 * the relay which DID you are looking at — so it is not done implicitly here.
 *
 * did:ethr (on-chain) is deliberately unsupported: anchoring would break
 * "anonymous by default, no wallet" (docs/ROADMAP.md). Any method other than
 * did:key fails with the W3C `methodNotSupported` error, like the relay.
 *
 * Document shape mirrors server/src/crypto/didKey.ts `didKeyDocument` exactly.
 */

import { publicKeyFromDID } from './deriveDID';

export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  capabilityInvocation: string[];
  capabilityDelegation: string[];
}

export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: string;
  publicKeyMultibase: string;
}

/** W3C DID Resolution error codes this resolver can raise. */
export type DIDResolutionErrorCode = 'invalidDid' | 'methodNotSupported';

export class DIDResolutionError extends Error {
  readonly code: DIDResolutionErrorCode;

  constructor(code: DIDResolutionErrorCode, message: string) {
    super(message);
    this.name = 'DIDResolutionError';
    this.code = code;
  }
}

/**
 * Resolves a canonical Ed25519 did:key to its DID Document.
 *
 * No `keyAgreement`: the did:key spec's optional X25519 key would be DERIVED
 * from the signing key, but AegisLink encrypts with a separate X25519 identity
 * key, so advertising a derived one would publish an encryption key nobody uses.
 *
 * @throws DIDResolutionError('invalidDid') for anything that is not a
 *   canonical Ed25519 did:key.
 */
export function resolveKeyDID(did: string): DIDDocument {
  try {
    publicKeyFromDID(did);
  } catch (e) {
    throw new DIDResolutionError('invalidDid', (e as Error).message);
  }
  const multibase = did.slice('did:key:'.length);
  const vmId = `${did}#${multibase}`;
  return {
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
  };
}

/**
 * Resolves a DID by method: did:key locally, every other method rejected.
 *
 * @throws DIDResolutionError('methodNotSupported') for non-did:key methods,
 *   DIDResolutionError('invalidDid') for a malformed did:key.
 */
export async function resolveDID(did: string): Promise<DIDDocument> {
  if (did.startsWith('did:key:')) {
    return resolveKeyDID(did);
  }
  throw new DIDResolutionError('methodNotSupported', `Unsupported DID method: ${did.split(':', 2).join(':')}`);
}
