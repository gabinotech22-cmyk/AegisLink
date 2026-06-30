// ─── X3DH PreKey Secrets (durable primary store) ──────────────────────────────
//
// PRIMARY, durable store for the X3DH private prekeys (SPK secret, OPK secrets,
// and the current SPK keyId). The previous design kept these ONLY in SecureStore
// (Android Keystore). Bulk Keystore writes (~104 items on a refill) silently
// failed on some emulators/devices; the public SPK was published anyway, leaving
// the recipient unable to complete X3DH ("no-spk" abort) — the root cause of
// "messages don't arrive". By persisting secrets in the encrypted-at-rest SQLite
// DB, uploadPreKeys can READ BACK and verify the SPK secret before publishing,
// enforcing the invariant: never publish a prekey whose secret we cannot read.
//
// secret_b64 is encrypted at rest via encryptBody (same DB key as message bodies)
// so no private key material lands on disk unprotected. Functions are keyed by
// the active slot so multiple profiles stay isolated.
//
// PQXDH (post-quantum hybrid X3DH, Signal-style) adds an ML-KEM-768 "signed PQ
// prekey" to the bundle. Its SECRET key is 2400 bytes — far larger than an
// X25519 secret — and like every other private key it NEVER leaves the device.
// We reuse the existing encrypted-at-rest `prekey_secrets` table with two new
// `kind` discriminators so the storage path, slot isolation and encryptBody
// wrapping are identical to the classic SPK/OPK secrets:
//   kind='pqspk'      — the ML-KEM-768 secretKey (base64), keyed by its keyId.
//   kind='pqspkmeta'  — sentinel row (key_id=0) holding the current PQSPK keyId.
// The 2400-byte secret comfortably fits in a TEXT column; SQLite has no
// practical per-row size limit (unlike SecureStore's ~2KB iOS item cap), which
// is exactly why prekey secrets live here rather than in the keychain.

import { withDb, encryptBody, decryptSecretOrNull, getActiveDbSlot } from './core';

/** Persist (or replace) the SPK secret for a keyId. b64 is the raw 32-byte X25519 secret, base64. */
export async function saveSpkSecret(keyId: number, b64: string): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(b64);
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'spk', ?, ?)`,
      getActiveDbSlot(), keyId, enc,
    );
  });
}

/** Load the SPK secret (base64) for a specific keyId, or null if absent. */
export async function loadSpkSecret(keyId: number): Promise<string | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'spk' AND key_id = ?`,
      getActiveDbSlot(), keyId,
    );
    if (!row) return null;
    return decryptSecretOrNull(row.secret_b64);
  });
}

/** Load the SPK secret (base64) for the highest stored keyId, or null if none. */
export async function loadLatestSpkSecret(): Promise<{ keyId: number; b64: string } | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ key_id: number; secret_b64: string }>(
      `SELECT key_id, secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'spk' ORDER BY key_id DESC LIMIT 1`,
      getActiveDbSlot(),
    );
    if (!row) return null;
    const b64 = await decryptSecretOrNull(row.secret_b64);
    if (b64 === null) return null; // fail closed: undecryptable SPK secret = absent
    return { keyId: row.key_id, b64 };
  });
}

/** Delete a stored SPK secret by keyId (forward secrecy after rotation). */
export async function deleteSpkSecret(keyId: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `DELETE FROM prekey_secrets WHERE slot = ? AND kind = 'spk' AND key_id = ?`,
      getActiveDbSlot(), keyId,
    );
  });
}

/** Persist (or replace) a one-time prekey secret for a keyId. */
export async function saveOpkSecret(keyId: number, b64: string): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(b64);
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'opk', ?, ?)`,
      getActiveDbSlot(), keyId, enc,
    );
  });
}

/** Load a one-time prekey secret (base64) by keyId, or null if absent/consumed. */
export async function loadOpkSecret(keyId: number): Promise<string | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'opk' AND key_id = ?`,
      getActiveDbSlot(), keyId,
    );
    if (!row) return null;
    return decryptSecretOrNull(row.secret_b64);
  });
}

/**
 * Load EVERY stored one-time prekey secret for the active slot as a
 * Map<keyId, base64-secret>. Used to reconstruct the PUBLIC OPK bundle for
 * re-publishing without regenerating keys (the device owns a single,
 * durable prekey set — see crypto/signal/x3dh.ts:ensureDevicePreKeys).
 * Only OPKs whose secrets are still present (i.e. not yet consumed) are
 * returned, so the rebuilt public bundle naturally excludes consumed OPKs.
 */
