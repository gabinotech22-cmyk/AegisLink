import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { ss } from '../utils/secureStore';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { secretKeySlot, signSecretKeySlot, dbEncKeySlot } from '../crypto/types';
import { initSchema } from './schema';

// ─── Identity (Keychain / Keystore) ──────────────────────────────────────────
//
// Secret key NEVER touches SQLite — it lives in expo-secure-store, which is
// Keychain (iOS) and EncryptedSharedPreferences/Keystore-backed (Android).
// Public material (aegisId, publicKey, createdAt) lives in SQLite so it can be
// queried alongside contacts/messages.

let activeSlot = 'self';

export function getActiveDbSlot(): string {
  return activeSlot;
}

export function getSecretKeySlot(slot = activeSlot): string {
  return secretKeySlot(slot);
}

export function getSignSecretKeySlot(slot = activeSlot): string {
  return signSecretKeySlot(slot);
}

export function getDbEncKeySlot(slot = activeSlot): string {
  return dbEncKeySlot(slot);
}

export function setActiveDbSlot(slot: string): void {
  if (activeSlot === slot) return; // no-op: same slot, preserve in-progress warm-up
  activeSlot = slot;
  dbPromise = null;
  cachedDbKey = null;
  dbFatalError = null;
  // Reset the ready promise for the new slot so that callers waiting on
  // dbReadyPromise get a fresh signal after the new slot's DB is opened.
  dbReadyPromise = new Promise<void>((resolve) => {
    _dbReadyResolve = resolve;
  });
  // Immediately kick off the warm-up for the new slot's DB file.
  warmUpDb();
}

export async function closeActiveDatabase(): Promise<void> {
  if (!dbPromise) return;
  _closing = true;
  try {
    const d = await dbPromise;
    dbPromise = null;
    cachedDbKey = null;
    // closeAsync flushes WAL to the main file — needed before backup/copy.
    // Wrap in try/catch: if already closed (e.g. double-close), this is a no-op.
    try { await d.closeAsync(); } catch { /* already closed — safe to ignore */ }
  } finally {
    _closing = false;
  }
}

/**
 * Reset the DB reference without closing the native connection.
 * Use this for profile switches where you want the next db() call to open
 * the new slot's file without risking "Access to closed resource" on
 * in-flight operations that hold a reference to the old connection.
 */
export function resetDbConnection(): void {
  dbPromise = null;
  cachedDbKey = null;
  dbFatalError = null;
}

export async function deleteIdentitySlot(slot: string): Promise<void> {
  // 1. Delete credentials and E2EE keys
  await SecureStore.deleteItemAsync(getSecretKeySlot(slot)).catch(() => {});
  await SecureStore.deleteItemAsync(getSignSecretKeySlot(slot)).catch(() => {});
  await SecureStore.deleteItemAsync(getDbEncKeySlot(slot)).catch(() => {});

  // 2. Delete preferences for this slot
  const prefKeys = [
    'displayName',
    'avatarColor',
    'avatarImage',
    'profileStatus',
  ];
  for (const pk of prefKeys) {
    await SecureStore.deleteItemAsync(`aegis.${slot}.${pk}`).catch(() => {});
  }

  // 3. Delete X3DH prekey secrets — these live outside the SQLite file
  const prefix = slot === 'self' ? '' : `${slot}.`;
  const opkIdsRaw = await SecureStore.getItemAsync(`aegis.${prefix}opkIds.json`).catch(() => null);
  if (opkIdsRaw) {
    try {
      const ids: number[] = JSON.parse(opkIdsRaw) as number[];
      for (const id of ids) {
        await SecureStore.deleteItemAsync(`aegis.${prefix}opkSecret.${id}`).catch(() => {});
        await SecureStore.deleteItemAsync(`aegis.${prefix}spkSecret.${id}`).catch(() => {});
      }
    } catch { /* non-fatal */ }
  }
  await SecureStore.deleteItemAsync(`aegis.${prefix}opkIds.json`).catch(() => {});
  await SecureStore.deleteItemAsync(`aegis.${prefix}spkSecret.b64`).catch(() => {});
  await SecureStore.deleteItemAsync(`aegis.${prefix}spk.keyId`).catch(() => {});

  // 4. Delete the cold-start published flag (keyed by slot ID)
  await SecureStore.deleteItemAsync(`aegis.published.${slot}`).catch(() => {});

  // 5. Delete SQLite files
  const dbName = slot === 'self' ? 'aegislink.db' : `aegislink_${slot}.db`;
  const dbUri = `${FileSystem.documentDirectory}SQLite/${dbName}`;
  const walUri = `${FileSystem.documentDirectory}SQLite/${dbName}-wal`;
  const shmUri = `${FileSystem.documentDirectory}SQLite/${dbName}-shm`;

  await FileSystem.deleteAsync(dbUri, { idempotent: true }).catch(() => {});
  await FileSystem.deleteAsync(walUri, { idempotent: true }).catch(() => {});
  await FileSystem.deleteAsync(shmUri, { idempotent: true }).catch(() => {});
}

