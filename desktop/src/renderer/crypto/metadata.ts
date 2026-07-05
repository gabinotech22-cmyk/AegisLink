import { decodeBase64 } from 'tweetnacl-util';

/**
 * Metadata stripping & length normalization. See mobile counterpart for the
 * full spec — implementation is byte-identical and has no Node/RN dependencies.
 */

const BUCKETS: readonly number[] = [
  256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
  262144, 1048576, 4194304,
];

const ALLOWED_INNER_FIELDS: ReadonlySet<string> = new Set([
  'v', 'from', 'senderPubB64', 'ratchet', 'x3dh', 'pad', 'selfCopy', 'deviceSync'
]);

export function pickBucket(length: number): number {
  for (const b of BUCKETS) {
    if (length + 2 <= b) return b;
  }
  throw new Error(`payload too large: ${length} bytes`);
}

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

export function decodePad(padB64: string): Uint8Array {
  return decodeBase64(padB64);
}
