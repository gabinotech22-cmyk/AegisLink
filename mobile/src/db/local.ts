import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { ss } from '../utils/secureStore';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { secretKeySlot, signSecretKeySlot, dbEncKeySlot } from '../crypto/types';

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
  activeSlot = slot;
  dbPromise = null;
  cachedDbKey = null;
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
 * Runs every PRAGMA, CREATE TABLE, and migration execAsync on a freshly opened
 * SQLiteDatabase handle.  Only execAsync calls are made here so that openAndInit
 * can safely retry this function on NullPointerException without interfering with
 * the withDb retry layer that handles runAsync NPEs inside operation callbacks.
 *
 * The startup-purge of expired messages (runAsync) is intentionally kept outside
 * this function — it is run by db() after openAndInit succeeds so it remains
 * visible to the withDb NPE retry wrapper.
 *
 * CONTRACT: all SQL here is idempotent (IF NOT EXISTS, ALTER … catch, etc.)
 * so re-running after a partial failure is always safe.
 */
async function initSchema(d: SQLite.SQLiteDatabase): Promise<void> {
  // Run PRAGMAs in isolation — mixing PRAGMA + DDL in one execAsync call
  // crashes on Android 14 with New Architecture (expo-sqlite v16 JSI).
  //
  // ── DO NOT use WAL here. ──────────────────────────────────────────────────
  // WAL requires a shared-memory (mmap) VFS. On x86 Android emulators
  // (BlueStacks) and some New-Architecture JSI builds that VFS is missing, so
  // `PRAGMA journal_mode = WAL` rejects with
  //   "NativeDatabase.execAsync ... NullPointerException".
  // The old code caught that and fell back to TRUNCATE, but the fallback ran on
  // the SAME already-poisoned native handle, so the next execAsync (the CREATE
  // TABLE block) NPE'd too — cascading into initSchema failing and the WHOLE app
  // breaking (add contact, send message/attachment, groups, profile sync all
  // reject with the same execAsync NPE — exactly the user-reported crash).
  //
  // Crucially, AegisLink serializes EVERY DB operation through dbOpQueue, so
  // WAL's only real benefit (concurrent readers) is unused. Using DELETE — the
  // universal SQLite journal mode that needs no shared memory — costs us nothing
  // and removes the entire shared-memory NPE failure class on every device.
  try {
    await d.execAsync('PRAGMA journal_mode = DELETE;');
  } catch {
    // Setting the journal mode can itself transiently NPE on a cold JSI bridge.
    // It is non-fatal (DELETE is already SQLite's default), and any genuinely
    // broken handle is caught + reopened fresh by openAndInit's NPE retry loop.
  }
  await d.execAsync('PRAGMA foreign_keys = ON;');
  await d.execAsync(`
    CREATE TABLE IF NOT EXISTS identity (
      slot                    TEXT PRIMARY KEY,
      aegis_id                TEXT NOT NULL,
      public_key_b64          TEXT NOT NULL,
      signing_public_key_b64  TEXT NOT NULL,
      created_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      aegis_id                TEXT PRIMARY KEY,
      public_key_b64          TEXT NOT NULL,
      signing_public_key_b64  TEXT NOT NULL,
      name                    TEXT NOT NULL,
      verified                INTEGER NOT NULL DEFAULT 0,
      added_at                INTEGER NOT NULL,
      color                   TEXT,
      avatar_image            TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id              TEXT PRIMARY KEY,
      chat_id         TEXT NOT NULL,
      direction       TEXT NOT NULL,
      body            TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      type            TEXT,
      media_uri       TEXT,
      reply_to_id     TEXT,
      reactions       TEXT,
      starred         INTEGER NOT NULL DEFAULT 0,
      deleted         INTEGER NOT NULL DEFAULT 0,
      delivery_status TEXT NOT NULL DEFAULT 'sent',
      expires_at      INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

    -- Double Ratchet State
    CREATE TABLE IF NOT EXISTS ratchet_sessions (
      aegis_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL
    );

    -- MLS Group Chats (Fase 4)
    CREATE TABLE IF NOT EXISTS groups (
      id                    TEXT PRIMARY KEY,
      name                  TEXT NOT NULL,
      members               TEXT NOT NULL,
      created_at            INTEGER NOT NULL,
      avatar_color          TEXT,
      avatar_image          TEXT,
      admin_only_invite     INTEGER NOT NULL DEFAULT 1,
      moderate_new_members  INTEGER NOT NULL DEFAULT 0,
      admin_id              TEXT,
      admin_sig             TEXT,
      moderators            TEXT
    );

    -- Per-chat state: draft text + unread count
    CREATE TABLE IF NOT EXISTS chat_state (
      chat_id      TEXT PRIMARY KEY,
      draft        TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0
    );

    -- Call history log
    CREATE TABLE IF NOT EXISTS call_history (
      id          TEXT PRIMARY KEY,
      contact_id  TEXT NOT NULL,
      direction   TEXT NOT NULL, -- 'in' | 'out'
      media       TEXT NOT NULL, -- 'audio' | 'video'
      status      TEXT NOT NULL, -- 'missed' | 'answered' | 'declined'
      started_at  INTEGER NOT NULL,
      duration_s  INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_calls_contact ON call_history(contact_id, started_at);

    -- Poll vote counts (aggregate only — no voter identity)
    CREATE TABLE IF NOT EXISTS polls (
      id         TEXT PRIMARY KEY,
      question   TEXT NOT NULL,
      options    TEXT NOT NULL,   -- JSON array of option strings
      votes      TEXT NOT NULL,   -- JSON array of vote counts (number[])
      created_at INTEGER NOT NULL,
      group_id   TEXT NOT NULL
    );

    -- Scheduled messages: ciphertext stored, plaintext never on disk
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id                TEXT PRIMARY KEY,
      recipient_aegis_id TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      send_at           INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      retry_count       INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_send_at ON scheduled_messages(send_at, status);

    -- Persistent outbox: jobs survive app close / crash (Signal-style outbox pattern).
    -- payload is the plaintext JSON to be ratchet-encrypted at drain time, stored
    -- encrypted at rest via encryptBody so plaintext never lands unprotected on disk.
    CREATE TABLE IF NOT EXISTS outbox (
      job_id               TEXT PRIMARY KEY,
      msg_id               TEXT NOT NULL,
      recipient_aegis_id   TEXT NOT NULL,
      recipient_pubkey_b64 TEXT NOT NULL,
      payload              TEXT NOT NULL,
      kind                 TEXT NOT NULL,
      group_id             TEXT,
      created_at           INTEGER NOT NULL,
      attempts             INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_outbox_created ON outbox(created_at);
  `);

  // ─── Schema versioning via PRAGMA user_version ──────────────────────────
  // Bump USER_DB_VERSION whenever a migration must run on existing installs.
  const USER_DB_VERSION = 5;
  const versionRow = await d.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;

  if (currentVersion < 1) {
    // v0 → v1: clear ratchet sessions corrupted by the Bob-side DHs bug
    // (initRatchet used a random key pair instead of SPK, producing wrong CKr).
    await d.execAsync('DELETE FROM ratchet_sessions');
    await d.execAsync('PRAGMA user_version = 1');
  }

  if (currentVersion < 2) {
    // v1 → v2: add delivery_status for read receipts and delivery indicators
    try { await d.execAsync("ALTER TABLE messages ADD COLUMN delivery_status TEXT NOT NULL DEFAULT 'sent';"); } catch (e) {}
    await d.execAsync('PRAGMA user_version = 2');
  }

  if (currentVersion < 3) {
    // v2 → v3: add admin/permission columns to groups table.
    // The CREATE TABLE above includes these for fresh installs; here we patch
    // existing databases that were created with the old 6-column schema.
    // Each ALTER is wrapped individually — "duplicate column name" means the
    // column already exists (e.g. from an earlier unconditional migration run),
    // which is harmless and should be silently ignored.
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN admin_only_invite INTEGER NOT NULL DEFAULT 1;'); } catch {}
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN moderate_new_members INTEGER NOT NULL DEFAULT 0;'); } catch {}
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN admin_id TEXT;'); } catch {}
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN admin_sig TEXT;'); } catch {}
    await d.execAsync('PRAGMA user_version = 3');
  }

  if (currentVersion < 4) {
    // v3 → v4: add moderators column (JSON array of aegisIds).
    // Fresh installs already have this column via CREATE TABLE above.
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN moderators TEXT;'); } catch {}
    await d.execAsync('PRAGMA user_version = 4');
  }

  if (currentVersion < 5) {
    // v4 → v5: add persistent outbox table for Signal-style reliable delivery.
    // The CREATE TABLE IF NOT EXISTS above already handles fresh installs;
    // this branch runs only for existing users upgrading from v4.
    // No ALTER needed — outbox is a brand-new table.
    await d.execAsync('PRAGMA user_version = 5');
  }

  // Suppress USER_DB_VERSION "unused" warning — the constant documents intent.
  void USER_DB_VERSION;

  // Database migrations: Alter tables safely to append optional columns on existing installs
  try {
    await d.execAsync('ALTER TABLE contacts ADD COLUMN signing_public_key_b64 TEXT DEFAULT "";');
  } catch (e) {}
  try {
    await d.execAsync('ALTER TABLE contacts ADD COLUMN color TEXT;');
  } catch (e) {}
  try {
    await d.execAsync('ALTER TABLE contacts ADD COLUMN avatar_image TEXT;');
  } catch (e) {}

  try {
    await d.execAsync('ALTER TABLE groups ADD COLUMN avatar_color TEXT;');
  } catch (e) {}
  try {
    await d.execAsync('ALTER TABLE groups ADD COLUMN avatar_image TEXT;');
  } catch (e) {}
  // Contact capabilities (mute, zero-trust mode, status, block)
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN muted INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN zero_trust INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN status TEXT;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN muted_until INTEGER;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
  try { await d.execAsync("ALTER TABLE contacts ADD COLUMN profile TEXT NOT NULL DEFAULT 'personal';"); } catch (e) {}
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN last_seen_at INTEGER;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN online INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}

  // Message capabilities (replies, reactions, star, delete, media)
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN type TEXT;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN media_uri TEXT;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN reply_to_id TEXT;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN reactions TEXT;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN deleted INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN expires_at INTEGER;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE chat_state ADD COLUMN ephemeral_timer INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
}