export interface StoredIdentity {
  aegisId: string;
  publicKeyB64: string;
  secretKeyB64: string;
  signingPublicKeyB64: string;
  signingSecretKeyB64: string;
  createdAt: number;
}

let dbPromise: Promise<SQLite.SQLiteDatabase> | null = null;
let dbFatalError: Error | null = null;
// Tracks whether a close is in progress to prevent concurrent operations from
// reopening the DB mid-close then immediately seeing "Access to closed resource".
let _closing = false;

/**
 * Thrown by openAndInit when all MAX_ATTEMPTS have been exhausted.
 *
 * Using a distinct class lets withDb distinguish between:
 *   (a) a transient NPE from a single runAsync / purge call inside db().then
 *       → withDb retries once with a fresh handle, and
 *   (b) an NPE that survived all MAX_ATTEMPTS retries in openAndInit
 *       → the database cannot be opened; withDb must NOT add another attempt.
 *
 * The message is forwarded verbatim from the underlying NPE so that callers
 * can still assert on the "NullPointerException" substring.
 */
class DbInitExhaustedError extends Error {
  constructor(cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(msg);
    this.name = 'DbInitExhaustedError';
  }
}


/**
 * Opens the database file and runs the full schema initialisation.
 *
 * Retries up to MAX_ATTEMPTS times when the failure is a NullPointerException
 * originating from the expo-sqlite JSI bridge on Android.  This NPE pattern is
 * observed on BlueStacks and some x86 emulators where the JSI bridge initialises
 * the native DB pointer asynchronously during cold-start; the pointer can stay
 * null for several seconds.  Each retry closes the half-initialised handle (to
 * avoid native connection leaks) and introduces a capped growing backoff that
 * gives the JSI bridge time to stabilise before the next attempt.
 *
 * MAX_ATTEMPTS = 16 (~10 s total on a very slow x86 emulator; first attempt on
 * arm64 real hardware almost always succeeds so the extra attempts cost nothing).
 *
 * Non-NPE errors (disk full, file corruption, …) are propagated immediately on
 * the first occurrence — they are not transient and retrying would not help.
 */
// ─── SQLCipher at-rest encryption (Ola 10) ────────────────────────────────────
//
// The whole DB file is encrypted with SQLCipher (config plugin useSQLCipher:true
// in app.json). The 256-bit key is the SAME random per-slot key already minted
// and stored in expo-secure-store by getDbKey() — reused here as a raw SQLCipher
// key. NaCl field encryption (encryptBody) stays as defence-in-depth.

/** Lowercase hex of the 32-byte per-slot DB key (for `PRAGMA key = "x'…'"`). */
async function getDbKeyHex(): Promise<string> {
  const key = await getDbKey();
  let hex = '';
  for (let i = 0; i < key.length; i++) hex += key[i].toString(16).padStart(2, '0');
  return hex;
}

/**
 * One-time, idempotent re-encryption of a pre-existing PLAINTEXT database into
 * SQLCipher, preserving all rows (standard `sqlcipher_export` migration).
 *
 * No-op when: the file does not exist (a fresh DB is created already-encrypted
 * on first open), the file is already encrypted with our key, or the host
 * FileSystem lacks getInfoAsync/moveAsync (e.g. unit-test mocks) — so existing
 * open-path tests keep their exact openDatabaseAsync call counts.
 */
