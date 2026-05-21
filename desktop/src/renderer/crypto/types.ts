/**
 * AegisLink — Crypto API Contract (Fase 1)
 * ----------------------------------------------------------------------
 * Single source of truth for all cryptographic types crossing module
 * boundaries (Renderer <-> Backend <-> QA). Other modules import ONLY from
 * this file. Implementations live in sibling modules.
 *
 * Privacy invariants enforced by this contract:
 *   - Private keys NEVER appear in any type that crosses the network.
 *   - All wire payloads are opaque blobs (base64) + a constant-size pad.
 *   - The `from` field of a sealed envelope lives INSIDE the ciphertext.
 *   - No timestamps, sizes or counters travel in plaintext metadata.
 */

// ---------------------------------------------------------------------------
// 1. Identity
// ---------------------------------------------------------------------------

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface Identity {
  aegisId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyB64: string;
  secretKeyB64: string;
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  signingPublicKeyB64: string;
  signingSecretKeyB64: string;
  createdAt: number;
}

export interface PublicIdentity {
  aegisId: string;
  publicKeyB64: string;
  signingPublicKeyB64: string;
}

// ---------------------------------------------------------------------------
// 2. X3DH (PreKey bundle)
// ---------------------------------------------------------------------------

export interface SignedPreKeyPublic {
  keyId: number;
  publicKeyB64: string;
  signatureB64: string;
}

export interface OneTimePreKeyPublic {
  keyId: number;
  publicKeyB64: string;
}

export interface PreKeyBundle {
  identityKeyB64: string;
  signingPublicKeyB64: string;
  signedPreKey: SignedPreKeyPublic;
  oneTimePreKey: OneTimePreKeyPublic | null;
}

export interface PreKeySecrets {
  signedPreKey: { keyId: number; secretKey: Uint8Array };
  opkSecrets: Map<number, Uint8Array>;
}

export interface X3DHInitParams {
  aliceEKB64: string;
  spkId: number;
  opkId: number | null;
}

export interface X3DHResult {
  rootKey: Uint8Array;
  myEphemeralPublicKeyB64: string;
}

// ---------------------------------------------------------------------------
// 3. Double Ratchet
// ---------------------------------------------------------------------------

export interface RatchetHeader {
  ratchetKey: Uint8Array;
  n: number;
  pn: number;
}

export interface RatchetState {
  DHs: KeyPair;
  DHr: Uint8Array | null;
  RK: Uint8Array;
  CKs: Uint8Array | null;
  CKr: Uint8Array | null;
  Ns: number;
  Nr: number;
  PN: number;
  MKSKIPPED: Map<string, Uint8Array>;
  x3dhInit?: X3DHInitParams;
}

// ---------------------------------------------------------------------------
// 4. Sealed Sender envelope
// ---------------------------------------------------------------------------

export interface SealedEnvelope {
  toAegisId: string;
  ciphertextB64: string;
  nonceB64: string;
  v: number;
}

export interface SealedInner {
  v: number;
  from: string;
  senderPubB64: string;
  ratchet: {
    ratchetKeyB64: string;
    n: number;
    pn: number;
    ciphertextB64: string;
    nonceB64: string;
  };
  x3dh?: X3DHInitParams;
  pad?: string;
}

// ---------------------------------------------------------------------------
// 5. Fingerprint / safety number
// ---------------------------------------------------------------------------

export interface SafetyNumber {
  hex: string[];
  words: string[];
}

// ---------------------------------------------------------------------------
// 6. Storage contract — keys used in window.aegis.secureStorage.
// ---------------------------------------------------------------------------

export const SECURE_STORE_KEYS = {
  IDENTITY: 'aegis.identity.v1',
  PREKEY_SECRETS: 'aegis.prekeys.v1',
  PIN_HASH: 'aegis.pin.v1',
} as const;