/**
 * Opens the database file and runs the full schema initialisation.
 *
 * Retries up to MAX_ATTEMPTS times when the failure is a NullPointerException
 * originating from the expo-sqlite JSI bridge on Android.  This NPE pattern is
 * observed on BlueStacks and some x86 emulators where the WAL shared-memory
 * VFS initialisation races against the JSI thread during cold-start.  Each
 * retry closes the half-initialised handle (to avoid native connection leaks)
 * and introduces a small growing backoff that gives the JSI bridge time to
 * stabilise before the next attempt.
 *
 * Non-NPE errors (disk full, file corruption, …) are propagated immediately on
 * the first occurrence — they are not transient and retrying would not help.
 */
async function openAndInit(dbName: string): Promise<SQLite.SQLiteDatabase> {
  // x86 Android emulators (BlueStacks) cold-start the expo-sqlite JSI bridge
  // slowly: the native DB pointer can come back null for the first several
  // hundred ms, making the first execAsync reject with a NullPointerException.
  // Be patient — 8 attempts with growing backoff (~0.1s→0.8s, ~3.6s total) lets
  // the bridge stabilise. On real arm64 devices the first attempt almost always
  // succeeds, so this costs nothing there.
  const MAX_ATTEMPTS = 8;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let d: SQLite.SQLiteDatabase | null = null;
    try {
      d = await SQLite.openDatabaseAsync(dbName);
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
      // Growing backoff: 100, 200, 300 … ms — gives the cold JSI bridge time to
      // recover its internal state between attempts (BlueStacks needs more than
      // the original ~60 ms).
      await new Promise<void>((r) => setTimeout(r, 100 * attempt));
    }
  }
  throw lastErr;
}

