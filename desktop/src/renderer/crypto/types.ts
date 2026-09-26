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

/**
 * The user's long-term identity. Its private keys are key-vault handles (F-1b,
 * docs/F1B-KEY-VAULT-DESIGN.md): the secrets never exist in the renderer.
 * Defined in ./identity.
 */
export type { Identity } from './identity';

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

/**
 * Local secret material backing a PreKeyBundle. Stays on device, and only in
 * its persisted form: key-vault blobs of the identity's profile (F-1b phase 2).
 */
export interface PreKeySecrets {
  signedPreKey: { keyId: number; secretStored: string };
  /** keyId -> persisted OPK secret (vault blob). */
  opkSecrets: Map<number, string>;
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