async function migratePlaintextIfNeeded(dbName: string, keyHex: string): Promise<void> {
  // Degrade to a no-op when the filesystem API isn't fully available (test mocks).
  const fs = FileSystem as unknown as {
    getInfoAsync?: (uri: string) => Promise<{ exists: boolean; size?: number }>;
    moveAsync?: (opts: { from: string; to: string }) => Promise<void>;
  };
  if (typeof fs.getInfoAsync !== 'function' || typeof fs.moveAsync !== 'function') return;

  const dir = `${FileSystem.documentDirectory}SQLite/`;
  const dbUri = `${dir}${dbName}`;
  // Migration is a best-effort upgrade — it must NEVER crash app startup. In a
  // plain node/jest env the real getInfoAsync resolves to undefined (no native
  // module), so treat any non-object/throw as "cannot stat → skip migration".
  let info: { exists: boolean; size?: number } | undefined;
  try {
    info = await fs.getInfoAsync(dbUri);
  } catch {
    return;
  }
  if (!info || !info.exists || !info.size) return; // fresh DB → opened/created encrypted

  // ── Detect ────────────────────────────────────────────────────────────────
  // Open a throwaway handle, apply the key, and probe. If the file is already
  // encrypted with our key the probe succeeds → nothing to migrate.
  let probe: SQLite.SQLiteDatabase | null = null;
  try {
    probe = await SQLite.openDatabaseAsync(dbName);
    await probe.execAsync(`PRAGMA key = "x'${keyHex}'"`);
    await probe.getFirstAsync('SELECT count(*) FROM sqlite_master');
    return; // already encrypted — done
  } catch {
    // Probe failed → the file is plaintext (or a foreign key). Re-encrypt below.
  } finally {
    try { await probe?.closeAsync(); } catch { /* ignore */ }
  }

  // ── Re-encrypt via sqlcipher_export ─────────────────────────────────────────
  const encName = `${dbName}.sqlcipher-enc`;
  // ATTACH needs a filesystem path, not a file:// URI.
  const encPath = `${dir}${encName}`.replace(/^file:\/\//, '');
  await FileSystem.deleteAsync(`${dir}${encName}`, { idempotent: true }).catch(() => {});

  let plain: SQLite.SQLiteDatabase | null = null;
  try {
    plain = await SQLite.openDatabaseAsync(dbName); // opened plaintext (no key)
    await plain.execAsync(
      `ATTACH DATABASE '${encPath}' AS encrypted KEY "x'${keyHex}'";` +
      `SELECT sqlcipher_export('encrypted');` +
      `DETACH DATABASE encrypted;`,
    );
  } finally {
    try { await plain?.closeAsync(); } catch { /* ignore */ }
  }

  // ── Swap: replace the plaintext file (and its journals) with the encrypted copy.
  await FileSystem.deleteAsync(dbUri, { idempotent: true }).catch(() => {});
  await FileSystem.deleteAsync(`${dbUri}-wal`, { idempotent: true }).catch(() => {});
  await FileSystem.deleteAsync(`${dbUri}-shm`, { idempotent: true }).catch(() => {});
  await fs.moveAsync({ from: `${dir}${encName}`, to: dbUri });
}

async function openAndInit(dbName: string): Promise<SQLite.SQLiteDatabase> {
  // x86 Android emulators (and New Architecture Bridgeless) cold-start the
  // expo-sqlite JSI bridge slowly: the native DB pointer can come back null for
  // the first several seconds, making execAsync reject with NullPointerException.
  // 16 attempts with a backoff capped at 500 ms (~10 s total) outlasts even the
  // slowest BlueStacks/emulator cold-start. On real arm64 devices the first
  // attempt almost always succeeds so the extra budget costs nothing in practice.
  const MAX_ATTEMPTS = 16;
  const BACKOFF_CAP_MS = 500;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let d: SQLite.SQLiteDatabase | null = null;
    try {
      // Ola 10: re-encrypt a legacy plaintext DB before opening (idempotent),
      // then open and apply the SQLCipher key as the VERY FIRST statement on the
      // handle — any PRAGMA/DDL before `PRAGMA key` would bypass the cipher.
      const keyHex = await getDbKeyHex();
      await migratePlaintextIfNeeded(dbName, keyHex);
      d = await SQLite.openDatabaseAsync(dbName);
      await d.execAsync(`PRAGMA key = "x'${keyHex}'"`);
      await initSchema(d);
      return d;
    } catch (e) {
      lastErr = e;
      const isNpe = e instanceof Error && e.message.includes('NullPointerException');
      // Only retry the known JSI/NPE pattern; let all other errors surface
      // immediately so they are not silently swallowed by retries.
      // After the last attempt, wrap the NPE in DbInitExhaustedError so that
      // withDb's outer retry layer does not add a redundant extra attempt.
      if (!isNpe) throw e;
      if (attempt === MAX_ATTEMPTS) throw new DbInitExhaustedError(e);
      // Close the half-initialised handle to avoid leaking native connections.
      try { await d?.closeAsync(); } catch { /* handle may be invalid — ignore */ }
      // Capped growing backoff: 100, 200, … ms up to BACKOFF_CAP_MS.
      // Gives the cold JSI bridge time to recover its internal state between
      // attempts (BlueStacks / New Architecture Bridgeless may need several
      // full seconds before the native SQLite pointer becomes non-null).
      const delay = Math.min(100 * attempt, BACKOFF_CAP_MS);
      await new Promise<void>((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

// ─── DB warm-up: kick off the native connection during splash/loading ──────────
//
// On Android New Architecture (Bridgeless) the expo-sqlite JSI module is NOT
// ready at the moment the first JS frame executes.  openAndInit's retry loop can
// absorb the NPE window, but ONLY if the warm-up starts early enough — before
// the user taps "Generate my identity".  We therefore expose:
//
//   warmUpDb()        — call this as early as possible in App lifecycle (alongside
//                       hydrate()). It fires the openAndInit chain in the
//                       background and records the result in dbReadyPromise.
//
//   dbReadyPromise    — resolves (never rejects) once the DB is genuinely open
//                       and schema-initialised, or once all retry attempts have
//                       been exhausted (in that case the gate lets through with
//                       "best effort" — withDb will surface the real error when
//                       the actual operation runs).
//
// UI callers (OnboardingScreen) should wait for dbReadyPromise before allowing
// identity generation so the user never hits the cold-start NPE window.

let _dbReadyResolve: (() => void) | null = null;

/**
 * A promise that resolves (always — never rejects) once the DB connection has
 * been confirmed open and schema-initialised, or once the cold-start retry budget
 * is exhausted.  Consumers use this as a gate: `await dbReadyPromise` before
 * issuing the first write.
 *
 * The promise is replaced whenever the active slot changes (setActiveDbSlot) so
 * that slot-switch consumers get a fresh ready signal for the new DB file.
 */
export let dbReadyPromise: Promise<void> = new Promise<void>((resolve) => {
  _dbReadyResolve = resolve;
});

/**
 * Kicks off the DB warm-up as early as possible in the app lifecycle.
 *
 * Call once from App.tsx (e.g. alongside `void hydrate()`) on first mount.
 * Subsequent calls for the same slot are no-ops because db() memoises the
 * connection promise.  The function never throws — all errors are absorbed and
 * dbReadyPromise resolves so the UI gate doesn't block forever.
 */
export function warmUpDb(): void {
  // Fire-and-forget: db() starts openAndInit which retries on NPE.
  // When it resolves the DB is genuinely open; resolve the ready promise.
  void db().then(() => {
    _dbReadyResolve?.();
    _dbReadyResolve = null;
  }).catch(() => {
    // Even on exhausted retries, resolve (not reject) so the UI gate releases
    // and the real error surfaces when the first actual DB operation runs.
    _dbReadyResolve?.();
    _dbReadyResolve = null;
  });
}

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (dbFatalError) throw dbFatalError;

  // Wait until any in-progress close finishes before opening a new connection.
  if (_closing) {
    await new Promise<void>((resolve) => {
      const interval = setInterval(() => {
        if (!_closing) { clearInterval(interval); resolve(); }
      }, 10);
    });
  }
  if (!dbPromise) {
    const dbName = activeSlot === 'self' ? 'aegislink.db' : `aegislink_${activeSlot}.db`;
    // Do NOT pass useNewConnection: true — expo-sqlite manages the shared
    // WAL-mode connection and handles lifecycle correctly. useNewConnection
    // creates an independent handle that becomes invalid after closeAsync()
    // causing "Access to closed resource" on concurrent operations.
    //
    // The startup purge of expired ephemeral messages uses runAsync and is
    // kept here (after openAndInit) rather than inside initSchema.  This
    // preserves the withDb NPE retry layer's visibility over runAsync failures
    // and ensures the existing test contract (openDatabaseAsync call counts)
    // is not disturbed by openAndInit's internal NPE retry loop.
    dbPromise = openAndInit(dbName).then(async (d) => {
      // Purge messages that expired while the app was closed.
      // This ensures ephemeral messages are removed on every cold start,
      // not only when foreground pruning runs.
      await d.runAsync(
        'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?',
        Date.now()
      );
      return d;
    }).catch((err) => {
      // Reset so the next call retries cleanly instead of re-returning
      // this permanently-rejected promise (which causes infinite NPE crashes).
      dbPromise = null;
      if (!isRecoverableDbError(err)) {
        dbFatalError = err instanceof Error ? err : new Error(String(err));
      }
      throw err;
    });
  }
  return dbPromise;
}

/**
 * True when an error is the expo-sqlite JSI "use-after-close" / null-handle race
 * (or a closed-resource access) that a fresh connection can recover from.
 */
function isRecoverableDbError(e: unknown): boolean {
  return e instanceof Error && (
    e.message.includes('NullPointerException') ||
    e.message.includes('has been rejected') ||
    e.message.includes('Access to closed resource') ||
    e.message.includes('NativeDatabase')
  );
}

/**
 * Inner executor: runs one DB operation, retrying on the recoverable expo-sqlite
 * JSI handle errors. This is the LAST-RESORT safety net — the primary defense is
 * serialization in withDb() below, which prevents the race from happening at all.
 *
 * Keeping all awaits (including encrypt/decrypt) inside fn ensures the DB handle
 * is obtained immediately before use rather than held across unrelated async gaps.
 */
async function withDbInner<T>(fn: (d: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const MAX_RETRIES = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn(await db());
    } catch (e) {
      lastErr = e;
      // openAndInit already exhausted its own (now 8) cold-start attempts with
      // growing backoff — don't pile on another full cycle here.
      if (e instanceof DbInitExhaustedError) throw e;
      if (!isRecoverableDbError(e) || attempt === MAX_RETRIES) throw e;
      // CLOSE the wedged handle before reopening — do NOT just null the promise.
      // expo-sqlite (no useNewConnection) keeps ONE shared native connection per
      // db file. If that connection enters the JSI NullPointerException state and
      // we merely null dbPromise, the next db() reopen hands back the SAME dead
      // connection, so the NPE repeats on every retry and the DB stays wedged
      // forever — which is why a single failure cascaded into "todo se rompe"
      // (messages, attachments, groups, profile sync) until app restart. Closing
      // forces expo-sqlite to discard the dead connection and build a fresh one.
      const staleDb = dbPromise;
      dbPromise = null;
      cachedDbKey = null;
      if (staleDb) {
        try { await (await staleDb).closeAsync(); } catch { /* already dead — ignore */ }
      }
      await new Promise<void>((r) => setTimeout(r, 80 * (attempt + 1)));
    }
  }
  throw lastErr;
}

// ─── Serialized DB access (the real fix for the NPE race) ─────────────────────
// expo-sqlite v16 on Android (New Architecture/JSI) throws
// "NativeDatabase.execAsync ... NullPointerException" when two operations race on
// the native handle — the classic "use after close" condition that surfaces
// whenever encrypt/decrypt (SecureStore, ~50-100 ms) yields mid-operation and a
// second query starts. The industry-standard cure (op-sqlite, WatermelonDB,
// Signal's SQLCipher layer) is NOT to retry but to SERIALIZE: run every DB
// operation one-at-a-time through a FIFO queue so two operations can never touch
// the handle concurrently. That makes the race structurally impossible. The
// retry loop in withDbInner stays only as a cold-start safety net.
let dbOpQueue: Promise<unknown> = Promise.resolve();

export async function withDb<T>(fn: (d: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
  const run = dbOpQueue.then(() => withDbInner(fn));
  // Keep the chain alive whether this op resolves or rejects, so one failure
  // never wedges the queue for every subsequent operation.
  dbOpQueue = run.then(() => undefined, () => undefined);
  return run as Promise<T>;
}

// ─── Identity ────────────────────────────────────────────────────────────────

export async function saveIdentity(v: StoredIdentity): Promise<void> {
  // expo-secure-store can fail with NullPointerException on Android if the
  // Keystore has stale entries from a previous installation (classic "update
  // over old APK" corruption).  Attempt once; on failure, clear the stale
  // entries and retry exactly once so a fresh install recovers automatically.
  // AFTER_FIRST_UNLOCK: compatible with Android 14 hardware-backed Keystore
  // (StrongBox). Without this, setItemAsync can throw a native NPE on first
  // write on real devices even when the JS catch would normally handle it.
  const secureOpts: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  };
  const persistKeys = async () => {
    await SecureStore.setItemAsync(getSecretKeySlot(), v.secretKeyB64, secureOpts);
    await SecureStore.setItemAsync(getSignSecretKeySlot(), v.signingSecretKeyB64, secureOpts);
  };
  try {
    await persistKeys();
  } catch {
    // Clear potentially corrupted entries and retry.
    await SecureStore.deleteItemAsync(getSecretKeySlot()).catch(() => {});
    await SecureStore.deleteItemAsync(getSignSecretKeySlot()).catch(() => {});
    await persistKeys(); // if this throws again, surface the real error
  }
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO identity (slot, aegis_id, public_key_b64, signing_public_key_b64, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      activeSlot,
      v.aegisId,
      v.publicKeyB64,
      v.signingPublicKeyB64,
      v.createdAt
    );
  });
}

export async function loadIdentity(): Promise<StoredIdentity | null> {
  const secretKeyB64 = await SecureStore.getItemAsync(getSecretKeySlot());
  const signingSecretKeyB64 = await SecureStore.getItemAsync(getSignSecretKeySlot());
  if (!secretKeyB64 || !signingSecretKeyB64) return null;
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{
      aegis_id: string;
      public_key_b64: string;
      signing_public_key_b64: string;
      created_at: number;
    }>(`SELECT aegis_id, public_key_b64, signing_public_key_b64, created_at FROM identity WHERE slot = ?`, activeSlot);
    if (!row) return null;
    return {
      aegisId: row.aegis_id,
      publicKeyB64: row.public_key_b64,
      secretKeyB64: secretKeyB64,
      signingPublicKeyB64: row.signing_public_key_b64,
      signingSecretKeyB64: signingSecretKeyB64,
      createdAt: row.created_at,
    };
  });
}

