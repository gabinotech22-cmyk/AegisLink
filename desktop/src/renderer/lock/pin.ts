/**
 * Desktop app-lock PIN — Argon2id hashing (C-2 Fase 1).
 *
 * Ported from mobile/src/lock/pin.ts to bring desktop to parity (regla #5). The
 * previous desktop lock stored the PIN in CLEARTEXT under `aegis.pin.v1` and
 * accepted ANY 4-digit PIN when none was set (Lock.tsx `pin.length === 4`). This
 * module replaces that with a real Argon2id-hashed PIN:
 *   - per-install random salt (`aegis.pin.salt.v2`)
 *   - format-prefixed hash (`a3:`) stored under `aegis.pin.v1`
 *   - constant-time comparison (regla #8)
 *
 * SCOPE: like mobile, this PIN only gates the UI — the at-rest keys stay bound to
 * the OS keystore (Electron safeStorage / DPAPI). Making the PIN a true at-rest
 * second factor (wrapping the SQLCipher DB key) is C-2 Fase 2.
 *
 * The hashing primitives `hashPin`/`verifyPinHash` are PURE (salt injected, no
 * window.aegis) so they unit-test in the node-env vitest suite; the storage-bound
 * wrappers below touch the preload bridge and are exercised on-device only.
 */

import { argon2idAsync } from '@noble/hashes/argon2.js';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import type { AegisIPC } from '../crypto/ipc-types';

const PIN_HASH_KEY = 'aegis.pin.v1';
const PIN_SALT_KEY = 'aegis.pin.salt.v2';

// Desktop runs on V8 (JIT) — no Hermes penalty — so we can afford a real cost.
// 64 MiB / 3 passes is ~sub-second on V8 and runs via argon2idAsync so the
// renderer never blocks. (Mobile uses a far cheaper cost calibrated for Hermes.)
const ARGON_V3 = { t: 3, m: 65536, p: 1, dkLen: 32 } as const;
const enc = new TextEncoder();

function ss(): AegisIPC['secureStorage'] {
  return (window as unknown as { aegis: AegisIPC }).aegis.secureStorage;
}

/** Constant-time string comparison (XOR-accumulate, no early return). */
export function constantTimeEq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

// ── PURE primitives (unit-testable, salt injected) ───────────────────────────

/** Hash a PIN under a caller-supplied salt → `a3:` + base64(Argon2id). */
export async function hashPin(pin: string, salt: Uint8Array): Promise<string> {
  return 'a3:' + encodeBase64(await argon2idAsync(enc.encode(pin), salt, ARGON_V3));
}

/** Verify a PIN against a stored `a3:` hash in constant time. */
export async function verifyPinHash(
  pin: string,
  salt: Uint8Array,
  stored: string,
): Promise<boolean> {
  if (!stored.startsWith('a3:')) return false;
  return constantTimeEq(stored, await hashPin(pin, salt));
}

// ── Storage-bound wrappers (window.aegis.secureStorage) ──────────────────────

async function getPinSalt(): Promise<Uint8Array> {
  let b64 = await ss().get(PIN_SALT_KEY);
  if (!b64) {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    b64 = encodeBase64(salt);
    await ss().set(PIN_SALT_KEY, b64);
  }
  return decodeBase64(b64);
}

export async function setPIN(pin: string): Promise<void> {
  const salt = await getPinSalt();
  await ss().set(PIN_HASH_KEY, await hashPin(pin, salt));
}

export async function verifyPIN(pin: string): Promise<boolean> {
  const stored = await ss().get(PIN_HASH_KEY);
  if (!stored) return false;
  const salt = await getPinSalt();
  return verifyPinHash(pin, salt, stored);
}

export async function hasStoredPIN(): Promise<boolean> {
  const v = await ss().get(PIN_HASH_KEY);
  return v !== null && v.length > 0;
}

export async function clearPIN(): Promise<void> {
  await ss().delete(PIN_HASH_KEY);
  // Also drop the per-install salt (mirrors mobile/src/lock/pin.ts): leaving
  // it behind proves an app-lock was once configured, and getPinSalt() mints
  // a fresh one on the next setPIN(), so there is no correctness reason to
  // keep it.
  await ss().delete(PIN_SALT_KEY);
}
