import * as Crypto from 'expo-crypto';
import { argon2idAsync } from '@noble/hashes/argon2';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { KDF_ASYNC_TICK_MS } from '../crypto/nobleNextTickPatch';
import { ss } from '../utils/secureStore';

const PIN_HASH_KEY = 'aegis.pin.hash';
const PIN_SALT_KEY = 'aegis.pin.salt.v2'; // per-install random salt (base64)
const LEGACY_PIN_SALT = 'aegislink:pin:v1:';
export const DURESS_PIN_SALT = 'aegislink:panic:v1:';

// App-lock PIN hashing, calibrated for the runtime it actually runs on.
//
// Hermes has no JIT: pure-JS Argon2id at the v2 cost (46 MiB / 3 passes)
// blocked the JS thread for ~80 s per hash (measured on an emulator release
// build), freezing PIN setup, EVERY unlock, and the duress check. The PIN
// only gates the UI (identity and message keys do NOT derive from it), the
// hash lives in Keystore/Keychain device-bound storage, and the lock screen
// rate-limits to 5 attempts — so the KDF adds friction against an attacker
// who already extracted the hash from a compromised device, nothing more.
// v3 keeps Argon2id with a per-install random salt but at ~1 s of Hermes
// work, and ALL hashing goes through argon2idAsync, which (with the
// nobleNextTickPatch side-effect import) yields to the event loop so the UI
// never freezes regardless of cost.
const ARGON_V3 = { t: 1, m: 2048, p: 1, dkLen: 32, asyncTick: KDF_ASYNC_TICK_MS } as const;
// v2 cost kept ONLY to verify (and transparently upgrade) hashes created
// before the recalibration. Verifying one is slow (~80 s) but non-blocking,
// and happens at most once per install thanks to the re-hash on success.
const ARGON_V2 = { t: 3, m: 47104, p: 1, dkLen: 32, asyncTick: KDF_ASYNC_TICK_MS } as const;
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

async function argonPinV3(pin: string, salt: Uint8Array): Promise<string> {
  return 'a3:' + encodeBase64(await argon2idAsync(enc.encode(pin), salt, ARGON_V3));
}

async function argonPinV2(pin: string, salt: Uint8Array): Promise<string> {
  return 'a2:' + encodeBase64(await argon2idAsync(enc.encode(pin), salt, ARGON_V2));
}

async function legacyHash(pin: string): Promise<string> {
  return Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    LEGACY_PIN_SALT + pin
  );
}

/**
 * Hash a PIN under a caller-supplied domain salt — used to STORE the
 * duress/decoy PIN. Argon2id v3 ('a3:'), async so the UI stays responsive.
 * (Per-install salt for duress is a follow-up; the domain salt + Argon2id cost
 * + Keystore THIS_DEVICE_ONLY storage already make offline enumeration hard.)
 */
export async function hashPinWithSalt(pin: string, salt: string): Promise<string> {
  return argonPinV3(pin, enc.encode(salt));
}

/**
 * Verify a PIN against a stored duress hash in constant time, accepting the
 * current 'a3:' format plus the old 'a2:' Argon2id and legacy SHA-256 hashes
 * so an already-configured panic PIN keeps working. Callers own the stored
 * value, so old formats are NOT upgraded here — reconfiguring the panic PIN
 * re-stores it as 'a3:'.
 */
export async function verifyPinWithSalt(
  pin: string,
  salt: string,
  stored: string,
): Promise<boolean> {
  if (stored.startsWith('a3:')) {
    return constantTimeEq(stored, await argonPinV3(pin, enc.encode(salt)));
  }
  if (stored.startsWith('a2:')) {
    return constantTimeEq(stored, await argonPinV2(pin, enc.encode(salt)));
  }
  const legacy = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    salt + pin
  );
  return constantTimeEq(stored, legacy);
}

export async function setPIN(pin: string): Promise<void> {
  const salt = await getPinSalt();
  await ss.set(PIN_HASH_KEY, await argonPinV3(pin, salt));
}

export async function verifyPIN(pin: string): Promise<boolean> {
  const stored = await ss.get(PIN_HASH_KEY);
  if (!stored) return false;
  if (stored.startsWith('a3:')) {
    const salt = await getPinSalt();
    return constantTimeEq(stored, await argonPinV3(pin, salt));
  }
  if (stored.startsWith('a2:')) {
    // Old heavyweight format: verify once (slow but non-blocking), then
    // transparently re-hash as 'a3:' so the next unlock is fast.
    const salt = await getPinSalt();
    const ok = constantTimeEq(stored, await argonPinV2(pin, salt));
    if (ok) await setPIN(pin);
    return ok;
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
  // Also drop the per-install salt: leaving it behind is a harmless-looking
  // orphan today, but it still proves an app-lock PIN was once configured
  // (minimize metadata at-rest) and getPinSalt() will happily mint a fresh
  // one on the next setPIN(), so there is no correctness reason to keep it.
  await ss.delete(PIN_SALT_KEY);
}