async function db(): Promise<SQLite.SQLiteDatabase> {
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

async function withDb<T>(fn: (d: SQLite.SQLiteDatabase) => Promise<T>): Promise<T> {
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
       DELETE FROM call_history;`
    );
  });
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export interface StoredContact {
  aegisId: string;
  publicKeyB64: string;
  name: string;
  verified: boolean;
  addedAt: number;
  signingPublicKeyB64?: string;
  color?: string;
  avatarImage?: string | null;
  muted?: boolean;
  mutedUntil?: number | null; // 0 = forever, epoch ms = until, null = not muted
  zeroTrust?: boolean;
  status?: string;
  blocked?: boolean;
  archived?: boolean;
  profile?: 'personal' | 'work';
  lastSeenAt?: number;
  online?: boolean;
  pinned?: boolean;
}

export async function saveContact(c: StoredContact): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO contacts
       (aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      c.aegisId,
      c.publicKeyB64,
      c.signingPublicKeyB64 || "",
      c.name,
      c.verified ? 1 : 0,
      c.addedAt,
      c.color || null,
      c.avatarImage || null,
      c.muted ? 1 : 0,
      c.zeroTrust ? 1 : 0,
      c.status ?? null,
      c.mutedUntil ?? null,
      c.blocked ? 1 : 0,
      c.archived ? 1 : 0,
      c.profile ?? 'personal',
      c.pinned ? 1 : 0,
      c.lastSeenAt ?? null,
      c.online ? 1 : 0
    );
  });
}

export async function pinContact(aegisId: string, pinned: boolean): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE contacts SET pinned = ? WHERE aegis_id = ?', pinned ? 1 : 0, aegisId);
  });
}

type ContactRow = {
  aegis_id: string;
  public_key_b64: string;
  signing_public_key_b64: string | null;
  name: string;
  verified: number;
  added_at: number;
  color: string | null;
  avatar_image: string | null;
  muted: number;
  zero_trust: number;
  status: string | null;
  muted_until: number | null;
  blocked: number;
  archived: number;
  profile: string;
  pinned: number;
  last_seen_at: number | null;
  online: number;
};

function rowToContact(r: ContactRow): StoredContact {
  return {
    aegisId: r.aegis_id,
    publicKeyB64: r.public_key_b64,
    signingPublicKeyB64: r.signing_public_key_b64 || undefined,
    name: r.name,
    verified: r.verified === 1,
    addedAt: r.added_at,
    color: r.color || undefined,
    avatarImage: r.avatar_image || null,
    muted: r.muted === 1,
    mutedUntil: r.muted_until ?? null,
    zeroTrust: r.zero_trust === 1,
    status: r.status ?? undefined,
    blocked: r.blocked === 1,
    archived: r.archived === 1,
    profile: (r.profile === 'work' ? 'work' : 'personal') as 'personal' | 'work',
    pinned: r.pinned === 1,
    lastSeenAt: r.last_seen_at ?? undefined,
    online: r.online === 1,
  };
}

export async function loadContacts(profile?: 'personal' | 'work'): Promise<StoredContact[]> {
  return withDb(async (d) => {
    const rows = profile
      ? await d.getAllAsync<ContactRow>(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online FROM contacts WHERE profile = ? ORDER BY added_at DESC`,
          profile
        )
      : await d.getAllAsync<ContactRow>(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online FROM contacts ORDER BY added_at DESC`
        );
    return rows.map(rowToContact);
  });
}

export async function getContact(aegisId: string): Promise<StoredContact | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<ContactRow>(
      `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online FROM contacts WHERE aegis_id = ?`,
      aegisId
    );
    if (!row) return null;
    return rowToContact(row);
  });
}

export async function deleteContactMessages(chatId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM messages WHERE chat_id = ?', chatId);
  });
}

export async function deleteContactRatchetSession(aegisId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM ratchet_sessions WHERE aegis_id = ?', aegisId);
  });
}

export async function deleteContact(aegisId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM contacts WHERE aegis_id = ?', aegisId);
  });
}

// ─── Database Encryption At-Rest (Fase 4) ───────────────────────────────────

let cachedDbKey: Uint8Array | null = null;

async function getDbKey(): Promise<Uint8Array> {
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

export async function decryptBody(encryptedBody: string): Promise<string> {
  if (!encryptedBody || !encryptedBody.startsWith('encv1:')) return encryptedBody;
  try {
    const key = await getDbKey();
    const jsonStr = encryptedBody.slice(6);
    const parsed = JSON.parse(jsonStr);
    const ct = decodeBase64(parsed.ct);
    const nonce = decodeBase64(parsed.n);
    const decrypted = nacl.secretbox.open(ct, nonce, key);
    if (!decrypted) return '[DECRYPTION_ERROR]';
    return new TextDecoder().decode(decrypted);
  } catch (e) {
    return '[DECRYPTION_ERROR]';
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'poll' | 'location' | 'view_once';

export interface MessageReactions {
  [emoji: string]: string[]; // emoji -> list of aegisIds who reacted
}

export interface StoredMessage {
  id: string;
  chatId: string;
  direction: 'in' | 'out';
  body: string;
  createdAt: number;
  type?: MessageType;
  mediaUri?: string | null;
  replyToId?: string | null;
  reactions?: MessageReactions;
  starred?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  deliveryStatus?: 'sent' | 'delivered' | 'read';
  expiresAt?: number | null;
}

interface MessageRow {
  id: string;
  chat_id: string;
  direction: string;
  body: string;
  created_at: number;
  type: string | null;
  media_uri: string | null;
  reply_to_id: string | null;
  reactions: string | null;
  starred: number;
  deleted: number;
  pinned: number;
  delivery_status: string | null;
  expires_at: number | null;
}

async function rowToMessage(r: MessageRow, body: string): Promise<StoredMessage> {
  let reactions: MessageReactions | undefined;
  if (r.reactions) {
    try { reactions = JSON.parse(r.reactions); } catch { /* ignore */ }
  }
  const mediaUri = r.media_uri ? await decryptBody(r.media_uri) : null;
  return {
    id: r.id,
    chatId: r.chat_id,
    direction: r.direction as 'in' | 'out',
    body,
    createdAt: r.created_at,
    type: (r.type as MessageType | null) ?? 'text',
    mediaUri,
    replyToId: r.reply_to_id ?? null,
    reactions,
    starred: r.starred === 1,
    deleted: r.deleted === 1,
    pinned: r.pinned === 1,
    deliveryStatus: (r.delivery_status as 'sent' | 'delivered' | 'read' | null) ?? 'sent',
    expiresAt: r.expires_at ?? null,
  };
}

export async function saveMessage(m: StoredMessage): Promise<void> {
  return withDb(async (d) => {
    const encrypted = await encryptBody(m.body);
    const encryptedMediaUri = m.mediaUri ? await encryptBody(m.mediaUri) : null;
    await d.runAsync(
      `INSERT OR REPLACE INTO messages
       (id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.id,
      m.chatId,
      m.direction,
      encrypted,
      m.createdAt,
      m.type ?? 'text',
      encryptedMediaUri,
      m.replyToId ?? null,
      m.reactions ? JSON.stringify(m.reactions) : null,
      m.starred ? 1 : 0,
      m.deleted ? 1 : 0,
      m.pinned ? 1 : 0,
      m.deliveryStatus ?? 'sent',
      m.expiresAt ?? null
    );
  });
}

