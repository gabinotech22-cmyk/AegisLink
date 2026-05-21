import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

/**
 * Metadata stripping & length normalization. See mobile counterpart for the
 * full spec — implementation is byte-identical and has no Node/RN dependencies.
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

export function stripAndPad(payload: Record<string, unknown>): Uint8Array {
  const clean: Record<string, unknown> = {};
  for (const k of Object.keys(payload)) {
    if (ALLOWED_INNER_FIELDS.has(k)) clean[k] = payload[k];
  }
  const probe = new TextEncoder().encode(JSON.stringify(clean));
  const bucket = pickBucket(probe.length + 32);

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
  const padBytes = nacl.randomBytes(Math.max(0, padLen));
  clean.pad = encodeBase64(padBytes);
  const json = JSON.stringify(clean);
  const out = new TextEncoder().encode(json);
  if (out.length === bucket) return out;
  if (out.length < bucket) {
    const filler = ' '.repeat(bucket - out.length);
    return new TextEncoder().encode(json + filler);
  }
  delete clean.pad;
  const minimal = new TextEncoder().encode(JSON.stringify(clean));
  if (minimal.length > bucket) {
    const nextBucket = pickBucket(minimal.length + 32);
    const filler = ' '.repeat(nextBucket - minimal.length);
    return new TextEncoder().encode(JSON.stringify(clean) + filler);
  }
  const filler = ' '.repeat(bucket - minimal.length);
  return new TextEncoder().encode(JSON.stringify(clean) + filler);
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
