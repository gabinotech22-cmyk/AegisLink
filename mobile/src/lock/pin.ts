import * as Crypto from 'expo-crypto';
import { argon2id } from '@noble/hashes/argon2';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { ss } from '../utils/secureStore';

const PIN_HASH_KEY = 'aegis.pin.hash';
const PIN_SALT_KEY = 'aegis.pin.salt.v2'; // per-install random salt (base64)
const LEGACY_PIN_SALT = 'aegislink:pin:v1:';
export const DURESS_PIN_SALT = 'aegislink:panic:v1:';

// App-lock PIN hashing. The keyspace (4–6 digits) is tiny, so the per-guess
// cost must be high: Argon2id (~46 MiB / 3 passes) makes brute-forcing an
// extracted hash impractical, and a PER-INSTALL random salt kills the
// cross-user rainbow table that the old fixed global salt enabled. Identity and
// message keys do NOT derive from the PIN — this only protects the app lock.
const ARGON = { t: 3, m: 47104, p: 1, dkLen: 32 } as const;
const enc = new TextEncoder();

/** Constant-time string comparison to avoid leaking the hash via timing. */
function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

async function getPinSalt(): Promise<Uint8Array> {
  let b64 = await ss.get(PIN_SALT_KEY);
  if (!b64) {
    b64 = encodeBase64(nacl.randomBytes(16));
    await ss.set(PIN_SALT_KEY, b64);
  }
  return decodeBase64(b64);
}

function argonPin(pin: string, salt: Uint8Array): string {
  return 'a2:' + encodeBase64(argon2id(enc.encode(pin), salt, ARGON));
}

async function legacyHash(pin: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    LEGACY_PIN_SALT + pin
  );
}

/**
 * Hash a PIN under a caller-supplied domain salt — used for the duress/decoy
 * PIN. Kept on the legacy scheme for now: changing the algorithm would
 * invalidate an already-configured panic PIN (a silent safety regression).
 * TODO: migrate to Argon2id with a stored per-install salt + version tag.
 */
export async function hashPinWithSalt(pin: string, salt: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    salt + pin
  );
}

export async function setPIN(pin: string): Promise<void> {
  const salt = await getPinSalt();
  await ss.set(PIN_HASH_KEY, argonPin(pin, salt));
}

export async function verifyPIN(pin: string): Promise<boolean> {
  const stored = await ss.get(PIN_HASH_KEY);
  if (!stored) return false;
  if (stored.startsWith('a2:')) {
    const salt = await getPinSalt();
    return constantTimeEq(stored, argonPin(pin, salt));
  }
  // Legacy SHA-256 hash: verify, then transparently re-hash with Argon2id so
  // the upgrade is seamless on the next unlock.
  const ok = constantTimeEq(stored, await legacyHash(pin));
  if (ok) await setPIN(pin);
  return ok;
}

export async function hasStoredPIN(): Promise<boolean> {
  const val = await ss.get(PIN_HASH_KEY);
  return val !== null && val.length > 0;
}

export async function clearPIN(): Promise<void> {
  await ss.delete(PIN_HASH_KEY);
}