export async function updateMessageDelivery(id: string, status: 'sent' | 'delivered' | 'read'): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET delivery_status = ? WHERE id = ?', status, id);
  });
}

export async function loadMessagesByChat(chatId: string): Promise<StoredMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<MessageRow>(
      `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
       FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
      chatId
    );
    return Promise.all(rows.map(async (r) => await rowToMessage(r, await decryptBody(r.body))));
  });
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<MessageRow>(
      `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
       FROM messages WHERE id = ?`,
      id
    );
    if (!row) return null;
    return await rowToMessage(row, await decryptBody(row.body));
  });
}

export async function setMessagePinned(id: string, pinned: boolean): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`UPDATE messages SET pinned = ? WHERE id = ?`, pinned ? 1 : 0, id);
  });
}

export async function getPinnedMessage(chatId: string): Promise<StoredMessage | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<MessageRow>(
      `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status
       FROM messages WHERE chat_id = ? AND pinned = 1 ORDER BY created_at DESC LIMIT 1`,
      chatId
    );
    if (!row) return null;
    return await rowToMessage(row, await decryptBody(row.body));
  });
}

export async function setMessageStarred(id: string, starred: boolean): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`UPDATE messages SET starred = ? WHERE id = ?`, starred ? 1 : 0, id);
  });
}

export async function setMessageDeleted(id: string): Promise<void> {
  return withDb(async (d) => {
    // Soft delete: keep row, clear body, mark deleted
    const empty = await encryptBody('');
    await d.runAsync(
      `UPDATE messages SET deleted = 1, body = ?, media_uri = NULL WHERE id = ?`,
      empty,
      id
    );
  });
}

export async function setMessageReactions(id: string, reactions: MessageReactions): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`UPDATE messages SET reactions = ? WHERE id = ?`, JSON.stringify(reactions), id);
  });
}

export async function lastMessageByChat(chatId: string): Promise<StoredMessage | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{
      id: string;
      chat_id: string;
      direction: string;
      body: string;
      created_at: number;
    }>(
      `SELECT id, chat_id, direction, body, created_at FROM messages
       WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
      chatId
    );
    if (!row) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      direction: row.direction as 'in' | 'out',
      body: await decryptBody(row.body),
      createdAt: row.created_at,
    };
  });
}

