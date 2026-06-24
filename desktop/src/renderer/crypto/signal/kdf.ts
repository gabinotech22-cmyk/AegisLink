import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

export function hmacSHA256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

export function hkdfSHA256(
  ikm: Uint8Array,
  salt?: Uint8Array,
  info?: Uint8Array | string,
  length: number = 32
): Uint8Array {
  // @noble/hashes v2 requires Uint8Array for `info` (v1 utf8-encoded strings
  // internally); reproduce that exactly so derived keys stay byte-identical.
  const infoBytes = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  return hkdf(sha256, ikm, salt, infoBytes, length);
}
