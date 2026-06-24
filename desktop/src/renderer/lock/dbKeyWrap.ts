/**
 * Desktop app-lock — derive a key-encryption-key (KEK) from the PIN (C-2 Fase 2).
 *
 * Fase 1 made the PIN a real Argon2id-hashed *UI gate* (see lock/pin.ts). Fase 2
 * makes the PIN a real *at-rest second factor*: the SQLCipher DB key is wrapped
 * under a KEK derived here, *inside* the OS keystore (DPAPI) layer. So opening
 * the DB now requires BOTH the OS session (DPAPI) AND the PIN — DPAPI alone no
 * longer suffices (audit finding C-2).
 *
 * The KEK is derived in the RENDERER (it has @noble/hashes; argon2idAsync runs
 * off the UI thread) and only the 32-byte KEK crosses IPC to main — the raw DB
 * key never leaves the main process. Wrapping/unwrapping the DB key with this
 * KEK happens in main (database.ts).
 *
 * IMPORTANT: the KEK uses a DEDICATED salt (`aegis.dbkek.salt.v1`), distinct from
 * the PIN-auth salt (`aegis.pin.salt.v2`). Same PIN + same params + same salt
 * would make the stored auth hash equal to the KEK — anyone reading the keystore
 * hash would hold the KEK. Separate salts keep the two outputs independent.
 *
 * `deriveKEKBytes` is PURE (salt injected, no window.aegis) so it unit-tests in
 * the node-env vitest suite; `getDbKEK` touches the preload bridge (on-device).
 */

import { argon2idAsync } from '@noble/hashes/argon2.js';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import type { AegisIPC } from '../crypto/ipc-types';

const DBKEK_SALT_KEY = 'aegis.dbkek.salt.v1';

// Same cost as the PIN hash (lock/pin.ts ARGON_V3): 64 MiB / 3 passes, sub-second
// on V8, run async so the renderer never blocks. One Argon2 pass per cold unlock.
const ARGON_V3 = { t: 3, m: 65536, p: 1, dkLen: 32 } as const;
const enc = new TextEncoder();

function ss(): AegisIPC['secureStorage'] {
  return (window as unknown as { aegis: AegisIPC }).aegis.secureStorage;
}

// ── PURE primitive (unit-testable, salt injected) ────────────────────────────

/** Derive a 32-byte KEK from the PIN under a caller-supplied salt. */
export async function deriveKEKBytes(pin: string, salt: Uint8Array): Promise<Uint8Array> {
  return argon2idAsync(enc.encode(pin), salt, ARGON_V3);
}

// ── Storage-bound wrapper (window.aegis.secureStorage) ───────────────────────

async function getKekSalt(): Promise<Uint8Array> {
  let b64 = await ss().get(DBKEK_SALT_KEY);
  if (!b64) {
    const salt = new Uint8Array(16);
    crypto.getRandomValues(salt);
    b64 = encodeBase64(salt);
    await ss().set(DBKEK_SALT_KEY, b64);
  }
  return decodeBase64(b64);
}

/**
 * Derive the DB-key KEK for `pin` and return it base64-encoded, ready to pass to
 * the main process (`db:unlock` / `db:enable-pin-wrap`). Creates the per-install
 * KEK salt on first use.
 */
export async function getDbKEK(pin: string): Promise<string> {
  const salt = await getKekSalt();
  const kek = await deriveKEKBytes(pin, salt);
  try {
    return encodeBase64(kek);
  } finally {
    kek.fill(0);
  }
}
