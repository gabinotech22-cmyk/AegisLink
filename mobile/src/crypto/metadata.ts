import { decodeBase64 } from 'tweetnacl-util';

/**
 * Metadata stripping & length normalization.
 *
 * Goals:
 *   - Remove any caller-supplied fields not in an allow-list.
 *   - Remove client-side timestamps and counters from outgoing payloads.
 *   - Pad every plaintext to a fixed bucket size so wire-length leaks
 *     no information about message content.
 *
 * Padding scheme: pick the smallest bucket >= input length plus 2 framing
 * bytes, then append single-byte ASCII spaces until the output is EXACTLY the
 * bucket size. Buckets are powers-of-two from 256B to 64KB, with 256KB / 1MB /
 * 4MB tiers for attachments. The filler lives INSIDE the ciphertext, so it
 * leaks nothing on the wire — only the constant bucket length is observable.
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
 *
 * Deterministic and UTF-8-safe: the bucket is chosen from the JSON's UTF-8
 * *byte* length (not its character count) and the filler is single-byte ASCII
 * spaces, so the output is ALWAYS exactly `bucket` bytes regardless of any
 * multi-byte characters in the payload. No random pad field, no iterative
 * convergence — one pass, one allocation.
 */
export function stripAndPad(payload: Record<string, unknown>): Uint8Array {
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(payload)) {
    if (ALLOWED_INNER_FIELDS.has(k)) clean[k] = payload[k];
  }
  const json = JSON.stringify(clean);
  const baseLen = new TextEncoder().encode(json).length;
  const bucket = pickBucket(baseLen);
  // pickBucket guarantees bucket >= baseLen + 2, so fillerLen is always >= 2.
  // Trailing ASCII spaces (1 byte each) land the output on the bucket exactly;
  // `unpad` strips them before parsing.
  const filler = ' '.repeat(bucket - baseLen);
  return new TextEncoder().encode(json + filler);
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
