import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { hkdf } from '@noble/hashes/hkdf';

export function hmacSHA256(key, data) {
  return hmac(sha256, key, data);
}

export function hkdfSHA256(ikm, salt, info, length = 32) {
  return hkdf(sha256, ikm, salt, info, length);
}

// camelCase aliases requested by the desktop deliverables spec.
export const hmacSha256 = hmacSHA256;
export const hkdfSha256 = hkdfSHA256;