export async function clearIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(getSecretKeySlot());
  await SecureStore.deleteItemAsync(getSignSecretKeySlot());
  return withDb(async (d) => {
    await d.execAsync(
      `DELETE FROM identity;
       DELETE FROM contacts;
       DELETE FROM messages;
       DELETE FROM ratchet_sessions;
       DELETE FROM groups;
       DELETE FROM chat_state;
       DELETE FROM call_history;
       DELETE FROM prekey_secrets;`
    );
  });
}

// ─── Database Encryption At-Rest (Fase 4) ───────────────────────────────────

let cachedDbKey: Uint8Array | null = null;

export async function getDbKey(): Promise<Uint8Array> {
  if (cachedDbKey) return cachedDbKey;
  const slotKey = getDbEncKeySlot();
  let keyB64 = await ss.get(slotKey);
  if (!keyB64) {
    const keyBytes = nacl.randomBytes(32);
    keyB64 = encodeBase64(keyBytes);
    await ss.set(slotKey, keyB64);
  }
  cachedDbKey = decodeBase64(keyB64);
  return cachedDbKey;
}

export async function encryptBody(body: string): Promise<string> {
  try {
    const key = await getDbKey();
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const bodyBytes = new TextEncoder().encode(body);
    const encrypted = nacl.secretbox(bodyBytes, nonce, key);
    const result = {
      ct: encodeBase64(encrypted),
      n: encodeBase64(nonce)
    };
    return 'encv1:' + JSON.stringify(result);
  } catch (e) {
    throw new Error(`encryptBody: SecureStore unavailable — ${(e as Error).message}`);
  }
}

