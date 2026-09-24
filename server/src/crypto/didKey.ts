/**
 * didKey.ts — did:key (Ed25519) derivation, parsing and DID Document building.
 *
 * Mirrors mobile/src/web3/did/deriveDID.ts + resolveDID.ts byte-for-byte so the
 * relay and the clients always agree on a DID string and on its hash (the
 * cross-platform vector lives in __tests__/didKey.test.ts).
 *
 *   did = "did:key:z" + base58btc(0xed 0x01 || ed25519PublicKey)
 *   didHash = hex(SHA-256(utf8(did)))
 *
 * An AegisLink DID is the did:key of the identity's Ed25519 SIGNING key. did:key
 * is self-certifying: the only party able to act for it is the holder of that
 * secret key, which is what binds a revocation to its owner (see
 * routes/identity.ts DELETE and routes/web3.ts resolve).
 *
 * Spec: https://w3c-ccg.github.io/did-method-key/
 */

import { createHash } from 'node:crypto';

const ED25519_MULTICODEC = [0xed, 0x01] as const;
const ED25519_PUBLIC_KEY_LENGTH = 32;

// ── base58btc (Bitcoin alphabet) ──────────────────────────────────────────────
// Encoding only — no secret material passes through here, so a plain BigInt
// implementation is fine (inputs are 34 bytes).

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_INDEX: Record<string, number> = Object.fromEntries(
  [...ALPHABET].map((c, i) => [c, i])
);

export function base58btcEncode(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  return '1'.repeat(zeros) + out;
}

/** Decode base58btc; returns null on any character outside the alphabet. */
export function base58btcDecode(s: string): Uint8Array | null {
  let zeros = 0;
  while (zeros < s.length && s[zeros] === '1') zeros++;
  let n = 0n;
  for (const c of s) {
    const v = ALPHABET_INDEX[c];
    if (v === undefined) return null;
    n = n * 58n + BigInt(v);
  }
  const body: number[] = [];
  while (n > 0n) {
    body.unshift(Number(n & 0xffn));
    n >>= 8n;
  }
  return Uint8Array.from([...new Array<number>(zeros).fill(0), ...body]);
}

// ── did:key ───────────────────────────────────────────────────────────────────

/** did:key identifier for a 32-byte Ed25519 public key. Throws on a wrong size. */
export function didKeyFromEd25519(publicKey: Uint8Array): string {
  if (publicKey.length !== ED25519_PUBLIC_KEY_LENGTH) {
    throw new Error(`Ed25519 public key must be 32 bytes, got ${publicKey.length}`);
  }
  return `did:key:z${base58btcEncode(Uint8Array.from([...ED25519_MULTICODEC, ...publicKey]))}`;
}

/**
 * Parse an Ed25519 did:key back to its public key. Returns null for anything
 * that is not a CANONICAL Ed25519 did:key: a non-canonical spelling of the same
 * key (e.g. extra leading '1's) would hash differently and so dodge a revocation
 * lookup, so it is rejected rather than normalised.
 */
export function ed25519FromDidKey(did: string): Uint8Array | null {
  if (!did.startsWith('did:key:z')) return null;
  const decoded = base58btcDecode(did.slice('did:key:z'.length));
  if (!decoded || decoded.length !== ED25519_MULTICODEC.length + ED25519_PUBLIC_KEY_LENGTH) {
    return null;
  }
  if (decoded[0] !== ED25519_MULTICODEC[0] || decoded[1] !== ED25519_MULTICODEC[1]) return null;
  const publicKey = decoded.slice(ED25519_MULTICODEC.length);
  if (didKeyFromEd25519(publicKey) !== did) return null;
  return publicKey;
}

/** hex(SHA-256(utf8(did))) — the only form in which the relay persists a DID. */
export function didHashHex(did: string): string {
  return createHash('sha256').update(did, 'utf8').digest('hex');
}

// ── DID Document ──────────────────────────────────────────────────────────────

export interface VerificationMethod {
  id: string;
  type: 'Ed25519VerificationKey2020';
  controller: string;
  publicKeyMultibase: string;
}

export interface DIDDocument {
  '@context': string[];
  id: string;
  verificationMethod: VerificationMethod[];
  authentication: string[];
  assertionMethod: string[];
  capabilityInvocation: string[];
  capabilityDelegation: string[];
}

/**
 * DID Document for a canonical Ed25519 did:key (caller validates first).
 *
 * No `keyAgreement`: the spec's optional X25519 key would be DERIVED from the
 * signing key, but an AegisLink identity encrypts with a separate X25519 key, so
 * advertising a derived one would publish an encryption key nobody uses.
 */
export function didKeyDocument(did: string): DIDDocument {
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
