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
export { resolveKeyDID, resolveDID, type DIDDocument, type VerificationMethod } from './did/resolveDID';
export {
  profileScopedId,
  getOrCreateProfileDID,
  getProfileDID,
  clearProfileDID,
  clearAllProfileDIDs,
  assertProfilesIsolated,
  type ProfileType,
} from './did/ProfileIsolation';

// Device revocation
export {
  hashDID,
  buildRevocationPayload,
  verifyRevocationPayload,
  type RevocationPayload,
} from './deviceRevocation/RevokeDevice';

// Lightning payments
export {
  verifyPreimage,
  requestInvoice,
  activateSubscription,
  type InvoiceRequest,
  type InvoiceResponse,
  type ActivationRequest,
  type ActivationResult,
} from './payments/LightningPayment';
