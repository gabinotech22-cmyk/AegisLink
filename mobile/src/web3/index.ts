/**
 * web3/index.ts — Barrel export for AegisLink Web3 layer.
 *
 * All Web3 features are OPTIONAL add-ons. Importing this module does not
 * activate any blockchain connectivity. Features activate only when the
 * user explicitly calls the relevant functions.
 */

// DID derivation & resolution
export { deriveDIDFromPublicKey, publicKeyFromDID } from './did/deriveDID';
export { getOrCreateDID, getDID, clearDID, type DIDRecord } from './did/DIDManager';
export {
  resolveKeyDID,
  resolveDID,
  DIDResolutionError,
  type DIDResolutionErrorCode,
  type DIDDocument,
  type VerificationMethod,
} from './did/resolveDID';

// DID revocation has no client API: the relay deactivates the identity's
// did:key itself when the owner deletes the account (signed DELETE /identity),
// and GET /web3/did/resolve reports it. See docs/PROTOCOL.md §3.

// Lightning payments (section 14) left this repo with AegisLink Work (ROADMAP Hito 1).