// ─── Double Ratchet State ──────────────────────────────────────────────────────

export interface StoredRatchetSession {
  aegisId: string;
  stateJson: string;
}

export async function saveRatchetSession(aegisId: string, stateJson: string): Promise<void> {
  return withDb(async (d) => {
    const encrypted = await encryptBody(stateJson);
    await d.runAsync(
      `INSERT OR REPLACE INTO ratchet_sessions (aegis_id, state_json) VALUES (?, ?)`,
      aegisId,
      encrypted
    );
  });
}

export async function loadRatchetSession(aegisId: string): Promise<string | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ state_json: string }>(
      `SELECT state_json FROM ratchet_sessions WHERE aegis_id = ?`,
      aegisId
    );
    if (!row) return null;
    return decryptBody(row.state_json);
  });
}

// ─── Groups (Fase 4) ──────────────────────────────────────────────────────────

export interface StoredGroup {
  id: string;
  name: string;
  members: string[]; // array of aegisIds
  createdAt: number;
  avatarColor?: string;
  avatarImage?: string;
  adminOnlyInvite?: boolean;
  moderateNewMembers?: boolean;
  /** aegisId of the group creator — only this peer may rename / change members. */
  adminId?: string;
  /** Detached Ed25519 signature over {groupId, groupName, members, createdAt} by adminId. */
  adminSig?: string;
  /** aegisIds with moderator role (subset of members). */
  moderators?: string[];
  /** additional admin aegisIds beyond the creator. */
  admins?: string[];
}

export async function saveGroup(g: StoredGroup): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO groups (id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig, moderators) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      g.id,
      g.name,
      JSON.stringify(g.members),
      g.createdAt,
      g.avatarColor || null,
      g.avatarImage || null,
      g.adminOnlyInvite !== false ? 1 : 0,
      g.moderateNewMembers ? 1 : 0,
      g.adminId ?? null,
      g.adminSig ?? null,
      g.moderators && g.moderators.length > 0 ? JSON.stringify(g.moderators) : null
    );
  });
}

type GroupRow = {
  id: string;
  name: string;
  members: string;
  created_at: number;
  avatar_color: string | null;
  avatar_image: string | null;
  admin_only_invite: number;
  moderate_new_members: number;
  admin_id: string | null;
  admin_sig: string | null;
  moderators: string | null;
};

