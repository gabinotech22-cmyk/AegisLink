import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import { ss } from '../utils/secureStore';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { secretKeySlot, signSecretKeySlot, dbEncKeySlot } from '../crypto/types';
import type { GroupPermissions } from '../crypto/groupSig';

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

    -- E2EE group chats — Sender Keys (Fase 4)
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
      moderators            TEXT,
      roster_version        INTEGER,
      permissions           TEXT,
      gov_sig               TEXT,
      gov_version           INTEGER,
      pending               INTEGER
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

    -- Scheduled messages: ciphertext stored, plaintext never on disk.
    -- 1:1 rows: encrypted_payload = pre-ratcheted wire envelope, group_id NULL.
    -- Group rows: group_id set, recipient_aegis_id = group_id, encrypted_payload =
    -- encryptBody(plaintext) — encrypted at fire time via sendGroupMessage so the
    -- fan-out always uses fresh membership and a fresh admin signature.
    -- post_meta: encryptBody(JSON GroupPostOptions) — publish-as, pin, notify,
    -- replies, weekly repeat, staged image path/name. Group rows only.
    CREATE TABLE IF NOT EXISTS scheduled_messages (
      id                TEXT PRIMARY KEY,
      recipient_aegis_id TEXT NOT NULL,
      encrypted_payload TEXT NOT NULL,
      send_at           INTEGER NOT NULL,
      created_at        INTEGER NOT NULL,
      status            TEXT NOT NULL DEFAULT 'pending',
      retry_count       INTEGER NOT NULL DEFAULT 0,
      group_id          TEXT,
      post_meta         TEXT
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

    -- X3DH prekey SECRETS (durable, encrypted-at-rest primary store).
    -- ROOT-CAUSE FIX: previously SPK/OPK private keys lived ONLY in SecureStore
    -- (Android Keystore). Bulk writes (~104 items per refill) can silently fail
    -- on some emulators/devices; the public SPK was still published, leaving the
    -- recipient with a prekey whose secret it cannot read → permanent X3DH
    -- "no-spk" abort. Persisting the secrets here (Signal/Threema style: private
    -- keys in durable local storage) makes the upload's "never publish a SPK we
    -- can't read back" invariant enforceable. secret_b64 is stored via encryptBody.
    --   kind: 'spk' | 'opk'  — key_id is the X3DH keyId.
    CREATE TABLE IF NOT EXISTS prekey_secrets (
      slot       TEXT NOT NULL,
      kind       TEXT NOT NULL,
      key_id     INTEGER NOT NULL,
      secret_b64 TEXT NOT NULL,
      PRIMARY KEY (slot, kind, key_id)
    );
  `);

  // ─── Schema versioning via PRAGMA user_version ──────────────────────────
  // Bump USER_DB_VERSION whenever a migration must run on existing installs.
  const USER_DB_VERSION = 10;
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

  if (currentVersion < 6) {
    // v5 → v6: add prekey_secrets table (durable X3DH SPK/OPK secret store).
    // The CREATE TABLE IF NOT EXISTS above already handles fresh installs and
    // existing upgrades; the table starts empty and is populated on the next
    // uploadPreKeys() refill. No data migration of legacy SecureStore secrets is
    // required — new sessions from that point on derive correctly.
    await d.execAsync('PRAGMA user_version = 6');
  }

  if (currentVersion < 7) {
    // v6 → v7: add group_id + post_meta to scheduled_messages (scheduled group
    // posts). Fresh installs already have the columns via CREATE TABLE above.
    try { await d.execAsync('ALTER TABLE scheduled_messages ADD COLUMN group_id TEXT;'); } catch {}
    try { await d.execAsync('ALTER TABLE scheduled_messages ADD COLUMN post_meta TEXT;'); } catch {}
    await d.execAsync('PRAGMA user_version = 7');
  }

  if (currentVersion < 8) {
    // v7 → v8: add roster_version to groups (monotonic counter for the
    // by-reference roster of large groups — aegis.group.v2). Fresh installs
    // already have the column via CREATE TABLE above. NULL means "legacy /
    // unset" and is treated as version 1 by readers.
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN roster_version INTEGER;'); } catch {}
    await d.execAsync('PRAGMA user_version = 8');
  }

  if (currentVersion < 9) {
    // v8 → v9: add governance columns to groups (roles + permissions layer,
    // aegis.group.gov.v1). permissions = JSON GroupPermissions, gov_sig =
    // owner's detached signature over the governance state, gov_version =
    // monotonic anti-rollback counter. Fresh installs already have the columns
    // via CREATE TABLE above. All NULL on existing rows → readers fall back to
    // DEFAULT_PERMISSIONS and treat gov_version as 1, so legacy groups keep
    // working with creator=owner and default gates (no data migration needed).
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN permissions TEXT;'); } catch {}
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN gov_sig TEXT;'); } catch {}
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN gov_version INTEGER;'); } catch {}
    await d.execAsync('PRAGMA user_version = 9');
  }

  if (currentVersion < 10) {
    // v9 → v10: add pending flag to groups (unaccepted group invitations, see
    // requireGroupApproval). Fresh installs already have the column via CREATE
    // TABLE above. NULL on existing rows → treated as not pending (joined).
    try { await d.execAsync('ALTER TABLE groups ADD COLUMN pending INTEGER;'); } catch {}
    await d.execAsync('PRAGMA user_version = 10');
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
  // `hidden` = chat removed from the list but contact kept (reappears on next
  // message). Distinct from `archived` (moved to the archived section).
  try { await d.execAsync('ALTER TABLE contacts ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
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
  try { await d.execAsync('ALTER TABLE messages ADD COLUMN attachments TEXT;'); } catch (e) {}
  try { await d.execAsync('ALTER TABLE chat_state ADD COLUMN ephemeral_timer INTEGER NOT NULL DEFAULT 0;'); } catch (e) {}
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
       DELETE FROM call_history;
       DELETE FROM prekey_secrets;`
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
  /** Chat removed from the list but contact kept; reappears on next message. */
  hidden?: boolean;
}