export async function loadAllOpkSecrets(): Promise<Map<number, string>> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<{ key_id: number; secret_b64: string }>(
      `SELECT key_id, secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'opk' ORDER BY key_id ASC`,
      getActiveDbSlot(),
    );
    const out = new Map<number, string>();
    for (const row of rows) {
      // Fail closed: skip any OPK whose secret cannot be decrypted rather than
      // inserting a sentinel; a skipped OPK is naturally excluded from the
      // rebuilt public bundle (treated as already-consumed).
      const b64 = await decryptSecretOrNull(row.secret_b64);
      if (b64 !== null) out.set(row.key_id, b64);
    }
    return out;
  });
}

/** Delete a one-time prekey secret by keyId (single-use consumption). */
export async function deleteOpkSecret(keyId: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `DELETE FROM prekey_secrets WHERE slot = ? AND kind = 'opk' AND key_id = ?`,
      getActiveDbSlot(), keyId,
    );
  });
}

/**
 * Persist the current SPK keyId so it survives even if SecureStore loses it.
 * Stored as a kind='spkmeta', key_id=0 sentinel row whose secret_b64 holds the
 * keyId as a plaintext-equivalent (still encryptBody-wrapped) string.
 */
export async function setSpkKeyId(n: number): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(String(n));
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'spkmeta', 0, ?)`,
      getActiveDbSlot(), enc,
    );
  });
}

/** Read the current SPK keyId, or null if never set. */
export async function getSpkKeyId(): Promise<number | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'spkmeta' AND key_id = 0`,
      getActiveDbSlot(),
    );
    if (!row) return null;
    const v = parseInt((await decryptSecretOrNull(row.secret_b64)) ?? '', 10);
    return Number.isFinite(v) ? v : null;
  });
}

/**
 * Persist the wall-clock ms at which the CURRENT SPK was created. Powers the
 * age-based SPK rotation (B-3 / Signal ~weekly): the trigger compares this
 * against `SPK_ROTATION_INTERVAL_MS`. Stored as a `kind='spkcreated'`, key_id=0
 * sentinel row (same encryptBody-wrapped pattern as setSpkKeyId).
 *
 * Privacy (regla #10): this is the device's OWN SPK age, encrypted at rest — not
 * communication metadata. It is the minimum needed to rotate the SPK on a fixed
 * cadence and never leaves the device.
 */
export async function setSpkCreatedAt(ms: number): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(String(ms));
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'spkcreated', 0, ?)`,
      getActiveDbSlot(), enc,
    );
  });
}

/** Read the current SPK's creation ms, or null if never stamped (pre-B-3 install). */
export async function getSpkCreatedAt(): Promise<number | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'spkcreated' AND key_id = 0`,
      getActiveDbSlot(),
    );
    if (!row) return null;
    const v = parseInt((await decryptSecretOrNull(row.secret_b64)) ?? '', 10);
    return Number.isFinite(v) ? v : null;
  });
}

/** Delete every prekey secret for the active slot (panic wipe / slot delete). */
export async function clearPrekeySecrets(): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM prekey_secrets WHERE slot = ?', getActiveDbSlot());
  });
}

/** Persist (or replace) the ML-KEM-768 PQSPK secret (base64) for a keyId. */
export async function savePqSpkSecret(keyId: number, b64: string): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(b64);
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'pqspk', ?, ?)`,
      getActiveDbSlot(), keyId, enc,
    );
  });
}

/** Load the ML-KEM-768 PQSPK secret (base64) for a specific keyId, or null. */
export async function loadPqSpkSecret(keyId: number): Promise<string | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'pqspk' AND key_id = ?`,
      getActiveDbSlot(), keyId,
    );
    if (!row) return null;
    return decryptSecretOrNull(row.secret_b64);
  });
}

/** Delete a stored PQSPK secret by keyId (forward secrecy after rotation). */
export async function deletePqSpkSecret(keyId: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `DELETE FROM prekey_secrets WHERE slot = ? AND kind = 'pqspk' AND key_id = ?`,
      getActiveDbSlot(), keyId,
    );
  });
}

/** Persist the current PQSPK keyId (sentinel row, mirrors setSpkKeyId). */
export async function setPqSpkKeyId(n: number): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(String(n));
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'pqspkmeta', 0, ?)`,
      getActiveDbSlot(), enc,
    );
  });
}

/** Read the current PQSPK keyId, or null if never set. */
export async function getPqSpkKeyId(): Promise<number | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'pqspkmeta' AND key_id = 0`,
      getActiveDbSlot(),
    );
    if (!row) return null;
    const v = parseInt((await decryptSecretOrNull(row.secret_b64)) ?? '', 10);
    return Number.isFinite(v) ? v : null;
  });
}
