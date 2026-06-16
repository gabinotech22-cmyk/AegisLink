/**
 * AegisLink — Crypto API Contract (Fase 1)
 * ----------------------------------------------------------------------
 * Single source of truth for all cryptographic types crossing module
 * boundaries (Mobile <-> Backend <-> QA). Other teams import ONLY from
 * this file. Implementations live in sibling modules.
 *
 * Privacy invariants enforced by this contract:
 *   - Private keys NEVER appear in any type that crosses the network.
 *   - All wire payloads are opaque blobs (base64) + a constant-size pad.
 *   - The `from` field of a sealed envelope lives INSIDE the ciphertext.
 *   - No timestamps, sizes or counters travel in plaintext metadata.
 *
 * Naming conventions:
 *   *B64   — base64-encoded Uint8Array (network/storage form)
 *   *Sec   — secret material (MUST stay in SecureStore / memory only)
 *   *Pub   — public material (safe to share)
 */

// ---------------------------------------------------------------------------
// 1. Identity
// ---------------------------------------------------------------------------

/** Raw key pair (32-byte Curve25519 or 32/64-byte Ed25519). */
export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

/** The user's long-term identity. Lives in expo-secure-store ONLY. */
export interface Identity {
  /** 11-char Crockford Base32 fingerprint formatted "XXX-XXXX-XXXX". */
  aegisId: string;
  /** X25519 public key (Curve25519) — used for ECDH. */
  publicKey: Uint8Array;
  /** X25519 secret key — NEVER leaves the device. */
  secretKey: Uint8Array;
  publicKeyB64: string;
  secretKeyB64: string;
  /** Ed25519 public — used to verify signed prekeys. */
  signingPublicKey: Uint8Array;
  /** Ed25519 secret — NEVER leaves the device. */
  signingSecretKey: Uint8Array;
  signingPublicKeyB64: string;
  signingSecretKeyB64: string;
  createdAt: number;
}

/** What the backend stores as the user's public profile. No secrets. */
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
  /** Ed25519 signature over publicKeyB64 by the identity signing key. */
  signatureB64: string;
}

export interface OneTimePreKeyPublic {
  keyId: number;
  publicKeyB64: string;
}

/**
 * PQXDH signed PQ prekey (ML-KEM-768). The public key bytes are signed by the
 * SAME Ed25519 identity signing key that signs the classic SPK; the receiver
 * MUST verify the signature before encapsulating.
 *
 * RELAY WIRE-FORMAT (for backend-lead): transport these three fields verbatim
 * as opaque blobs alongside the existing signedPreKey. Sizes:
 *   publicKeyB64 — base64 of 1184 bytes (ML-KEM-768 public key)
 *   signatureB64 — base64 of 64 bytes (Ed25519 detached signature)
 *   keyId        — integer
 * The relay never inspects or correlates them (same blind-relay contract).
 */
export interface PqSignedPreKeyPublic {
  keyId: number;
  publicKeyB64: string;
  signatureB64: string;
}

/** Public bundle uploaded to the relay. NO SECRETS. */
export interface PreKeyBundle {
  identityKeyB64: string;
  signingPublicKeyB64: string;
  signedPreKey: SignedPreKeyPublic;
  /** Optional — relay consumes OPKs one-shot per session. */
  oneTimePreKey: OneTimePreKeyPublic | null;
  /**
   * Optional PQXDH signed PQ prekey. PRESENT → sender derives a v2 (post-quantum
   * hybrid) root key; ABSENT → sender falls back to classic v1 X3DH (interop
   * with pre-PQXDH peers / relays).
   */
  pqSignedPreKey?: PqSignedPreKeyPublic | null;
}

/** Local secret material backing a PreKeyBundle. Stays on device. */
export interface PreKeySecrets {
  signedPreKey: { keyId: number; secretKey: Uint8Array };
  /** keyId -> secretKey. Deleted after one use. */
  opkSecrets: Map<number, Uint8Array>;
}

export interface X3DHInitParams {
  /** Sender's ephemeral X25519 public key, base64. */
  aliceEKB64: string;
  spkId: number;
  opkId: number | null;
  /**
   * PQXDH (v2) only: base64 of the 1088-byte ML-KEM-768 ciphertext the sender
   * encapsulated to the receiver's PQSPK. The receiver decapsulates this with
   * its PQSPK secret to recover the PQ shared secret.
   *
   * WIRE-FORMAT: this rides INSIDE the already-sealed initial message
   * (SealedInner.x3dh), never as a relay-visible field — so the relay needs no
   * change to carry it. Absent ⇒ v1 handshake.
   */
  pqCtB64?: string;
}

/** Handshake protocol version. 1 = classic X3DH, 2 = PQXDH hybrid. */
export type HandshakeVersion = 1 | 2;

export interface X3DHResult {
  rootKey: Uint8Array;
  myEphemeralPublicKeyB64: string;
  /** Negotiated handshake version actually used to derive `rootKey`. */
  version: HandshakeVersion;
  /** PQXDH (v2) only: base64 of the ML-KEM-768 ciphertext to send to the peer. */
  pqCiphertextB64?: string;
}