function rowToGroup(r: GroupRow): StoredGroup {
  return {
    id: r.id,
    name: r.name,
    members: JSON.parse(r.members),
    createdAt: r.created_at,
    avatarColor: r.avatar_color || undefined,
    avatarImage: r.avatar_image || undefined,
    adminOnlyInvite: r.admin_only_invite === 1,
    moderateNewMembers: r.moderate_new_members === 1,
    adminId: r.admin_id ?? undefined,
    adminSig: r.admin_sig ?? undefined,
    moderators: r.moderators ? (JSON.parse(r.moderators) as string[]) : undefined,
  };
}

export async function loadGroups(): Promise<StoredGroup[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<GroupRow>(
      `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig, moderators FROM groups ORDER BY created_at DESC`
    );
    return rows.map(rowToGroup);
  });
}

export async function deleteGroup(id: string): Promise<void> {
  await withDb(async (d) => {
    await d.runAsync('DELETE FROM groups WHERE id = ?', id);
  });
  // Clean up the persistent avatar file copied on group creation (all possible extensions).
  const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    await FS.deleteAsync(
      `${FS.documentDirectory}avatars/group_${id}_avatar.${ext}`,
      { idempotent: true },
    ).catch(() => {});
  }
}

export async function getGroup(id: string): Promise<StoredGroup | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<GroupRow>(
      `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig, moderators FROM groups WHERE id = ?`,
      id
    );
    if (!row) return null;
    return rowToGroup(row);
  });
}

export async function wipeDatabase(): Promise<void> {
  return withDb(async (d) => {
    // Wipe every table that could hold identity-linked or session data.
    await d.runAsync('DELETE FROM messages');
    await d.runAsync('DELETE FROM contacts');
    await d.runAsync('DELETE FROM groups');
    await d.runAsync('DELETE FROM ratchet_sessions');
    await d.runAsync('DELETE FROM chat_state');
    await d.runAsync('DELETE FROM call_history');
    await d.runAsync('DELETE FROM polls');
    await d.runAsync('DELETE FROM scheduled_messages');
    // clearIdentity deletes SECRET_KEY_SLOT + SIGN_SECRET_KEY_SLOT and the identity table row.
    await clearIdentity();
    // SQLite DELETE only removes pages from free-list — VACUUM overwrites freed
    // pages with zeros so a forensic read of the raw database file finds nothing.
    await d.execAsync('VACUUM');
    // Also purge the at-rest DB encryption key so recovered storage cannot be decrypted.
    cachedDbKey = null;
    await SecureStore.deleteItemAsync(getDbEncKeySlot());
    // Purge X3DH prekey secrets (SPK + OPKs) from SecureStore.
    // These live outside the SQLite file; without this a forensic attacker who
    // recovers the device storage after panic could still derive past session keys.
    const slot = activeSlot;
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

    // Purge the cold-start published flag for the active slot.
    await SecureStore.deleteItemAsync(`aegis.published.${slot}`).catch(() => {});

    // Multi-slot cleanup: wipe every additional slot's DB file and SecureStore
    // keys. deleteIdentitySlot handles all key material + SQLite files for each
    // non-active slot. The active slot's data was already wiped above.
    const slotsListRaw = await SecureStore.getItemAsync('aegis.slotsList').catch(() => null);
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

    // Purge forensic remnants: panic config + user preferences.
    // Without this, a post-wipe forensic analysis could detect that a panic-enabled account existed.
    await SecureStore.deleteItemAsync('aegis.panic.v1').catch(() => {});
    await SecureStore.deleteItemAsync('aegis.preferences.v1').catch(() => {});
    await SecureStore.deleteItemAsync('aegis.polls.v1').catch(() => {});
  });
}

// ─── Chat state (draft + unread) ─────────────────────────────────────────────

export async function getChatState(chatId: string): Promise<{ draft: string | null; unreadCount: number }> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ draft: string | null; unread_count: number }>(
      'SELECT draft, unread_count FROM chat_state WHERE chat_id = ?', chatId
    );
    if (!row) return { draft: null, unreadCount: 0 };
    const decryptedDraft = row.draft ? await decryptBody(row.draft) : null;
    return { draft: decryptedDraft, unreadCount: row.unread_count };
  });
}

export async function setChatDraft(chatId: string, draft: string | null): Promise<void> {
  return withDb(async (d) => {
    const encrypted = draft ? await encryptBody(draft) : null;
    await d.runAsync(
      'INSERT OR REPLACE INTO chat_state (chat_id, draft, unread_count) VALUES (?, ?, COALESCE((SELECT unread_count FROM chat_state WHERE chat_id = ?), 0))',
      chatId, encrypted, chatId
    );
  });
}

export async function incrementUnread(chatId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET unread_count = unread_count + 1',
      chatId
    );
  });
}

export async function resetUnread(chatId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 0) ON CONFLICT(chat_id) DO UPDATE SET unread_count = 0',
      chatId
    );
  });
}

export async function deleteChatState(chatId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM chat_state WHERE chat_id = ?', chatId);
  });
}

