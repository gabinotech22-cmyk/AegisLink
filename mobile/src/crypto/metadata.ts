import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

/**
 * Metadata stripping & length normalization.
 *
 * Goals:
 *   - Remove any caller-supplied fields not in an allow-list.
 *   - Remove client-side timestamps and counters from outgoing payloads.
 *   - Pad every plaintext to a fixed bucket size so wire-length leaks
 *     no information about message content.
 *
 * Padding scheme: PKCS-style. Pick the smallest bucket >= input length
 * plus 2 framing bytes. Buckets are powers-of-two from 256B to 64KB,
 * with 256KB / 1MB / 4MB tiers for attachments. The pad bytes are random
 * (cosmetic — they live INSIDE the ciphertext anyway).
 */

const BUCKETS: readonly number[] = [
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
  262144, 1048576, 4194304,
];

const ALLOWED_INNER_FIELDS: ReadonlySet<string> = new Set([
  'v', 'from', 'senderPubB64', 'ratchet', 'x3dh', 'pad',
]);

export function pickBucket(length: number): number {
  for (const b of BUCKETS) {
    if (length + 2 <= b) return b;
  }
  throw new Error(`payload too large: ${length} bytes`);
}

/**
 * Strip non-allow-listed top-level fields from an object, then JSON-encode
 * and pad to a constant bucket size. Returns the padded UTF-8 bytes ready
 * for encryption.
 */
export function stripAndPad(payload: Record<string, unknown>): Uint8Array {
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(payload)) {
    if (ALLOWED_INNER_FIELDS.has(k)) clean[k] = payload[k];
  }
  // Reserve space for the pad field. Serialise WITHOUT pad first to measure.
  const probe = new TextEncoder().encode(JSON.stringify(clean));
  const bucket = pickBucket(probe.length + 32 /* pad key overhead */);

  // How many random bytes go into the pad field to hit the bucket.
  // We aim for: |JSON.stringify({...clean, pad: base64(padBytes)})| === bucket.
  // Iterative shrink: start with an estimate and adjust.
  let padLen = Math.max(0, bucket - probe.length - 16);
  for (let i = 0; i < 4; i++) {
    const padBytes = nacl.randomBytes(padLen);
    clean.pad = encodeBase64(padBytes);
    const out = new TextEncoder().encode(JSON.stringify(clean));
    if (out.length === bucket) return out;
    if (out.length < bucket) {
      padLen += bucket - out.length;
    } else {
      padLen -= out.length - bucket;
      if (padLen < 0) padLen = 0;
    }
  }
  // Final attempt — pad with spaces (still inside the ciphertext) to land exactly.
  const padBytes = nacl.randomBytes(Math.max(0, padLen));
  clean.pad = encodeBase64(padBytes);
  const json = JSON.stringify(clean);
  const out = new TextEncoder().encode(json);
  if (out.length === bucket) return out;
  if (out.length < bucket) {
    const filler = ' '.repeat(bucket - out.length);
    return new TextEncoder().encode(json + filler);
  }
  // If we overshot, drop the pad field entirely and re-bucket up.
  delete clean.pad;
  const minimal = new TextEncoder().encode(JSON.stringify(clean));
  if (minimal.length > bucket) {
    // Move to next bucket
    const nextBucket = pickBucket(minimal.length + 32);
    const filler = ' '.repeat(nextBucket - minimal.length);
    return new TextEncoder().encode(JSON.stringify(clean) + filler);
  }
  const filler = ' '.repeat(bucket - minimal.length);
  return new TextEncoder().encode(JSON.stringify(clean) + filler);
}

/**
 * Reverse: parse padded UTF-8 bytes back to an object, dropping `pad`
 * and any trailing whitespace filler.
 */
export function unpad(bytes: Uint8Array): Record<string, unknown> | null {
  try {
    const text = new TextDecoder().decode(bytes).replace(/\s+$/, '');
    const parsed = JSON.parse(text) as Record<string, unknown>;
    delete parsed.pad;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Decode a base64 pad blob back to bytes (used only in tests / forensics).
 */
export function decodePad(padB64: string): Uint8Array {
  return decodeBase64(padB64);
}