/**
 * Thrown when at-rest decryption fails. Carries no plaintext or key material.
 * Used by the fail-closed key-material accessors below so that a decryption
 * failure can never be mistaken for valid data (golden rule #1).
 */
export class DecryptionError extends Error {
  constructor(reason: string) {
    super(`decrypt failed: ${reason}`);
    this.name = 'DecryptionError';
  }
}

/**
 * Display-path decryption. On failure returns a VISIBLE marker (never silent,
 * never fabricated plaintext) so the UI can render an explicit "could not
 * decrypt" state. NOT for key material — use {@link decryptSecretOrNull} for
 * ratchet state, prekey secrets, etc.
 */
export async function decryptBody(encryptedBody: string): Promise<string> {
  if (!encryptedBody || !encryptedBody.startsWith('encv1:')) return encryptedBody;
  try {
    return await decryptBodyStrict(encryptedBody);
  } catch {
    return '[DECRYPTION_ERROR]';
  }
}

/**
 * Strict decryption primitive: throws {@link DecryptionError} on ANY failure
 * (bad ciphertext, MAC failure, unavailable DB key). Never returns a sentinel.
 */
async function decryptBodyStrict(encryptedBody: string): Promise<string> {
  if (!encryptedBody || !encryptedBody.startsWith('encv1:')) return encryptedBody;
  const key = await getDbKey();
  const jsonStr = encryptedBody.slice(6);
  let parsed: { ct: string; n: string };
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new DecryptionError('malformed envelope');
  }
  const ct = decodeBase64(parsed.ct);
  const nonce = decodeBase64(parsed.n);
  const decrypted = nacl.secretbox.open(ct, nonce, key);
  if (!decrypted) throw new DecryptionError('authentication failed');
  return new TextDecoder().decode(decrypted);
}

