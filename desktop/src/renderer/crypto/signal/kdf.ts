import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';

export function hmacSHA256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return hmac(sha256, key, data);
}

export function hkdfSHA256(
  ikm: Uint8Array,
  salt?: Uint8Array,
  info?: Uint8Array | string,
  length: number = 32
): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}
