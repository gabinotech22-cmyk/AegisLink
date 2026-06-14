import { decodeBase64 } from 'tweetnacl-util';

/**
 * Aegis ID derivation + binding.
 *
 * The Aegis ID is a human-friendly handle derived from the first 7 bytes of the
 * X25519 public key (Crockford Base32, formatted `XXX-XXXX-XXXX`). It is a
 * routing/display identifier — NOT a cryptographic trust anchor on its own (it
 * carries only ~55 bits). Strong authentication is the 128-bit safety
 * fingerprint compared out-of-band (see crypto/fingerprint.ts).
 *
 * This module is intentionally dependency-light (no expo-secure-store, no DB) so
 * the ID↔key binding check can run at every trust boundary — QR parsing, the
 * directory lookup, and the contacts store — without pulling native modules in.
 */

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, charsOut: number): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  const totalBits = BigInt(bytes.length * 8);
  const needed = BigInt(charsOut * 5);
  if (totalBits > needed) bits = bits >> (totalBits - needed);
  else if (totalBits < needed) bits = bits << (needed - totalBits);
  let out = '';
  for (let i = charsOut - 1; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 0x1fn);
    out += CROCKFORD[idx];
  }
  return out;
}

export function deriveAegisId(publicKey: Uint8Array): string {
  if (publicKey.length < 7) throw new Error('public key too short');
  const head = publicKey.slice(0, 7);
  const raw = encodeBase32(head, 11);
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 11)}`;
}

/** Canonical form for comparing user/relay/QR-supplied Aegis IDs. */
export function normalizeAegisId(id: string): string {
  return id.trim().toUpperCase();
}

/**
 * Cryptographically bind an Aegis ID to a public key.
 *
 * Returns true iff `aegisId` is the ID that `publicKeyB64` derives to. Because
 * the ID is a deterministic function of the key, any (id, key) pair that was NOT
 * generated together — a tampered QR pairing one person's ID with another's key,
 * or a malicious directory mapping an arbitrary key onto a requested ID — fails
 * this check.
 *
 * Note the residual bound: an attacker who grinds ~2^55 keys can find one that
 * derives to a *target* ID. This check therefore closes the "decoupled label and
 * key" failure mode and forces a 55-bit second-preimage; it does NOT replace the
 * 128-bit out-of-band fingerprint, which remains the strong authentication step.
 *
 * Never throws — malformed input returns false.
 */
export function keyMatchesAegisId(publicKeyB64: string, aegisId: string): boolean {
  try {
    return deriveAegisId(decodeBase64(publicKeyB64)) === normalizeAegisId(aegisId);
  } catch {
    return false;
  }
}
