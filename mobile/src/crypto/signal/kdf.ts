import { hkdfSha256, hmacSha256 } from '../sodium';

const utf8 = new TextEncoder();

export function hmacSHA256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmacSha256(key, data);
}

export function hkdfSHA256(
  ikm: Uint8Array,
  salt?: Uint8Array,
  info?: Uint8Array | string,
  length: number = 32
): Uint8Array {
  const infoBytes = typeof info === 'string' ? utf8.encode(info) : info;
  return hkdfSha256(ikm, salt, infoBytes, length);
}
