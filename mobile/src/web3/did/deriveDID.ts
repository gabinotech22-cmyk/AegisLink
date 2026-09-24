/**
 * deriveDID.ts
 *
 * Derives a did:key DID from an Ed25519 public key using the W3C DID Core +
 * did:key draft specification. No network call, no wallet required.
 *
 * Spec: https://w3c-ccg.github.io/did-method-key/
 * Multicodec prefix for Ed25519: 0xed01
 *
 * Privacy note: A DID is pseudonymous, not anonymous. The user must
 * explicitly opt in to creating/sharing their DID. AegisLink works
 * identically without any DID.
 */

import { base58 } from '@scure/base';

// did:key uses Bitcoin's base58 alphabet (base58btc in multibase).
const base58btc = base58;

// Multicodec varint prefix for Ed25519 public key (0xed, 0x01)
const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/**
 * Derives a did:key identifier from a 32-byte Ed25519 public key.
 *
 * Format: did:key:z<base58btc(multicodec_prefix || publicKey)>
 * The leading 'z' is the multibase prefix for base58btc.
 */
export function deriveDIDFromPublicKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  const encoded = base58btc.encode(prefixed);
  return `did:key:z${encoded}`;
}

/**
 * Extracts the raw 32-byte Ed25519 public key from a did:key DID.
 * Throws if the DID is not a CANONICAL did:key with an Ed25519 key: a
 * non-canonical spelling of the same key (e.g. an extra leading '1', i.e. a zero
 * byte) hashes differently and would read as active on the relay's resolver
 * even after the canonical DID is deactivated. Mirrors
 * server/src/crypto/didKey.ts `ed25519FromDidKey`.
 */
export function publicKeyFromDID(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) {
    throw new Error('DID must start with did:key:z');
  }
  const encoded = did.slice('did:key:z'.length);
  const prefixed = base58btc.decode(encoded);
  if (prefixed[0] !== 0xed || prefixed[1] !== 0x01) {
    throw new Error('DID key is not an Ed25519 key (expected multicodec prefix 0xed01)');
  }
  if (prefixed.length !== ED25519_MULTICODEC_PREFIX.length + 32) {
    throw new Error(`Ed25519 did:key must carry 32 key bytes, got ${prefixed.length - 2}`);
  }
  const publicKey = prefixed.slice(2);
  if (deriveDIDFromPublicKey(publicKey) !== did) {
    throw new Error('DID is not the canonical did:key encoding of its key');
  }
  return publicKey;
}