export async function saveContact(c: StoredContact): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO contacts
       (aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      c.online ? 1 : 0,
      c.hidden ? 1 : 0
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
  hidden: number;
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
    hidden: r.hidden === 1,
  };
}

export async function loadContacts(profile?: 'personal' | 'work'): Promise<StoredContact[]> {
  return withDb(async (d) => {
    const rows = profile
      ? await d.getAllAsync<ContactRow>(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden FROM contacts WHERE profile = ? ORDER BY added_at DESC`,
          profile
        )
      : await d.getAllAsync<ContactRow>(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden FROM contacts ORDER BY added_at DESC`
        );
    return rows.map(rowToContact);
  });
}

export async function getContact(aegisId: string): Promise<StoredContact | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<ContactRow>(
      `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online, hidden FROM contacts WHERE aegis_id = ?`,
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
 * decrypt" state. NOT for key material — use {@link decryptSecret} /
 * {@link decryptSecretOrNull} for ratchet state, prekey secrets, etc.
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

// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'poll' | 'location' | 'view_once';

export interface MessageReactions {
  [emoji: string]: string[]; // emoji -> list of aegisIds who reacted
}

export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file';
  uri: string;          // blob:id:key:nonce or local path during send
  fileName?: string;    // for files
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;    // for video/audio in seconds
  caption?: string;     // per-attachment caption (optional)
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
  attachments?: Attachment[] | null;
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
  attachments: string | null;
}

async function rowToMessage(r: MessageRow, body: string): Promise<StoredMessage> {
  let reactions: MessageReactions | undefined;
  if (r.reactions) {
    try { reactions = JSON.parse(r.reactions); } catch { /* ignore */ }
  }
  let attachments: Attachment[] | null = null;
  if (r.attachments) {
    try { attachments = JSON.parse(r.attachments); } catch { /* ignore */ }
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
    attachments,
  };
}

