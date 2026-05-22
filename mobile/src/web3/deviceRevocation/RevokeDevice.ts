/**
 * RevokeDevice.ts
 *
 * Client-side device revocation for AegisLink Web3 layer.
 *
 * When a user loses a device or rotates keys, they can revoke the old
 * device's DID. The relay stores only a SHA-256 hash of the DID — never
 * the DID itself. Other clients can query the relay to check if a DID
 * hash is revoked without revealing which DID they are checking
 * (the hash is a one-way function).
 *
 * Privacy properties:
 *   - Server stores only: hash(DID), revokedAt, Ed25519 signature
 *   - Server never stores: the DID in plaintext, the aegisId, the device model
 *   - The signature proves the revocation was issued by the key owner
 *   - One-way hash prevents server from correlating hash → DID
 */

import nacl from 'tweetnacl';
import { sha256 } from '@noble/hashes/sha256';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { signWithProfileKey } from '../../crypto/identity';

export interface RevocationPayload {
  /** SHA-256 hash of the DID being revoked, hex-encoded. Never the DID itself. */
  didHash: string;
  /** Unix timestamp (ms) when the revocation was created. */
  revokedAt: number;
  /** Ed25519 signature over didHash + revokedAt, base64-encoded. */
  signature: string;
  /** Ed25519 signing public key (base64) to verify signature without revealing aegisId. */
  signingPublicKeyB64: string;
}

/**
 * Computes the SHA-256 hash of a DID string, returning it as a lowercase hex string.
 * This is a one-way function: the server cannot reverse it to recover the DID.
 */
export function hashDID(did: string): string {
  const bytes = new TextEncoder().encode(did);
  const digest = sha256(bytes);
  return Array.from(digest)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Builds the canonical byte payload that is signed for a revocation.
 * Format: SHA-256(didHash || ':' || revokedAt_decimal_string)
 *
 * Using a structured payload prevents signature reuse across contexts.
 */
function buildSigningPayload(didHash: string, revokedAt: number): Uint8Array {
  const raw = `aegislink:revoke:${didHash}:${revokedAt}`;
  return new TextEncoder().encode(raw);
}

/**
 * Creates a signed RevocationPayload for the given DID.
 *
 * @param did - The full DID string to revoke (e.g. did:key:z6Mk...).
 * @param profileId - The slot id of the profile that owns this DID
 *   ('self' for the primary profile, or e.g. 'work' / 'slot_1'). This selects
 *   which per-profile signing key in SecureStore is used, preserving isolation.
 * @param signingPublicKeyB64 - Base64 public key of the signing key (for verification).
 * @returns A RevocationPayload ready to POST to /web3/device/revoke.
 */
export async function buildRevocationPayload(
  did: string,
  profileId: string,
  signingPublicKeyB64: string
): Promise<RevocationPayload> {
  const didHash = hashDID(did);
  const revokedAt = Date.now();
  const signingPayload = buildSigningPayload(didHash, revokedAt);
  const signatureBytes = await signWithProfileKey(profileId, signingPayload);
  return {
    didHash,
    revokedAt,
    signature: encodeBase64(signatureBytes),
    signingPublicKeyB64,
  };
}

/**
 * Verifies a RevocationPayload locally (useful for testing and relay-side validation).
 *
 * @returns true if the signature is valid, false otherwise.
 */
export function verifyRevocationPayload(payload: RevocationPayload): boolean {
  try {
    const sigBytes = decodeBase64(payload.signature);
    const pubKeyBytes = decodeBase64(payload.signingPublicKeyB64);
    const message = buildSigningPayload(payload.didHash, payload.revokedAt);
    return nacl.sign.detached.verify(message, sigBytes, pubKeyBytes);
  } catch {
    return false;
  }
}
