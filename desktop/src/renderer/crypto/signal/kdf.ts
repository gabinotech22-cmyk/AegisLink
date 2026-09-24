import { hkdfSha256, hmacSha256 } from '../sodium';

export function hmacSHA256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmacSha256(key, data);
}

export function hkdfSHA256(
  ikm: Uint8Array,
  salt?: Uint8Array,
  info?: Uint8Array | string,
  length: number = 32
): Uint8Array {
  // @noble/hashes v1 (the original mobile implementation) utf8-encoded string
  // `info` internally; reproduce that exactly so derived keys stay byte-identical.
  const infoBytes = typeof info === 'string' ? new TextEncoder().encode(info) : info;
  return hkdfSha256(ikm, salt, infoBytes, length);
}
