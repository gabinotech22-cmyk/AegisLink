// Barrel export — single entry point for desktop crypto consumers.
export {
  generateIdentity,
  loadIdentity,
  clearIdentity,
  getPublicKeyBundle,
  deriveAegisId,
  generateKeyPair,
  generateSigningKeyPair,
  createEphemeralIdentity,
} from './identity.js';

export {
  encryptMessage,
  openEnvelope,
  tryDecryptMessage,
  stripAndPad,
} from './messaging.js';

export { unpad, pickBucket } from './metadata.js';

export { performX3DH, performX3DHReceiver, generatePreKeys } from './signal/x3dh.js';
export { initRatchet, ratchetEncrypt, ratchetDecrypt } from './signal/ratchet.js';
export { hkdfSHA256, hmacSHA256 } from './signal/kdf.js';

export { generateLinkingQR, decryptLinkingResponse, encryptLinkingResponse } from './linking.js';