export async function getAllUnreadCounts(): Promise<Record<string, number>> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<{ chat_id: string; unread_count: number }>(
      'SELECT chat_id, unread_count FROM chat_state WHERE unread_count > 0'
    );
    const result: Record<string, number> = {};
    for (const r of rows) result[r.chat_id] = r.unread_count;
    return result;
  });
}

// ─── Per-chat ephemeral timer ─────────────────────────────────────────────────

export async function setChatEphemeralTimer(chatId: string, seconds: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT INTO chat_state (chat_id, ephemeral_timer, unread_count)
       VALUES (?, ?, COALESCE((SELECT unread_count FROM chat_state WHERE chat_id = ?), 0))
       ON CONFLICT(chat_id) DO UPDATE SET ephemeral_timer = excluded.ephemeral_timer`,
      chatId, seconds, chatId
    );
  });
}

export async function getChatEphemeralTimer(chatId: string): Promise<number> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ ephemeral_timer: number }>(
      'SELECT ephemeral_timer FROM chat_state WHERE chat_id = ?', chatId
    );
    return row?.ephemeral_timer ?? 0;
  });
}

export async function getAllChatEphemeralTimers(): Promise<Record<string, number>> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<{ chat_id: string; ephemeral_timer: number }>(
      'SELECT chat_id, ephemeral_timer FROM chat_state WHERE ephemeral_timer > 0'
    );
    const result: Record<string, number> = {};
    for (const r of rows) result[r.chat_id] = r.ephemeral_timer;
    return result;
  });
}

// ─── Ephemeral cleanup ────────────────────────────────────────────────────────

export async function deleteExpiredMessages(_timerSeconds?: number): Promise<void> {
  return withDb(async (d) => {
    const now = Date.now();
    // Only delete messages that have an explicit expiresAt set and have passed it.
    // The global timer is no longer used — expiresAt is authoritative.
    await d.runAsync(
      'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?',
      now
    );
  });
}

// ─── Call history ─────────────────────────────────────────────────────────────

export interface StoredCall {
  id: string;
  contactId: string;
  direction: 'in' | 'out';
  media: 'audio' | 'video';
  status: 'missed' | 'answered' | 'declined';
  startedAt: number;
  durationS: number;
}

export async function saveCall(c: StoredCall): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      'INSERT OR REPLACE INTO call_history (id, contact_id, direction, media, status, started_at, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)',
      c.id, c.contactId, c.direction, c.media, c.status, c.startedAt, c.durationS
    );
  });
}

export async function getCallHistory(contactId: string, limit = 50): Promise<StoredCall[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<{
      id: string; contact_id: string; direction: string; media: string;
      status: string; started_at: number; duration_s: number;
    }>(
      'SELECT id, contact_id, direction, media, status, started_at, duration_s FROM call_history WHERE contact_id = ? ORDER BY started_at DESC LIMIT ?',
      contactId, limit
    );
    return rows.map((r) => ({
      id: r.id, contactId: r.contact_id,
      direction: r.direction as 'in' | 'out',
      media: r.media as 'audio' | 'video',
      status: r.status as 'missed' | 'answered' | 'declined',
      startedAt: r.started_at, durationS: r.duration_s,
    }));
  });
}

// ─── Polls ────────────────────────────────────────────────────────────────────

export interface StoredPoll {
  id: string;
  question: string;
  options: string[];
  votes: number[];
  createdAt: number;
  groupId: string;
}

type PollRow = {
  id: string;
  question: string;
  options: string;
  votes: string;
  created_at: number;
  group_id: string;
};

function rowToPoll(r: PollRow): StoredPoll {
  return {
    id: r.id,
    question: r.question,
    options: JSON.parse(r.options) as string[],
    votes: JSON.parse(r.votes) as number[],
    createdAt: r.created_at,
    groupId: r.group_id,
  };
}

export async function savePoll(p: StoredPoll): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO polls (id, question, options, votes, created_at, group_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
      p.id,
      p.question,
      JSON.stringify(p.options),
      JSON.stringify(p.votes),
      p.createdAt,
      p.groupId
    );
  });
}

export async function loadPolls(): Promise<StoredPoll[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<PollRow>(
      'SELECT id, question, options, votes, created_at, group_id FROM polls ORDER BY created_at DESC'
    );
    return rows.map(rowToPoll);
  });
}

export async function updatePollVotes(id: string, votes: number[]): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE polls SET votes = ? WHERE id = ?', JSON.stringify(votes), id);
  });
}

// ─── Scheduled Messages ───────────────────────────────────────────────────────

export interface StoredScheduledMessage {
  id: string;
  recipientAegisId: string;
  /** SealedEnvelope JSON — already E2EE ciphertext, plaintext NEVER stored */
  encryptedPayload: string;
  sendAt: number;
  createdAt: number;
  status: 'pending' | 'sent' | 'failed';
  retryCount: number;
}

type ScheduledRow = {
  id: string;
  recipient_aegis_id: string;
  encrypted_payload: string;
  send_at: number;
  created_at: number;
  status: string;
  retry_count: number;
};

function rowToScheduled(r: ScheduledRow): StoredScheduledMessage {
  return {
    id: r.id,
    recipientAegisId: r.recipient_aegis_id,
    encryptedPayload: r.encrypted_payload,
    sendAt: r.send_at,
    createdAt: r.created_at,
    status: r.status as 'pending' | 'sent' | 'failed',
    retryCount: r.retry_count,
  };
}

export async function saveScheduled(msg: StoredScheduledMessage): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO scheduled_messages
       (id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      msg.id,
      msg.recipientAegisId,
      msg.encryptedPayload,
      msg.sendAt,
      msg.createdAt,
      msg.status,
      msg.retryCount,
    );
  });
}

export async function loadPendingScheduled(): Promise<StoredScheduledMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<ScheduledRow>(
      `SELECT id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count
       FROM scheduled_messages WHERE status = 'pending' ORDER BY send_at ASC`,
    );
    return rows.map(rowToScheduled);
  });
}

export async function loadAllScheduled(): Promise<StoredScheduledMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<ScheduledRow>(
      `SELECT id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count
       FROM scheduled_messages ORDER BY send_at ASC`,
    );
    return rows.map(rowToScheduled);
  });
}

export async function markScheduledSent(id: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`UPDATE scheduled_messages SET status = 'sent' WHERE id = ?`, id);
  });
}

export async function markScheduledFailed(id: string, retryCount: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `UPDATE scheduled_messages SET status = 'failed', retry_count = ? WHERE id = ?`,
      retryCount,
      id,
    );
  });
}

export async function incrementScheduledRetry(id: string, retryCount: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `UPDATE scheduled_messages SET retry_count = ? WHERE id = ?`,
      retryCount,
      id,
    );
  });
}

export async function deleteScheduled(id: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`DELETE FROM scheduled_messages WHERE id = ?`, id);
  });
}

// ─── Persistent Outbox (Signal-style reliable delivery) ───────────────────────
//
// The outbox holds one job per (message, recipient) pair. The payload is the
// plaintext JSON object that will be ratchet-encrypted at drain time — we NEVER
// persist a pre-encrypted envelope so the Double Ratchet always advances
// monotonically. The payload is stored encrypted at rest via encryptBody
// (same key as message bodies) so plaintext never lands on disk unprotected.
//
// FIFO drain order is preserved by loading jobs sorted by created_at ASC and
// draining them in series (await each before the next).

export interface OutboxJob {
  jobId: string;
  msgId: string;
  recipientAegisId: string;
  recipientPubkeyB64: string;
  /** Decrypted payload JSON string — ratchet-encrypt this at drain time. */
  payload: string;
  kind: 'direct' | 'group';
  groupId: string | null;
  createdAt: number;
  attempts: number;
}

type OutboxRow = {
  job_id: string;
  msg_id: string;
  recipient_aegis_id: string;
  recipient_pubkey_b64: string;
  payload: string; // encrypted at rest
  kind: string;
  group_id: string | null;
  created_at: number;
  attempts: number;
};

async function rowToOutboxJob(r: OutboxRow): Promise<OutboxJob> {
  return {
    jobId: r.job_id,
    msgId: r.msg_id,
    recipientAegisId: r.recipient_aegis_id,
    recipientPubkeyB64: r.recipient_pubkey_b64,
    payload: await decryptBody(r.payload),
    kind: r.kind as 'direct' | 'group',
    groupId: r.group_id,
    createdAt: r.created_at,
    attempts: r.attempts,
  };
}

export async function enqueueOutboxJob(job: Omit<OutboxJob, 'attempts'>): Promise<void> {
  return withDb(async (d) => {
    const encryptedPayload = await encryptBody(job.payload);
    await d.runAsync(
      `INSERT OR REPLACE INTO outbox
         (job_id, msg_id, recipient_aegis_id, recipient_pubkey_b64, payload, kind, group_id, created_at, attempts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      job.jobId,
      job.msgId,
      job.recipientAegisId,
      job.recipientPubkeyB64,
      encryptedPayload,
      job.kind,
      job.groupId ?? null,
      job.createdAt,
    );
  });
}

export async function loadOutboxJobs(): Promise<OutboxJob[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<OutboxRow>(
      `SELECT job_id, msg_id, recipient_aegis_id, recipient_pubkey_b64, payload, kind, group_id, created_at, attempts
       FROM outbox ORDER BY created_at ASC`,
    );
    return Promise.all(rows.map(rowToOutboxJob));
  });
}

export async function deleteOutboxJob(jobId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM outbox WHERE job_id = ?', jobId);
  });
}

export async function incrementOutboxAttempts(jobId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE outbox SET attempts = attempts + 1 WHERE job_id = ?', jobId);
  });
}

export async function countOutboxJobs(): Promise<number> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM outbox');
    return row?.n ?? 0;
  });
}