/**
 * Fail-closed decryption for KEY MATERIAL (ratchet state, prekey secrets).
 * Returns null on failure — the caller MUST treat null as "absent" and
 * regenerate / re-establish rather than proceeding with garbage. NEVER
 * returns a sentinel string that could be parsed as key material.
 */
export async function decryptSecretOrNull(encryptedBody: string): Promise<string | null> {
  try {
    return await decryptBodyStrict(encryptedBody);
  } catch {
    return null;
  }
}

// ─── wipeDatabase ────────────────────────────────────────────────────────────

export async function wipeDatabase(): Promise<void> {
  // ── Phase 1: read slot-dependent info BEFORE touching the DB queue ──────────
  // All SecureStore operations are outside withDb — they do NOT need the SQLite
  // handle and must never be nested inside a withDb callback (that would cause a
  // re-entrant enqueue on the FIFO dbOpQueue → permanent deadlock).
  const slot = activeSlot;
  const prefix = slot === 'self' ? '' : `${slot}.`;

  // Read OPK id list now so we can purge individual keys below.
  const opkIdsRaw = await SecureStore.getItemAsync(`aegis.${prefix}opkIds.json`).catch(() => null);

  // Read multi-slot list now so we can wipe other slots after the main DB wipe.
  const slotsListRaw = await SecureStore.getItemAsync('aegis.slotsList').catch(() => null);

  // ── Phase 2: single withDb — ALL SQLite deletes + VACUUM in one queue slot ──
  // Inline the DELETEs that clearIdentity() would do so we never call withDb
  // from inside a withDb callback. clearIdentity() itself is left untouched for
  // its other call-sites; we just don't invoke it from here.
  await withDb(async (d) => {
    await d.execAsync(
      `DELETE FROM identity;
       DELETE FROM messages;
       DELETE FROM contacts;
       DELETE FROM groups;
       DELETE FROM ratchet_sessions;
       DELETE FROM chat_state;
       DELETE FROM call_history;
       DELETE FROM polls;
       DELETE FROM scheduled_messages;
       DELETE FROM prekey_secrets;`
    );
    // SQLite DELETE only removes pages from the free-list — VACUUM overwrites
    // freed pages with zeros so forensic reads of the raw db file find nothing.
    await d.execAsync('VACUUM');
  });

  // ── Phase 3: SecureStore purges — all outside the withDb callback ────────────

  // Identity secret keys (mirrors what clearIdentity does in SecureStore).
  await SecureStore.deleteItemAsync(getSecretKeySlot()).catch(() => {});
  await SecureStore.deleteItemAsync(getSignSecretKeySlot()).catch(() => {});

  // At-rest DB encryption key — purge AFTER the withDb so the handle is gone.
  cachedDbKey = null;
  await SecureStore.deleteItemAsync(getDbEncKeySlot()).catch(() => {});

  // X3DH prekey secrets (SPK + OPKs) for the active slot.
  if (opkIdsRaw) {
    try {
      const ids: number[] = JSON.parse(opkIdsRaw) as number[];
      for (const id of ids) {
        await SecureStore.deleteItemAsync(`aegis.${prefix}opkSecret.${id}`).catch(() => {});
        await SecureStore.deleteItemAsync(`aegis.${prefix}spkSecret.${id}`).catch(() => {});
      }
    } catch { /* non-fatal */ }
  }
  await SecureStore.deleteItemAsync(`aegis.${prefix}opkIds.json`).catch(() => {});
  await SecureStore.deleteItemAsync(`aegis.${prefix}spkSecret.b64`).catch(() => {});
  await SecureStore.deleteItemAsync(`aegis.${prefix}spk.keyId`).catch(() => {});

  // Cold-start published flag for the active slot.
  await SecureStore.deleteItemAsync(`aegis.published.${slot}`).catch(() => {});

  // Multi-slot cleanup: wipe every additional slot's DB file and SecureStore
  // keys. deleteIdentitySlot handles all key material + SQLite files for each
  // non-active slot. The active slot's data was already wiped above.
  if (slotsListRaw) {
    try {
      const slotsList: string[] = JSON.parse(slotsListRaw) as string[];
      for (const s of slotsList) {
        if (s !== slot) {
          await deleteIdentitySlot(s).catch(() => {});
        }
      }
    } catch { /* non-fatal */ }
  }
  await SecureStore.deleteItemAsync('aegis.slotsList').catch(() => {});
  await SecureStore.deleteItemAsync('aegis.activeSlotId').catch(() => {});

  // Forensic remnants: panic config + user preferences.
  // Without this, a post-wipe forensic analysis could detect that a
  // panic-enabled account existed on the device.
  await SecureStore.deleteItemAsync('aegis.panic.v1').catch(() => {});
  await SecureStore.deleteItemAsync('aegis.preferences.v1').catch(() => {});
  await SecureStore.deleteItemAsync('aegis.polls.v1').catch(() => {});

  // Reset the IN-MEMORY preferences store too — deleting the SecureStore blob
  // above is not enough, since usePreferences (Zustand) keeps the last
  // hydrated values in RAM. Without this, appLockEnabled stays true after a
  // panic wipe, the lock-gate re-arms for the freshly regenerated identity,
  // and — since aegis.pin.hash was just deleted — NO PIN can ever unlock it:
  // a permanent lockout on a brand-new account. Lazy require avoids a cycle
  // (preferences.ts doesn't import db/core.ts, but keep this defensive).
  try {
    const { usePreferences } = require('../store/preferences') as typeof import('../store/preferences');
    await usePreferences.getState().reset();
  } catch { /* non-fatal — SecureStore key above is already gone either way */ }
  // A surviving decoy blob would prove the duress feature was configured.
  await SecureStore.deleteItemAsync('aegis.duress.decoy.v1').catch(() => {});

  // App-lock PIN material (global keys, no slot prefix — see lock/pin.ts).
  // A surviving PIN hash/salt would (a) keep the OLD PIN gating the lock
  // screen for an identity that no longer exists, and (b) prove to a
  // forensic analysis that an app-lock was configured, contradicting the
  // "leaves nothing behind" promise of panic mode.
  await SecureStore.deleteItemAsync('aegis.pin.hash').catch(() => {});
  await SecureStore.deleteItemAsync('aegis.pin.salt.v2').catch(() => {});
  // Legacy v1 lock-settings blob: current builds persist lock prefs inside
  // aegis.preferences.v1 (already purged above), but devices upgraded from v1
  // still carry this key. Best-effort delete so an upgraded device leaves no
  // proof that an app-lock was ever configured.
  await SecureStore.deleteItemAsync('aegis.lockSettings').catch(() => {});
}