export async function saveMessage(m: StoredMessage): Promise<void> {
  return withDb(async (d) => {
    const encrypted = await encryptBody(m.body);
    const encryptedMediaUri = m.mediaUri ? await encryptBody(m.mediaUri) : null;
    await d.runAsync(
      `INSERT OR REPLACE INTO messages
       (id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      m.expiresAt ?? null,
      m.attachments ? JSON.stringify(m.attachments) : null
    );
  });
}

export async function updateMessageDelivery(id: string, status: 'sent' | 'delivered' | 'read'): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET delivery_status = ? WHERE id = ?', status, id);
  });
}

/** Update a message's attachments array in place (JSON-serialized). */
export async function updateMessageAttachments(id: string, attachments: Attachment[]): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET attachments = ? WHERE id = ?', JSON.stringify(attachments), id);
  });
}

/** Update a message's media reference (stored encrypted, like saveMessage). */
export async function updateMessageMediaUri(id: string, mediaUri: string): Promise<void> {
  const encryptedMediaUri = await encryptBody(mediaUri);
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET media_uri = ? WHERE id = ?', encryptedMediaUri, id);
  });
}

export async function loadMessagesByChat(chatId: string): Promise<StoredMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<MessageRow>(
      `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at, attachments
       FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
      chatId
    );
    return Promise.all(rows.map(async (r) => await rowToMessage(r, await decryptBody(r.body))));
  });
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<MessageRow>(
      `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at, attachments
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
      `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at, attachments
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
    // Fail closed: if the stored ratchet state cannot be decrypted, return null
    // so the caller re-establishes a fresh session rather than proceeding with a
    // sentinel string that would parse into garbage key material (golden rule #1).
    return decryptSecretOrNull(row.state_json);
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
  /**
   * Monotonic roster counter for the by-reference roster of large groups
   * (aegis.group.v2). Bumped on every membership change. Used by receivers to
   * decide whether a v2-content message carries a fresher or staler roster than
   * the locally-trusted one. Undefined on legacy rows → treated as 1.
   */
  rosterVersion?: number;
  /**
   * Configurable per-group permission gates (who can invite/send/call/edit).
   * Undefined → treat as DEFAULT_PERMISSIONS (see crypto/groupRoles.ts). Covered
   * by govSig so a member cannot forge them.
   */
  permissions?: GroupPermissions;
  /**
   * Detached Ed25519 signature by adminId over the governance state
   * (roles + permissions + govVersion) — see canonicalGroupGovBytes. Additive
   * and independent of adminSig; absent on legacy/pre-governance groups.
   */
  govSig?: string;
  /**
   * Monotonic governance counter, bumped on every role/permission change.
   * Defeats rollback of a signed governance state. Undefined → treated as 1.
   */
  govVersion?: number;
  /**
   * True while this group is an unaccepted invitation (the local user was added
   * but their privacy setting requires approval — see requireGroupApproval).
   * Pending groups are hidden from the active list and render no messages until
   * accepted. Undefined/false = a normal, joined group.
   */
  pending?: boolean;
}

export async function saveGroup(g: StoredGroup): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO groups (id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig, moderators, roster_version, permissions, gov_sig, gov_version, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      g.moderators && g.moderators.length > 0 ? JSON.stringify(g.moderators) : null,
      g.rosterVersion ?? null,
      g.permissions ? JSON.stringify(g.permissions) : null,
      g.govSig ?? null,
      g.govVersion ?? null,
      g.pending ? 1 : null
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
  roster_version: number | null;
  permissions: string | null;
  gov_sig: string | null;
  gov_version: number | null;
  pending: number | null;
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
    rosterVersion: r.roster_version ?? undefined,
    permissions: r.permissions ? (JSON.parse(r.permissions) as GroupPermissions) : undefined,
    govSig: r.gov_sig ?? undefined,
    govVersion: r.gov_version ?? undefined,
    pending: r.pending === 1 ? true : undefined,
  };
}

export async function loadGroups(): Promise<StoredGroup[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<GroupRow>(
      `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig, moderators, roster_version, permissions, gov_sig, gov_version, pending FROM groups ORDER BY created_at DESC`
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
      `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig, moderators, roster_version, permissions, gov_sig, gov_version, pending FROM groups WHERE id = ?`,
      id
    );
    if (!row) return null;
    return rowToGroup(row);
  });
}

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
  /** 1:1: the contact's aegisId. Group posts: the groupId (mirrors group_id). */
  recipientAegisId: string;
  /**
   * 1:1: SealedEnvelope JSON — already E2EE ciphertext, plaintext NEVER stored.
   * Group: encryptBody(plaintext) — at-rest encrypted, ratcheted at fire time
   * via sendGroupMessage so membership and admin signature are always fresh.
   */
  encryptedPayload: string;
  sendAt: number;
  createdAt: number;
  /** 'draft' is group-posts only: kept locally, never fired by processDue. */
  status: 'pending' | 'sent' | 'failed' | 'draft';
  retryCount: number;
  /** Set only for scheduled group posts. */
  groupId?: string;
  /** encryptBody(JSON GroupPostOptions) — group posts only. */
  postMeta?: string;
}

type ScheduledRow = {
  id: string;
  recipient_aegis_id: string;
  encrypted_payload: string;
  send_at: number;
  created_at: number;
  status: string;
  retry_count: number;
  group_id: string | null;
  post_meta: string | null;
};

function rowToScheduled(r: ScheduledRow): StoredScheduledMessage {
  return {
    id: r.id,
    recipientAegisId: r.recipient_aegis_id,
    encryptedPayload: r.encrypted_payload,
    sendAt: r.send_at,
    createdAt: r.created_at,
    status: r.status as 'pending' | 'sent' | 'failed' | 'draft',
    retryCount: r.retry_count,
    groupId: r.group_id ?? undefined,
    postMeta: r.post_meta ?? undefined,
  };
}