// ---------------------------------------------------------------------------
// 3. Double Ratchet
// ---------------------------------------------------------------------------

export interface RatchetHeader {
  ratchetKey: Uint8Array; // X25519 public
  n: number;              // message index in current sending chain
  pn: number;             // previous chain length
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
// 4. Sealed Sender envelope (the only object the relay sees)
// ---------------------------------------------------------------------------

/**
 * What the relay actually relays. There is NO `from` field — the sender
 * identity is encrypted inside `ciphertextB64`. Recipient is identified
 * only by `toAegisId`; the relay cannot link sender <-> recipient.
 */
export interface SealedEnvelope {
  /** Recipient's AegisID. The relay routes by this and forgets it. */
  toAegisId: string;
  /** Outer NaCl box ciphertext (sender hidden inside). */
  ciphertextB64: string;
  /** Outer nonce (24 bytes, random). */
  nonceB64: string;
  /** Protocol version. */
  v: number;
}

/** Plaintext payload AFTER opening the sealed envelope. */
export interface SealedInner {
  v: number;
  /** Sender's AegisID — only visible to the recipient. */
  from: string;
  /** Sender's static X25519 public key (so receiver can verify origin). */
  senderPubB64: string;
  ratchet: {
    ratchetKeyB64: string;
    n: number;
    pn: number;
    ciphertextB64: string;
    nonceB64: string;
  };
  x3dh?: X3DHInitParams;
  /** Random padding to constant size. Discarded after parse. */
  pad?: string;
}

// ---------------------------------------------------------------------------
// 5. Fingerprint / safety number
// ---------------------------------------------------------------------------

export interface SafetyNumber {
  /** 8 groups of 4 hex chars. */
  hex: string[];
  /** 8 words from the AegisLink wordlist. */
  words: string[];
}

// ---------------------------------------------------------------------------
// 6. Storage contract (what the Mobile team persists)
// ---------------------------------------------------------------------------

/** Keys used in expo-secure-store. NEVER write secrets outside these slots. */
export const SECURE_STORE_KEYS = {
  IDENTITY: 'aegis.identity.v1',
  PREKEY_SECRETS: 'aegis.prekeys.v1',
  PIN_HASH: 'aegis.pin.v1',
} as const;

/**
 * Per-profile (slot) SecureStore slot names — the SINGLE SOURCE OF TRUTH for
 * where each profile's secret material lives. Other modules (db/local.ts,
 * crypto/identity.ts) MUST derive their slot names from these helpers instead
 * of hardcoding strings, so multi-profile isolation can never silently break.
 *
 * The primary profile (slotId 'self') keeps the legacy un-suffixed names for
 * backward compatibility with identities created before multi-profile support.
 */
export const SLOT_KEY_PREFIX = {
  SECRET: 'aegis.secretKey.b64',
  SIGN_SECRET: 'aegis.signSecretKey.b64',
  DB_ENC: 'aegis.dbEncKey.b64',
} as const;

/** X25519 box secret key slot for a given profile/slot id. */
export function secretKeySlot(slotId: string): string {
  return slotId === 'self' ? SLOT_KEY_PREFIX.SECRET : `aegis.${slotId}.secretKey.b64`;
}

/** Ed25519 signing secret key slot for a given profile/slot id. */
export function signSecretKeySlot(slotId: string): string {
  return slotId === 'self' ? SLOT_KEY_PREFIX.SIGN_SECRET : `aegis.${slotId}.signSecretKey.b64`;
}

/** Per-slot SQLite encryption key slot for a given profile/slot id. */
export function dbEncKeySlot(slotId: string): string {
  return slotId === 'self' ? SLOT_KEY_PREFIX.DB_ENC : `aegis.${slotId}.dbEncKey.b64`;
}

// ---------------------------------------------------------------------------
// 7. Public API surface — re-exports for consumers
// ---------------------------------------------------------------------------
//
// Mobile imports:
//   import type { Identity, SealedEnvelope, RatchetState } from '../crypto/types';
//   import { createIdentity } from '../crypto/identity';
//   import { encryptMessage, openEnvelope } from '../crypto/messaging';
//   import { performX3DH, performX3DHReceiver, generatePreKeys } from '../crypto/signal/x3dh';
//   import { initRatchet, ratchetEncrypt, ratchetDecrypt } from '../crypto/signal/ratchet';
//   import { stripAndPad, unpad } from '../crypto/metadata';
//   import { fingerprintHex, fingerprintWords } from '../crypto/fingerprint';
//   import { encodeIdentityQR, parseIdentityQR } from '../crypto/qr';
//
// Backend consumes ONLY:
//   - PublicIdentity (registration)
//   - PreKeyBundle (upload / fetch)
//   - SealedEnvelope (relay)
//
// Backend NEVER sees: Identity, PreKeySecrets, RatchetState, SealedInner.