export async function saveScheduled(msg: StoredScheduledMessage): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO scheduled_messages
       (id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count, group_id, post_meta)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.id,
      msg.recipientAegisId,
      msg.encryptedPayload,
      msg.sendAt,
      msg.createdAt,
      msg.status,
      msg.retryCount,
      msg.groupId ?? null,
      msg.postMeta ?? null,
    );
  });
}

export async function loadPendingScheduled(): Promise<StoredScheduledMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<ScheduledRow>(
      `SELECT id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count, group_id, post_meta
       FROM scheduled_messages WHERE status = 'pending' ORDER BY send_at ASC`,
    );
    return rows.map(rowToScheduled);
  });
}

export async function loadAllScheduled(): Promise<StoredScheduledMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<ScheduledRow>(
      `SELECT id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count, group_id, post_meta
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

/** Persist (or replace) the SPK secret for a keyId. b64 is the raw 32-byte X25519 secret, base64. */
export async function saveSpkSecret(keyId: number, b64: string): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(b64);
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'spk', ?, ?)`,
      activeSlot, keyId, enc,
    );
  });
}

/** Load the SPK secret (base64) for a specific keyId, or null if absent. */
export async function loadSpkSecret(keyId: number): Promise<string | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'spk' AND key_id = ?`,
      activeSlot, keyId,
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
      activeSlot,
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
      activeSlot, keyId,
    );
  });
}

/** Persist (or replace) a one-time prekey secret for a keyId. */
export async function saveOpkSecret(keyId: number, b64: string): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(b64);
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'opk', ?, ?)`,
      activeSlot, keyId, enc,
    );
  });
}

/** Load a one-time prekey secret (base64) by keyId, or null if absent/consumed. */
export async function loadOpkSecret(keyId: number): Promise<string | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'opk' AND key_id = ?`,
      activeSlot, keyId,
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
      activeSlot,
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
      activeSlot, keyId,
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
      activeSlot, enc,
    );
  });
}

/** Read the current SPK keyId, or null if never set. */
export async function getSpkKeyId(): Promise<number | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'spkmeta' AND key_id = 0`,
      activeSlot,
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
      activeSlot, enc,
    );
  });
}

/** Read the current SPK's creation ms, or null if never stamped (pre-B-3 install). */
export async function getSpkCreatedAt(): Promise<number | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'spkcreated' AND key_id = 0`,
      activeSlot,
    );
    if (!row) return null;
    const v = parseInt((await decryptSecretOrNull(row.secret_b64)) ?? '', 10);
    return Number.isFinite(v) ? v : null;
  });
}

/** Delete every prekey secret for the active slot (panic wipe / slot delete). */
export async function clearPrekeySecrets(): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM prekey_secrets WHERE slot = ?', activeSlot);
  });
}

// ─── PQXDH: ML-KEM-768 signed PQ prekey (PQSPK) secrets ──────────────────────
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

/** Persist (or replace) the ML-KEM-768 PQSPK secret (base64) for a keyId. */
export async function savePqSpkSecret(keyId: number, b64: string): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(b64);
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'pqspk', ?, ?)`,
      activeSlot, keyId, enc,
    );
  });
}

/** Load the ML-KEM-768 PQSPK secret (base64) for a specific keyId, or null. */
export async function loadPqSpkSecret(keyId: number): Promise<string | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'pqspk' AND key_id = ?`,
      activeSlot, keyId,
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
      activeSlot, keyId,
    );
  });
}

/** Persist the current PQSPK keyId (sentinel row, mirrors setSpkKeyId). */
export async function setPqSpkKeyId(n: number): Promise<void> {
  return withDb(async (d) => {
    const enc = await encryptBody(String(n));
    await d.runAsync(
      `INSERT OR REPLACE INTO prekey_secrets (slot, kind, key_id, secret_b64) VALUES (?, 'pqspkmeta', 0, ?)`,
      activeSlot, enc,
    );
  });
}

/** Read the current PQSPK keyId, or null if never set. */
export async function getPqSpkKeyId(): Promise<number | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ secret_b64: string }>(
      `SELECT secret_b64 FROM prekey_secrets WHERE slot = ? AND kind = 'pqspkmeta' AND key_id = 0`,
      activeSlot,
    );
    if (!row) return null;
    const v = parseInt((await decryptSecretOrNull(row.secret_b64)) ?? '', 10);
    return Number.isFinite(v) ? v : null;
  });
}
