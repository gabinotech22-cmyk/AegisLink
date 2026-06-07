/**
 * AegisLink — Database client
 *
 * Selects backend based on DATABASE_URL:
 *   - postgres://...  → PostgreSQL via `pg` (production)
 *   - anything else   → SQLite via node:sqlite (development / default)
 *
 * All exported repo methods are async so callers work identically
 * regardless of which backend is active.
 */

// ── Backend detection ─────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL ?? '';
const USE_PG = DATABASE_URL.startsWith('postgres://') || DATABASE_URL.startsWith('postgresql://');

// ── SQLite backend ────────────────────────────────────────────────────────────

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// Lazily-imported DatabaseSync class (ESM-safe: we import at module level but
// only construct when needed, which is fine since node:sqlite is always available
// in Node 22).
import { DatabaseSync } from 'node:sqlite';

let sqlite: DatabaseSync | null = null;

function getSqlite(): DatabaseSync {
  if (sqlite) return sqlite;
  const DB_PATH = process.env.AEGIS_DB_PATH ?? './data/aegislink.db';
  mkdirSync(dirname(DB_PATH), { recursive: true });
  sqlite = new DatabaseSync(DB_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  initSqliteSchema(sqlite);
  return sqlite;
}

function initSqliteSchema(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS identities (
      aegis_id                TEXT PRIMARY KEY,
      public_key_b64          TEXT NOT NULL,
      signing_public_key_b64  TEXT NOT NULL DEFAULT '',
      created_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      recipient      TEXT NOT NULL,
      ciphertext_b64 TEXT NOT NULL,
      nonce_b64      TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      expires_at     INTEGER NOT NULL DEFAULT 0,
      drained_by     TEXT NOT NULL DEFAULT '[]',
      sender_pub_b64 TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_recipient
      ON messages(recipient, created_at);

    CREATE TABLE IF NOT EXISTS push_tokens (
      aegis_id    TEXT NOT NULL,
      expo_token  TEXT NOT NULL,
      platform    TEXT NOT NULL,
      updated_at  INTEGER NOT NULL,
      PRIMARY KEY (aegis_id, expo_token)
    );

    CREATE TABLE IF NOT EXISTS prekeys_signed (
      aegis_id       TEXT NOT NULL,
      device_id      TEXT NOT NULL DEFAULT 'default',
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      signature_b64  TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (aegis_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS prekeys_onetime (
      aegis_id       TEXT NOT NULL,
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (aegis_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS revoked_did_hashes (
      did_hash        TEXT PRIMARY KEY,
      revoked_at      INTEGER NOT NULL,
      signature_b64   TEXT NOT NULL,
      signing_pub_key TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lightning_invoices (
      payment_hash  TEXT PRIMARY KEY,
      bolt11        TEXT NOT NULL,
      amount_sats   INTEGER NOT NULL,
      plan_days     INTEGER NOT NULL,
      created_at    INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL,
      paid          INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      payment_hash  TEXT PRIMARY KEY,
      plan_days     INTEGER NOT NULL,
      activated_at  INTEGER NOT NULL,
      expires_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS linked_devices (
      device_id      TEXT PRIMARY KEY,
      aegis_id       TEXT NOT NULL,
      device_pub_key TEXT NOT NULL,
      device_name    TEXT NOT NULL DEFAULT 'AegisLink Desktop',
      platform       TEXT NOT NULL DEFAULT 'desktop',
      linked_at      INTEGER NOT NULL,
      revoked        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_linked_devices_aegis
      ON linked_devices(aegis_id, revoked);

    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id      TEXT NOT NULL,
      voter_hash   TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      PRIMARY KEY (poll_id, voter_hash)
    );

    CREATE TABLE IF NOT EXISTS backups (
      id_hash    TEXT PRIMARY KEY,
      envelope   TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_orgs (
      org_id     TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      admin_id   TEXT NOT NULL,
      policy_key_rotation_days INTEGER NOT NULL DEFAULT 90,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_members (
      org_id    TEXT NOT NULL,
      aegis_id  TEXT NOT NULL,
      team      TEXT NOT NULL DEFAULT 'General',
      role      TEXT NOT NULL DEFAULT 'member',
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (org_id, aegis_id)
    );

    CREATE TABLE IF NOT EXISTS work_devices (
      device_id  TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      aegis_id   TEXT NOT NULL,
      name       TEXT NOT NULL,
      platform   TEXT NOT NULL DEFAULT 'mobile',
      status     TEXT NOT NULL DEFAULT 'pending',
      last_seen  INTEGER NOT NULL,
      enrolled_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_devices_org ON work_devices(org_id, status);

    CREATE TABLE IF NOT EXISTS work_audit_log (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      actor_id   TEXT,
      target_id  TEXT,
      channel_id TEXT,
      metadata   TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_audit_org ON work_audit_log(org_id, created_at DESC);

    CREATE TRIGGER IF NOT EXISTS audit_log_no_update
      BEFORE UPDATE ON work_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log_immutable');
    END;

    CREATE TRIGGER IF NOT EXISTS audit_log_no_delete
      BEFORE DELETE ON work_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'audit_log_immutable');
    END;

    CREATE TABLE IF NOT EXISTS work_invite_tokens (
      token      TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      team       TEXT NOT NULL DEFAULT 'General',
      role       TEXT NOT NULL DEFAULT 'member',
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name_enc   TEXT NOT NULL,
      admin_id   TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      aegis_id     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',
      joined_at    INTEGER NOT NULL,
      PRIMARY KEY (workspace_id, aegis_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_members_ws
      ON workspace_members(workspace_id);

    CREATE TABLE IF NOT EXISTS work_channels (
      channel_id        TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      name              TEXT NOT NULL,
      is_announcements  INTEGER NOT NULL DEFAULT 0,
      created_at        INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_channels_org ON work_channels(org_id);

    CREATE TABLE IF NOT EXISTS work_messages (
      id          TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      sender_id   TEXT NOT NULL,
      body        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'text',
      created_at  INTEGER NOT NULL,
      is_pinned   INTEGER NOT NULL DEFAULT 0,
      pinned_by   TEXT,
      pinned_at   TEXT,
      parent_id   TEXT,
      reply_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_work_messages_channel
      ON work_messages(channel_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_work_messages_parent
      ON work_messages(parent_id, created_at);

    CREATE TABLE IF NOT EXISTS work_attachments (
      id           TEXT PRIMARY KEY,
      message_id   TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      org_id       TEXT NOT NULL,
      blob_id      TEXT NOT NULL,
      filename     TEXT NOT NULL,
      mime_type    TEXT NOT NULL,
      size_bytes   INTEGER NOT NULL,
      uploaded_by  TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_attachments_channel
      ON work_attachments(channel_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_work_attachments_message
      ON work_attachments(message_id);

    CREATE TABLE IF NOT EXISTS work_channel_permissions (
      channel_id  TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      role        TEXT NOT NULL,
      can_send    INTEGER NOT NULL DEFAULT 1,
      can_react   INTEGER NOT NULL DEFAULT 1,
      can_upload  INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (channel_id, role)
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS work_messages_fts USING fts5(
      id UNINDEXED,
      body,
      sender_id UNINDEXED,
      channel_id UNINDEXED,
      org_id UNINDEXED,
      content='work_messages',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS work_messages_ai AFTER INSERT ON work_messages BEGIN
      INSERT INTO work_messages_fts(rowid, id, body, sender_id, channel_id, org_id)
      VALUES (new.rowid, new.id, new.body, new.sender_id, new.channel_id, new.org_id);
    END;

    CREATE TRIGGER IF NOT EXISTS work_messages_ad AFTER DELETE ON work_messages BEGIN
      INSERT INTO work_messages_fts(work_messages_fts, rowid, id, body, sender_id, channel_id, org_id)
      VALUES('delete', old.rowid, old.id, old.body, old.sender_id, old.channel_id, old.org_id);
    END;

    CREATE TRIGGER IF NOT EXISTS work_messages_au AFTER UPDATE ON work_messages BEGIN
      INSERT INTO work_messages_fts(work_messages_fts, rowid, id, body, sender_id, channel_id, org_id)
      VALUES('delete', old.rowid, old.id, old.body, old.sender_id, old.channel_id, old.org_id);
      INSERT INTO work_messages_fts(rowid, id, body, sender_id, channel_id, org_id)
      VALUES (new.rowid, new.id, new.body, new.sender_id, new.channel_id, new.org_id);
    END;
  `);

  // Schema migrations for existing deployments
  try { db.exec(`ALTER TABLE identities ADD COLUMN signing_public_key_b64 TEXT NOT NULL DEFAULT '';`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages DROP COLUMN sender;`); } catch { /* absent */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN drained_by TEXT NOT NULL DEFAULT '[]';`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN sender_pub_b64 TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE prekeys_signed ADD COLUMN device_id TEXT NOT NULL DEFAULT 'default';`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN pinned_by TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN pinned_at TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN parent_id TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_orgs ADD COLUMN display_name TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_orgs ADD COLUMN invite_policy TEXT NOT NULL DEFAULT 'invite_only';`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_channels ADD COLUMN retention_days INTEGER;`); } catch { /* exists */ }
  // work_audit_log extended columns — migration guards for existing deployments
  try { db.exec(`ALTER TABLE work_audit_log ADD COLUMN actor_id TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_audit_log ADD COLUMN target_id TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_audit_log ADD COLUMN channel_id TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_audit_log ADD COLUMN metadata TEXT;`); } catch { /* exists */ }
  try { db.exec(`CREATE INDEX IF NOT EXISTS idx_work_audit_actor ON work_audit_log(org_id, actor_id, created_at DESC);`); } catch { /* exists */ }

  // Backup table — migration guard for existing deployments
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS backups (
      id_hash    TEXT PRIMARY KEY,
      envelope   TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );`);
  } catch { /* exists */ }

  // Channel-level permission table — migration guard for existing deployments
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS work_channel_permissions (
      channel_id  TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      role        TEXT NOT NULL,
      can_send    INTEGER NOT NULL DEFAULT 1,
      can_react   INTEGER NOT NULL DEFAULT 1,
      can_upload  INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (channel_id, role)
    );`);
  } catch { /* exists */ }
}

// ── PostgreSQL backend ────────────────────────────────────────────────────────

import pg from 'pg';
const { Pool } = pg;

let pgPool: pg.Pool | null = null;

function getPool(): pg.Pool {
  if (pgPool) return pgPool;
  pgPool = new Pool({ connectionString: DATABASE_URL });
  return pgPool;
}

async function initPgSchema(): Promise<void> {
  const pool = getPool();
  await pool.query(`
    CREATE TABLE IF NOT EXISTS identities (
      aegis_id                TEXT PRIMARY KEY,
      public_key_b64          TEXT NOT NULL,
      signing_public_key_b64  TEXT NOT NULL DEFAULT '',
      created_at              BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      recipient      TEXT NOT NULL,
      ciphertext_b64 TEXT NOT NULL,
      nonce_b64      TEXT NOT NULL,
      created_at     BIGINT NOT NULL,
      expires_at     BIGINT NOT NULL DEFAULT 0,
      drained_by     TEXT NOT NULL DEFAULT '[]',
      sender_pub_b64 TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_messages_recipient
      ON messages(recipient, created_at);

    CREATE TABLE IF NOT EXISTS push_tokens (
      aegis_id    TEXT NOT NULL,
      expo_token  TEXT NOT NULL,
      platform    TEXT NOT NULL,
      updated_at  BIGINT NOT NULL,
      PRIMARY KEY (aegis_id, expo_token)
    );

    CREATE TABLE IF NOT EXISTS prekeys_signed (
      aegis_id       TEXT NOT NULL,
      device_id      TEXT NOT NULL DEFAULT 'default',
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      signature_b64  TEXT NOT NULL,
      created_at     BIGINT NOT NULL,
      PRIMARY KEY (aegis_id, device_id)
    );

    CREATE TABLE IF NOT EXISTS prekeys_onetime (
      aegis_id       TEXT NOT NULL,
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      created_at     BIGINT NOT NULL,
      PRIMARY KEY (aegis_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS revoked_did_hashes (
      did_hash        TEXT PRIMARY KEY,
      revoked_at      BIGINT NOT NULL,
      signature_b64   TEXT NOT NULL,
      signing_pub_key TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS lightning_invoices (
      payment_hash  TEXT PRIMARY KEY,
      bolt11        TEXT NOT NULL,
      amount_sats   BIGINT NOT NULL,
      plan_days     INTEGER NOT NULL,
      created_at    BIGINT NOT NULL,
      expires_at    BIGINT NOT NULL,
      paid          INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS subscriptions (
      payment_hash  TEXT PRIMARY KEY,
      plan_days     INTEGER NOT NULL,
      activated_at  BIGINT NOT NULL,
      expires_at    BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS linked_devices (
      device_id      TEXT PRIMARY KEY,
      aegis_id       TEXT NOT NULL,
      device_pub_key TEXT NOT NULL,
      device_name    TEXT NOT NULL DEFAULT 'AegisLink Desktop',
      platform       TEXT NOT NULL DEFAULT 'desktop',
      linked_at      BIGINT NOT NULL,
      revoked        INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_linked_devices_aegis
      ON linked_devices(aegis_id, revoked);

    CREATE TABLE IF NOT EXISTS poll_votes (
      poll_id      TEXT NOT NULL,
      voter_hash   TEXT NOT NULL,
      option_index INTEGER NOT NULL,
      PRIMARY KEY (poll_id, voter_hash)
    );

    CREATE TABLE IF NOT EXISTS backups (
      id_hash    TEXT PRIMARY KEY,
      envelope   TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_orgs (
      org_id     TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      admin_id   TEXT NOT NULL,
      policy_key_rotation_days INTEGER NOT NULL DEFAULT 90,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS work_members (
      org_id    TEXT NOT NULL,
      aegis_id  TEXT NOT NULL,
      team      TEXT NOT NULL DEFAULT 'General',
      role      TEXT NOT NULL DEFAULT 'member',
      joined_at BIGINT NOT NULL,
      PRIMARY KEY (org_id, aegis_id)
    );

    CREATE TABLE IF NOT EXISTS work_devices (
      device_id  TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      aegis_id   TEXT NOT NULL,
      name       TEXT NOT NULL,
      platform   TEXT NOT NULL DEFAULT 'mobile',
      status     TEXT NOT NULL DEFAULT 'pending',
      last_seen  BIGINT NOT NULL,
      enrolled_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_devices_org ON work_devices(org_id, status);

    CREATE TABLE IF NOT EXISTS work_audit_log (
      id         TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      kind       TEXT NOT NULL,
      message    TEXT NOT NULL,
      actor_id   TEXT,
      target_id  TEXT,
      channel_id TEXT,
      metadata   TEXT,
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_audit_org ON work_audit_log(org_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_work_audit_actor ON work_audit_log(org_id, actor_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS work_invite_tokens (
      token      TEXT PRIMARY KEY,
      org_id     TEXT NOT NULL,
      team       TEXT NOT NULL DEFAULT 'General',
      role       TEXT NOT NULL DEFAULT 'member',
      created_by TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      used       INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id         TEXT PRIMARY KEY,
      name_enc   TEXT NOT NULL,
      admin_id   TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspace_members (
      workspace_id TEXT NOT NULL,
      aegis_id     TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'member',
      joined_at    BIGINT NOT NULL,
      PRIMARY KEY (workspace_id, aegis_id)
    );

    CREATE INDEX IF NOT EXISTS idx_workspace_members_ws
      ON workspace_members(workspace_id);

    CREATE TABLE IF NOT EXISTS work_channels (
      channel_id        TEXT PRIMARY KEY,
      org_id            TEXT NOT NULL,
      name              TEXT NOT NULL,
      is_announcements  INTEGER NOT NULL DEFAULT 0,
      created_at        BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_channels_org ON work_channels(org_id);

    CREATE TABLE IF NOT EXISTS work_messages (
      id          TEXT PRIMARY KEY,
      channel_id  TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      sender_id   TEXT NOT NULL,
      body        TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'text',
      created_at  BIGINT NOT NULL,
      is_pinned   INTEGER NOT NULL DEFAULT 0,
      pinned_by   TEXT,
      pinned_at   TEXT,
      parent_id   TEXT,
      reply_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_work_messages_channel
      ON work_messages(channel_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_work_messages_parent
      ON work_messages(parent_id, created_at);

    CREATE TABLE IF NOT EXISTS work_attachments (
      id           TEXT PRIMARY KEY,
      message_id   TEXT NOT NULL,
      channel_id   TEXT NOT NULL,
      org_id       TEXT NOT NULL,
      blob_id      TEXT NOT NULL,
      filename     TEXT NOT NULL,
      mime_type    TEXT NOT NULL,
      size_bytes   BIGINT NOT NULL,
      uploaded_by  TEXT NOT NULL,
      created_at   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_attachments_channel
      ON work_attachments(channel_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_work_attachments_message
      ON work_attachments(message_id);

    CREATE TABLE IF NOT EXISTS work_channel_permissions (
      channel_id  TEXT NOT NULL,
      org_id      TEXT NOT NULL,
      role        TEXT NOT NULL,
      can_send    INTEGER NOT NULL DEFAULT 1,
      can_react   INTEGER NOT NULL DEFAULT 1,
      can_upload  INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (channel_id, role)
    );
  `);

  // ── PG migrations (safe to run repeatedly) ─────────────────────────────────
  // These mirror the SQLite ALTER TABLE migrations below. Existing deployments
  // may have tables from an older schema that lack newer columns. Each statement
  // is wrapped in a DO block so it's a no-op when the column already exists.
  const pgMigrations = [
    `ALTER TABLE prekeys_signed ADD COLUMN device_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE messages ADD COLUMN drained_by TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE messages ADD COLUMN sender_pub_b64 TEXT`,
    `ALTER TABLE work_messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE work_messages ADD COLUMN pinned_by TEXT`,
    `ALTER TABLE work_messages ADD COLUMN pinned_at TEXT`,
    `ALTER TABLE work_messages ADD COLUMN parent_id TEXT`,
    `ALTER TABLE work_messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE work_messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE work_orgs ADD COLUMN display_name TEXT`,
    `ALTER TABLE work_orgs ADD COLUMN invite_policy TEXT NOT NULL DEFAULT 'invite_only'`,
    `ALTER TABLE work_channels ADD COLUMN retention_days INTEGER`,
  ];
  for (const ddl of pgMigrations) {
    try { await pool.query(ddl); } catch { /* column already exists — expected */ }
  }

  // Fix primary key for prekeys_signed if it was created without device_id.
  // The old PK was (aegis_id) only; the new PK is (aegis_id, device_id).
  // This is idempotent: if the PK already includes device_id, the constraint
  // name won't match or the ADD will fail harmlessly.
  try {
    await pool.query(`ALTER TABLE prekeys_signed DROP CONSTRAINT IF EXISTS prekeys_signed_pkey`);
    await pool.query(`ALTER TABLE prekeys_signed ADD PRIMARY KEY (aegis_id, device_id)`);
  } catch { /* already correct or concurrent migration — safe to ignore */ }
}

// ── DB init (called once at startup) ─────────────────────────────────────────

let _initialized = false;

export async function initDb(): Promise<void> {
  if (_initialized) return;
  _initialized = true;
  if (USE_PG) {
    await initPgSchema();
  } else {
    getSqlite(); // bootstraps schema synchronously
  }
}

// ── Low-level query helpers ───────────────────────────────────────────────────
// These are used internally by repos; not exported publicly.

// SQLite's SQLInputValue: null | number | bigint | string | Uint8Array
type SqlParam = null | number | bigint | string | Uint8Array;

function toSqlParams(params: unknown[]): SqlParam[] {
  return params as SqlParam[];
}

function toPgParams(params: unknown[]): unknown[] {
  return params;
}

async function dbRun(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
  if (USE_PG) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await getPool().query(pgSql, toPgParams(params));
    return { changes: result.rowCount ?? 0 };
  } else {
    const stmt = getSqlite().prepare(sql);
    const result = stmt.run(...toSqlParams(params)) as { changes: number };
    return result;
  }
}

async function dbAll<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (USE_PG) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await getPool().query(pgSql, toPgParams(params));
    return result.rows as T[];
  } else {
    const stmt = getSqlite().prepare(sql);
    return stmt.all(...toSqlParams(params)) as unknown as T[];
  }
}

async function dbGet<T>(sql: string, params: unknown[] = []): Promise<T | undefined> {
  if (USE_PG) {
    let i = 0;
    const pgSql = sql.replace(/\?/g, () => `$${++i}`);
    const result = await getPool().query(pgSql, toPgParams(params));
    return result.rows[0] as T | undefined;
  } else {
    const stmt = getSqlite().prepare(sql);
    return stmt.get(...toSqlParams(params)) as unknown as T | undefined;
  }
}

// PG-specific: run multiple statements in a transaction, consuming an OPK atomically.
async function pgPopOpk(aegisId: string): Promise<{ key_id: number; public_key_b64: string } | undefined> {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const sel = await client.query(
      `SELECT key_id, public_key_b64 FROM prekeys_onetime WHERE aegis_id = $1 ORDER BY key_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED`,
      [aegisId]
    );
    if (sel.rows.length === 0) {
      await client.query('COMMIT');
      return undefined;
    }
    const opk = sel.rows[0] as { key_id: number; public_key_b64: string };
    await client.query(
      `DELETE FROM prekeys_onetime WHERE aegis_id = $1 AND key_id = $2`,
      [aegisId, opk.key_id]
    );
    await client.query('COMMIT');
    return opk;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ── Exported interfaces & repos ───────────────────────────────────────────────

export interface IdentityRow {
  aegis_id: string;
  public_key_b64: string;
  signing_public_key_b64: string;
  created_at: number;
}

export interface MessageRow {
  id: string;
  recipient: string;
  ciphertext_b64: string;
  nonce_b64: string;
  created_at: number;
  expires_at: number;
  /** JSON-serialized string[]. Device IDs that have already drained this message. */
  drained_by: string;
  /**
   * Sender's X25519 public key (base64), attached ONLY for X3DH-initial (`init`)
   * messages so the recipient can identify+decrypt a first-contact message that
   * had to be queued. null for all normal sealed-sender messages — the relay
   * never persists the social graph for those (FND-05).
   */
  sender_pub_b64?: string | null;
}

export interface PushTokenRow {
  aegis_id: string;
  expo_token: string;
  platform: 'ios' | 'android' | 'unknown';
  updated_at: number;
}

export interface SignedPreKeyRow {
  aegis_id: string;
  /** Device identifier for this prekey. Defaults to 'default' for legacy single-device clients. */
  device_id: string;
  key_id: number;
  public_key_b64: string;
  signature_b64: string;
  created_at: number;
}

export interface OneTimePreKeyRow {
  aegis_id: string;
  key_id: number;
  public_key_b64: string;
  created_at: number;
}

export interface LinkedDeviceRow {
  device_id: string;
  aegis_id: string;
  device_pub_key: string;
  device_name: string;
  platform: string;
  linked_at: number;
  revoked: number;
}

export interface RevokedDIDHashRow {
  did_hash: string;
  revoked_at: number;
  signature_b64: string;
  signing_pub_key: string;
}

export interface LightningInvoiceRow {
  payment_hash: string;
  bolt11: string;
  amount_sats: number;
  plan_days: number;
  created_at: number;
  expires_at: number;
  paid: number;
}

export interface SubscriptionRow {
  payment_hash: string;
  plan_days: number;
  activated_at: number;
  expires_at: number;
}

export interface WorkOrgRow {
  org_id: string;
  name: string;
  admin_id: string;
  policy_key_rotation_days: number;
  created_at: number;
  display_name: string | null;
  invite_policy: 'invite_only' | 'open';
}

// ── Role-based permissions ─────────────────────────────────────────────────────

export type WorkRole = 'owner' | 'admin' | 'member';

export interface WorkPermissions {
  canManageMembers: boolean;
  canCreateChannels: boolean;
  canDeleteChannels: boolean;
  canPinMessages: boolean;
  canSendAnnouncements: boolean;
  canInvite: boolean;
  canKickMembers: boolean;
  canPromoteToAdmin: boolean;
  canDemoteAdmin: boolean;
  canDeleteOrg: boolean;
}

export function getPermissions(role: WorkRole): WorkPermissions {
  const isOwner = role === 'owner';
  const isPrivileged = role === 'owner' || role === 'admin';
  return {
    canManageMembers:     isPrivileged,
    canCreateChannels:    isPrivileged,
    canDeleteChannels:    isOwner,
    canPinMessages:       isPrivileged,
    canSendAnnouncements: isPrivileged,
    canInvite:            isPrivileged,
    canKickMembers:       isPrivileged,
    canPromoteToAdmin:    isOwner,
    canDemoteAdmin:       isOwner,
    canDeleteOrg:         isOwner,
  };
}

export interface WorkMemberRow {
  org_id: string;
  aegis_id: string;
  team: string;
  role: WorkRole;
  joined_at: number;
}

export interface WorkChannelPermissionRow {
  channel_id: string;
  org_id: string;
  role: WorkRole;
  can_send: number;   // 0 | 1
  can_react: number;  // 0 | 1
  can_upload: number; // 0 | 1
}

export interface WorkDeviceRow {
  device_id: string;
  org_id: string;
  aegis_id: string;
  name: string;
  platform: string;
  status: 'pending' | 'verified' | 'revoked';
  last_seen: number;
  enrolled_at: number;
}

export interface WorkAuditRow {
  id: string;
  org_id: string;
  kind: string;
  message: string;
  actor_id: string | null;
  target_id: string | null;
  channel_id: string | null;
  metadata: string | null;  // JSON string
  created_at: number;
}

export interface WorkInviteRow {
  token: string;
  org_id: string;
  team: string;
  role: string;
  created_by: string;
  created_at: number;
  expires_at: number;
  used: number;
}

// TTL for queued messages: 30 days in ms
export const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// ── identityRepo ──────────────────────────────────────────────────────────────

export const identityRepo = {
  async get(aegisId: string): Promise<IdentityRow | undefined> {
    return dbGet<IdentityRow>(
      `SELECT aegis_id, public_key_b64, signing_public_key_b64, created_at FROM identities WHERE aegis_id = ?`,
      [aegisId]
    );
  },
  async insert(row: IdentityRow): Promise<void> {
    await dbRun(
      `INSERT INTO identities (aegis_id, public_key_b64, signing_public_key_b64, created_at) VALUES (?, ?, ?, ?)`,
      [row.aegis_id, row.public_key_b64, row.signing_public_key_b64, row.created_at]
    );
  },
};

// ── messageRepo ───────────────────────────────────────────────────────────────

/**
 * Maximum number of distinct device IDs that may drain a queued message before
 * it is hard-deleted. Set to 2 as a conservative ceiling — most users have at
 * most a primary phone + one linked desktop. Increase if you add more device
 * slots in the product.
 */
const MAX_DRAIN_DEVICES = 2;

/** Maximum queued messages per recipient — prevents disk exhaustion attacks. */
export const MAX_QUEUED_PER_RECIPIENT = 500;

export const messageRepo = {
  async enqueue(row: Omit<MessageRow, 'drained_by'>): Promise<{ ok: boolean; reason?: string }> {
    const expiresAt = row.expires_at > 0 ? row.expires_at : row.created_at + MESSAGE_TTL_MS;
    // Enforce per-recipient queue limit before inserting.
    const countRow = await dbGet<{ n: number }>(
      `SELECT COUNT(*) as n FROM messages WHERE recipient = ? AND (expires_at = 0 OR expires_at > ?)`,
      [row.recipient, Date.now()]
    );
    if (countRow && countRow.n >= MAX_QUEUED_PER_RECIPIENT) {
      return { ok: false, reason: 'queue_full' };
    }
    await dbRun(
      `INSERT INTO messages (id, recipient, ciphertext_b64, nonce_b64, created_at, expires_at, drained_by, sender_pub_b64) VALUES (?, ?, ?, ?, ?, ?, '[]', ?)`,
      [row.id, row.recipient, row.ciphertext_b64, row.nonce_b64, row.created_at, expiresAt, row.sender_pub_b64 ?? null]
    );
    return { ok: true };
  },

  /**
   * Fetch messages not yet drained by `deviceId` (or all messages when
   * `deviceId` is undefined for backward compatibility).
   */
  async drainFor(recipient: string, deviceId?: string): Promise<MessageRow[]> {
    const now = Date.now();
    const rows = await dbAll<MessageRow>(
      `SELECT id, recipient, ciphertext_b64, nonce_b64, created_at, expires_at, drained_by, sender_pub_b64
       FROM messages WHERE recipient = ? AND (expires_at = 0 OR expires_at > ?)
       ORDER BY created_at ASC`,
      [recipient, now]
    );
    if (!deviceId) return rows;
    return rows.filter((row) => {
      const drained: string[] = (() => {
        try { return JSON.parse(row.drained_by) as string[]; } catch { return []; }
      })();
      return !drained.includes(deviceId);
    });
  },

  /**
   * Mark a message as drained by `deviceId`. Deletes the row when all expected
   * devices have drained it or the caller provides no deviceId (legacy path).
   */
  async delete(id: string, deviceId?: string): Promise<void> {
    if (!deviceId) {
      await dbRun(`DELETE FROM messages WHERE id = ?`, [id]);
      return;
    }
    const row = await dbGet<Pick<MessageRow, 'drained_by'>>(
      `SELECT drained_by FROM messages WHERE id = ?`,
      [id]
    );
    if (!row) return;
    const drained: string[] = (() => {
      try { return JSON.parse(row.drained_by) as string[]; } catch { return []; }
    })();
    if (!drained.includes(deviceId)) drained.push(deviceId);
    if (drained.length >= MAX_DRAIN_DEVICES) {
      await dbRun(`DELETE FROM messages WHERE id = ?`, [id]);
    } else {
      await dbRun(`UPDATE messages SET drained_by = ? WHERE id = ?`, [JSON.stringify(drained), id]);
    }
  },

  async purgeExpired(): Promise<number> {
    const result = await dbRun(`DELETE FROM messages WHERE expires_at > 0 AND expires_at <= ?`, [Date.now()]);
    return result.changes;
  },
};

// ── pushRepo ──────────────────────────────────────────────────────────────────

export const pushRepo = {
  async upsert(row: PushTokenRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO push_tokens (aegis_id, expo_token, platform, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(aegis_id, expo_token) DO UPDATE SET platform = EXCLUDED.platform, updated_at = EXCLUDED.updated_at`,
        [row.aegis_id, row.expo_token, row.platform, row.updated_at]
      );
    } else {
      await dbRun(
        `INSERT INTO push_tokens (aegis_id, expo_token, platform, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(aegis_id, expo_token) DO UPDATE SET platform = excluded.platform, updated_at = excluded.updated_at`,
        [row.aegis_id, row.expo_token, row.platform, row.updated_at]
      );
    }
  },
  async forRecipient(aegisId: string): Promise<PushTokenRow[]> {
    return dbAll<PushTokenRow>(
      `SELECT aegis_id, expo_token, platform, updated_at FROM push_tokens WHERE aegis_id = ?`,
      [aegisId]
    );
  },
  async delete(token: string): Promise<void> {
    await dbRun(`DELETE FROM push_tokens WHERE expo_token = ?`, [token]);
  },
};

// ── prekeysRepo ───────────────────────────────────────────────────────────────

export const prekeysRepo = {
  async upsertSigned(row: SignedPreKeyRow): Promise<void> {
    const deviceId = row.device_id || 'default';
    if (USE_PG) {
      await dbRun(
        `INSERT INTO prekeys_signed (aegis_id, device_id, key_id, public_key_b64, signature_b64, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id, device_id) DO UPDATE SET key_id = EXCLUDED.key_id, public_key_b64 = EXCLUDED.public_key_b64, signature_b64 = EXCLUDED.signature_b64, created_at = EXCLUDED.created_at`,
        [row.aegis_id, deviceId, row.key_id, row.public_key_b64, row.signature_b64, row.created_at]
      );
    } else {
      await dbRun(
        `INSERT INTO prekeys_signed (aegis_id, device_id, key_id, public_key_b64, signature_b64, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id, device_id) DO UPDATE SET key_id = excluded.key_id, public_key_b64 = excluded.public_key_b64, signature_b64 = excluded.signature_b64, created_at = excluded.created_at`,
        [row.aegis_id, deviceId, row.key_id, row.public_key_b64, row.signature_b64, row.created_at]
      );
    }
  },
  async insertOneTime(row: OneTimePreKeyRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO prekeys_onetime (aegis_id, key_id, public_key_b64, created_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(aegis_id, key_id) DO NOTHING`,
        [row.aegis_id, row.key_id, row.public_key_b64, row.created_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO prekeys_onetime (aegis_id, key_id, public_key_b64, created_at) VALUES (?, ?, ?, ?)`,
        [row.aegis_id, row.key_id, row.public_key_b64, row.created_at]
      );
    }
  },
  async countOneTime(aegisId: string): Promise<number> {
    const row = await dbGet<{ count: string | number }>(
      `SELECT COUNT(*) as count FROM prekeys_onetime WHERE aegis_id = ?`,
      [aegisId]
    );
    return row ? Number(row.count) : 0;
  },
  async getBundle(aegisId: string): Promise<{
    signingPublicKeyB64: string;
    signedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string };
    oneTimePreKey: { keyId: number; publicKeyB64: string } | null;
  } | null> {
    const bundles = await this.getBundles(aegisId);
    return bundles.length > 0 ? bundles[0] : null;
  },

  /**
   * Fetch an X3DH prekey bundle per device registered under `aegisId`.
   * Each bundle includes a `device_id` field so the caller can address
   * messages to specific devices (multi-device X3DH).
   *
   * One-time prekeys are consumed atomically — one OPK per device per call.
   */
  async getBundles(aegisId: string): Promise<Array<{
    device_id: string;
    signingPublicKeyB64: string;
    signedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string };
    oneTimePreKey: { keyId: number; publicKeyB64: string } | null;
  }>> {
    const spkRows = await dbAll<{ device_id: string; key_id: number; public_key_b64: string; signature_b64: string }>(
      `SELECT device_id, key_id, public_key_b64, signature_b64 FROM prekeys_signed WHERE aegis_id = ?`,
      [aegisId]
    );
    if (spkRows.length === 0) return [];

    const identity = await dbGet<{ signing_public_key_b64: string }>(
      `SELECT signing_public_key_b64 FROM identities WHERE aegis_id = ?`,
      [aegisId]
    );
    const signingPublicKeyB64 = identity?.signing_public_key_b64 ?? '';
    if (signingPublicKeyB64 === '') return [];

    const result: Array<{
      device_id: string;
      signingPublicKeyB64: string;
      signedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string };
      oneTimePreKey: { keyId: number; publicKeyB64: string } | null;
    }> = [];

    for (const spk of spkRows) {
      // Pop one OPK for this device atomically
      let opk: { key_id: number; public_key_b64: string } | undefined;
      if (USE_PG) {
        opk = await pgPopOpk(aegisId);
      } else {
        const db = getSqlite()!;
        const found = db.prepare(
          `SELECT key_id, public_key_b64 FROM prekeys_onetime WHERE aegis_id = ? ORDER BY key_id ASC LIMIT 1`
        ).get(aegisId) as { key_id: number; public_key_b64: string } | undefined;
        if (found) {
          db.prepare(`DELETE FROM prekeys_onetime WHERE aegis_id = ? AND key_id = ?`).run(aegisId, found.key_id);
          opk = found;
        }
      }

      result.push({
        device_id: spk.device_id,
        signingPublicKeyB64,
        signedPreKey: {
          keyId: spk.key_id,
          publicKeyB64: spk.public_key_b64,
          signatureB64: spk.signature_b64,
        },
        oneTimePreKey: opk ? { keyId: opk.key_id, publicKeyB64: opk.public_key_b64 } : null,
      });
    }

    return result;
  },
};

// ── devicesRepo ───────────────────────────────────────────────────────────────

export const devicesRepo = {
  async upsert(row: Omit<LinkedDeviceRow, 'revoked'>): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO linked_devices (device_id, aegis_id, device_pub_key, device_name, platform, linked_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(device_id) DO UPDATE SET linked_at = EXCLUDED.linked_at, revoked = 0`,
        [row.device_id, row.aegis_id, row.device_pub_key, row.device_name, row.platform, row.linked_at]
      );
    } else {
      await dbRun(
        `INSERT INTO linked_devices (device_id, aegis_id, device_pub_key, device_name, platform, linked_at, revoked)
         VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(device_id) DO UPDATE SET linked_at = excluded.linked_at, revoked = 0`,
        [row.device_id, row.aegis_id, row.device_pub_key, row.device_name, row.platform, row.linked_at]
      );
    }
  },
  async listActive(aegisId: string): Promise<LinkedDeviceRow[]> {
    return dbAll<LinkedDeviceRow>(
      `SELECT device_id, aegis_id, device_pub_key, device_name, platform, linked_at, revoked
       FROM linked_devices WHERE aegis_id = ? AND revoked = 0`,
      [aegisId]
    );
  },
  async revoke(deviceId: string, aegisId: string): Promise<boolean> {
    const result = await dbRun(
      `UPDATE linked_devices SET revoked = 1 WHERE device_id = ? AND aegis_id = ?`,
      [deviceId, aegisId]
    );
    return result.changes > 0;
  },
  async isRevoked(deviceId: string): Promise<boolean> {
    const row = await dbGet<{ revoked: number }>(
      `SELECT revoked FROM linked_devices WHERE device_id = ? LIMIT 1`,
      [deviceId]
    );
    return row !== undefined && row.revoked === 1;
  },
};

// ── web3Repo ──────────────────────────────────────────────────────────────────

export const web3Repo = {
  async insertRevocation(row: RevokedDIDHashRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO revoked_did_hashes (did_hash, revoked_at, signature_b64, signing_pub_key) VALUES (?, ?, ?, ?)
         ON CONFLICT(did_hash) DO NOTHING`,
        [row.did_hash, row.revoked_at, row.signature_b64, row.signing_pub_key]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO revoked_did_hashes (did_hash, revoked_at, signature_b64, signing_pub_key) VALUES (?, ?, ?, ?)`,
        [row.did_hash, row.revoked_at, row.signature_b64, row.signing_pub_key]
      );
    }
  },
  async isRevoked(didHash: string): Promise<boolean> {
    const row = await dbGet<{ did_hash: string }>(
      `SELECT did_hash FROM revoked_did_hashes WHERE did_hash = ? LIMIT 1`,
      [didHash]
    );
    return row !== undefined;
  },
  async insertInvoice(row: Omit<LightningInvoiceRow, 'paid'>): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO lightning_invoices (payment_hash, bolt11, amount_sats, plan_days, created_at, expires_at, paid) VALUES (?, ?, ?, ?, ?, ?, 0)
         ON CONFLICT(payment_hash) DO NOTHING`,
        [row.payment_hash, row.bolt11, row.amount_sats, row.plan_days, row.created_at, row.expires_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO lightning_invoices (payment_hash, bolt11, amount_sats, plan_days, created_at, expires_at, paid) VALUES (?, ?, ?, ?, ?, ?, 0)`,
        [row.payment_hash, row.bolt11, row.amount_sats, row.plan_days, row.created_at, row.expires_at]
      );
    }
  },
  async getInvoice(paymentHash: string): Promise<LightningInvoiceRow | undefined> {
    return dbGet<LightningInvoiceRow>(
      `SELECT payment_hash, bolt11, amount_sats, plan_days, created_at, expires_at, paid FROM lightning_invoices WHERE payment_hash = ?`,
      [paymentHash]
    );
  },
  async markInvoicePaid(paymentHash: string): Promise<void> {
    await dbRun(`UPDATE lightning_invoices SET paid = 1 WHERE payment_hash = ?`, [paymentHash]);
  },
  async insertSubscription(row: SubscriptionRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO subscriptions (payment_hash, plan_days, activated_at, expires_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(payment_hash) DO UPDATE SET plan_days = EXCLUDED.plan_days, activated_at = EXCLUDED.activated_at, expires_at = EXCLUDED.expires_at`,
        [row.payment_hash, row.plan_days, row.activated_at, row.expires_at]
      );
    } else {
      await dbRun(
        `INSERT OR REPLACE INTO subscriptions (payment_hash, plan_days, activated_at, expires_at) VALUES (?, ?, ?, ?)`,
        [row.payment_hash, row.plan_days, row.activated_at, row.expires_at]
      );
    }
  },
  async getSubscription(paymentHash: string): Promise<SubscriptionRow | undefined> {
    return dbGet<SubscriptionRow>(
      `SELECT payment_hash, plan_days, activated_at, expires_at FROM subscriptions WHERE payment_hash = ?`,
      [paymentHash]
    );
  },
};

// ── pollsRepo ─────────────────────────────────────────────────────────────────

export const pollsRepo = {
  async vote(pollId: string, voterHash: string, optionIndex: number): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO poll_votes (poll_id, voter_hash, option_index) VALUES (?, ?, ?)
         ON CONFLICT(poll_id, voter_hash) DO UPDATE SET option_index = EXCLUDED.option_index`,
        [pollId, voterHash, optionIndex]
      );
    } else {
      await dbRun(
        `INSERT INTO poll_votes (poll_id, voter_hash, option_index) VALUES (?, ?, ?)
         ON CONFLICT(poll_id, voter_hash) DO UPDATE SET option_index = excluded.option_index`,
        [pollId, voterHash, optionIndex]
      );
    }
  },
  async getTally(pollId: string): Promise<number[]> {
    const rows = await dbAll<{ option_index: number; count: string | number }>(
      `SELECT option_index, COUNT(*) as count FROM poll_votes WHERE poll_id = ? GROUP BY option_index`,
      [pollId]
    );
    let maxIdx = 0;
    for (const r of rows) {
      if (r.option_index > maxIdx) maxIdx = r.option_index;
    }
    const counts = Array<number>(maxIdx + 1).fill(0);
    for (const r of rows) {
      counts[r.option_index] = Number(r.count);
    }
    return counts;
  },
};

// ── workRepo ──────────────────────────────────────────────────────────────────

export const workRepo = {
  async createOrg(row: Omit<WorkOrgRow, 'display_name' | 'invite_policy'> & { display_name?: string | null; invite_policy?: 'invite_only' | 'open' }): Promise<void> {
    await dbRun(
      `INSERT INTO work_orgs (org_id, name, admin_id, policy_key_rotation_days, created_at) VALUES (?, ?, ?, ?, ?)`,
      [row.org_id, row.name, row.admin_id, row.policy_key_rotation_days, row.created_at]
    );
  },
  async getOrg(orgId: string): Promise<WorkOrgRow | undefined> {
    return dbGet<WorkOrgRow>(`SELECT * FROM work_orgs WHERE org_id = ?`, [orgId]);
  },
  async addMember(row: WorkMemberRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO work_members (org_id, aegis_id, team, role, joined_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, aegis_id) DO NOTHING`,
        [row.org_id, row.aegis_id, row.team, row.role, row.joined_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO work_members (org_id, aegis_id, team, role, joined_at) VALUES (?, ?, ?, ?, ?)`,
        [row.org_id, row.aegis_id, row.team, row.role, row.joined_at]
      );
    }
  },
  async listMembers(orgId: string): Promise<WorkMemberRow[]> {
    return dbAll<WorkMemberRow>(`SELECT * FROM work_members WHERE org_id = ?`, [orgId]);
  },
  async getMember(orgId: string, aegisId: string): Promise<WorkMemberRow | undefined> {
    return dbGet<WorkMemberRow>(`SELECT * FROM work_members WHERE org_id = ? AND aegis_id = ?`, [orgId, aegisId]);
  },
  async removeMember(orgId: string, aegisId: string): Promise<void> {
    await dbRun(`DELETE FROM work_members WHERE org_id = ? AND aegis_id = ?`, [orgId, aegisId]);
  },
  async upsertDevice(row: WorkDeviceRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO work_devices (device_id, org_id, aegis_id, name, platform, status, last_seen, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET org_id = EXCLUDED.org_id, aegis_id = EXCLUDED.aegis_id, name = EXCLUDED.name, platform = EXCLUDED.platform, status = EXCLUDED.status, last_seen = EXCLUDED.last_seen, enrolled_at = EXCLUDED.enrolled_at`,
        [row.device_id, row.org_id, row.aegis_id, row.name, row.platform, row.status, row.last_seen, row.enrolled_at]
      );
    } else {
      await dbRun(
        `INSERT OR REPLACE INTO work_devices (device_id, org_id, aegis_id, name, platform, status, last_seen, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.device_id, row.org_id, row.aegis_id, row.name, row.platform, row.status, row.last_seen, row.enrolled_at]
      );
    }
  },
  async listDevices(orgId: string): Promise<WorkDeviceRow[]> {
    return dbAll<WorkDeviceRow>(`SELECT * FROM work_devices WHERE org_id = ?`, [orgId]);
  },
  async setDeviceStatus(deviceId: string, orgId: string, status: WorkDeviceRow['status']): Promise<void> {
    await dbRun(`UPDATE work_devices SET status = ? WHERE device_id = ? AND org_id = ?`, [status, deviceId, orgId]);
  },
  async touchDevice(deviceId: string): Promise<void> {
    await dbRun(`UPDATE work_devices SET last_seen = ? WHERE device_id = ?`, [Date.now(), deviceId]);
  },
  async addAudit(row: Omit<WorkAuditRow, 'id'> & { id?: string }): Promise<void> {
    const id = row.id ?? randomUUID();
    await dbRun(
      `INSERT INTO work_audit_log (id, org_id, kind, message, actor_id, target_id, channel_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, row.org_id, row.kind, row.message, row.actor_id ?? null, row.target_id ?? null, row.channel_id ?? null, row.metadata ?? null, row.created_at]
    );
  },
  async listAudit(orgId: string, opts?: {
    limit?: number;
    before?: number;
    kind?: string;
    actorId?: string;
    channelId?: string;
  }): Promise<WorkAuditRow[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const conditions: string[] = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (opts?.before !== undefined) { conditions.push('created_at < ?'); params.push(opts.before); }
    if (opts?.kind !== undefined) { conditions.push('kind = ?'); params.push(opts.kind); }
    if (opts?.actorId !== undefined) { conditions.push('actor_id = ?'); params.push(opts.actorId); }
    if (opts?.channelId !== undefined) { conditions.push('channel_id = ?'); params.push(opts.channelId); }
    params.push(limit);
    return dbAll<WorkAuditRow>(
      `SELECT id, org_id, kind, message, actor_id, target_id, channel_id, metadata, created_at FROM work_audit_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params
    );
  },
  async updateMemberRole(orgId: string, aegisId: string, role: WorkRole): Promise<boolean> {
    const result = await dbRun(
      `UPDATE work_members SET role = ? WHERE org_id = ? AND aegis_id = ?`,
      [role, orgId, aegisId]
    );
    return result.changes > 0;
  },
  async createInvite(row: WorkInviteRow): Promise<void> {
    await dbRun(
      `INSERT INTO work_invite_tokens (token, org_id, team, role, created_by, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [row.token, row.org_id, row.team, row.role, row.created_by, row.created_at, row.expires_at]
    );
  },
  async getInvite(token: string): Promise<WorkInviteRow | undefined> {
    return dbGet<WorkInviteRow>(`SELECT * FROM work_invite_tokens WHERE token = ?`, [token]);
  },
  async useInvite(token: string): Promise<void> {
    await dbRun(`UPDATE work_invite_tokens SET used = 1 WHERE token = ?`, [token]);
  },
  async updateOrgSettings(orgId: string, displayName: string | null, invitePolicy: 'invite_only' | 'open'): Promise<void> {
    await dbRun(
      `UPDATE work_orgs SET display_name = ?, invite_policy = ? WHERE org_id = ?`,
      [displayName, invitePolicy, orgId],
    );
  },
  async updateChannelRetention(channelId: string, retentionDays: number | null): Promise<void> {
    await dbRun(
      `UPDATE work_channels SET retention_days = ? WHERE channel_id = ?`,
      [retentionDays, channelId],
    );
  },
};

// ── workChannelRepo / workMessageRepo ─────────────────────────────────────────

export interface WorkChannelRow {
  channel_id: string;
  org_id: string;
  name: string;
  is_announcements: number; // 0 | 1
  created_at: number;
  retention_days: number | null;
}

export interface WorkMessageRow {
  id: string;
  channel_id: string;
  org_id: string;
  sender_id: string;
  body: string;
  type: string;
  created_at: number;
  is_pinned: number; // 0 | 1
  pinned_by: string | null;
  pinned_at: string | null;
  parent_id: string | null;
  reply_count: number;
  /** Soft-delete: 1 = deleted. Body and type are replaced with '' / 'deleted'. */
  is_deleted: number; // 0 | 1
}

export const workChannelRepo = {
  async create(row: Omit<WorkChannelRow, 'retention_days'>): Promise<void> {
    await dbRun(
      `INSERT INTO work_channels (channel_id, org_id, name, is_announcements, created_at) VALUES (?, ?, ?, ?, ?)`,
      [row.channel_id, row.org_id, row.name, row.is_announcements, row.created_at]
    );
  },
  async listByOrg(orgId: string): Promise<WorkChannelRow[]> {
    return dbAll<WorkChannelRow>(
      `SELECT channel_id, org_id, name, is_announcements, created_at, retention_days FROM work_channels WHERE org_id = ? ORDER BY created_at ASC`,
      [orgId]
    );
  },
  async get(channelId: string): Promise<WorkChannelRow | undefined> {
    return dbGet<WorkChannelRow>(
      `SELECT channel_id, org_id, name, is_announcements, created_at, retention_days FROM work_channels WHERE channel_id = ?`,
      [channelId]
    );
  },
};

export const workMessageRepo = {
  async insert(row: Omit<WorkMessageRow, 'is_pinned' | 'pinned_by' | 'pinned_at' | 'reply_count' | 'is_deleted'>): Promise<void> {
    const parentId = row.parent_id ?? null;
    await dbRun(
      `INSERT INTO work_messages (id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, 0)`,
      [row.id, row.channel_id, row.org_id, row.sender_id, row.body, row.type, row.created_at, parentId]
    );
    if (parentId !== null) {
      await dbRun(
        `UPDATE work_messages SET reply_count = reply_count + 1 WHERE id = ?`,
        [parentId]
      );
    }
  },
  async getByChannel(
    channelId: string,
    limit = 50,
    before?: number
  ): Promise<WorkMessageRow[]> {
    if (before !== undefined) {
      return dbAll<WorkMessageRow>(
        `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
         FROM work_messages WHERE channel_id = ? AND created_at < ?
         ORDER BY created_at DESC LIMIT ?`,
        [channelId, before, limit]
      );
    }
    return dbAll<WorkMessageRow>(
      `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
       FROM work_messages WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [channelId, limit]
    );
  },

  async getThreadReplies(parentId: string, channelId: string): Promise<WorkMessageRow[]> {
    return dbAll<WorkMessageRow>(
      `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
       FROM work_messages WHERE parent_id = ? AND channel_id = ?
       ORDER BY created_at ASC`,
      [parentId, channelId]
    );
  },

  async getById(messageId: string): Promise<WorkMessageRow | undefined> {
    return dbGet<WorkMessageRow>(
      `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
       FROM work_messages WHERE id = ?`,
      [messageId]
    );
  },
  
  async search(orgId: string, channelId: string | null, query: string, limit = 50): Promise<WorkMessageRow[]> {
    // Sanitize: escape double-quotes and wrap in phrase-search delimiters for FTS5
    const ftsQuery = `"${query.replace(/"/g, '""')}"`;
    try {
      return await dbAll<WorkMessageRow>(
        `SELECT m.id, m.channel_id, m.org_id, m.sender_id, m.body, m.type, m.created_at, m.is_pinned, m.pinned_by, m.pinned_at, m.parent_id, m.reply_count, COALESCE(m.is_deleted, 0) AS is_deleted
         FROM work_messages_fts f
         JOIN work_messages m ON m.id = f.id
         WHERE f.org_id = ? AND (? IS NULL OR f.channel_id = ?) AND work_messages_fts MATCH ? AND COALESCE(m.is_deleted, 0) = 0
         ORDER BY m.created_at DESC LIMIT ?`,
        [orgId, channelId, channelId, ftsQuery, limit]
      );
    } catch {
      // Fallback to LIKE for old DBs that may not have the FTS table yet
      const likeQuery = `%${query}%`;
      return dbAll<WorkMessageRow>(
        `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
         FROM work_messages
         WHERE org_id = ? AND (? IS NULL OR channel_id = ?) AND body LIKE ? AND COALESCE(is_deleted, 0) = 0
         ORDER BY created_at DESC LIMIT ?`,
        [orgId, channelId, channelId, likeQuery, limit]
      );
    }
  },
  async pinMessage(
    messageId: string,
    channelId: string,
    orgId: string,
    pinnedBy: string,
    pin: boolean,
  ): Promise<boolean> {
    const existing = await dbGet<Pick<WorkMessageRow, 'id' | 'is_deleted'>>(
      `SELECT id, COALESCE(is_deleted, 0) AS is_deleted FROM work_messages WHERE id = ? AND channel_id = ? AND org_id = ?`,
      [messageId, channelId, orgId],
    );
    if (!existing) return false;
    const isPinned = pin ? 1 : 0;
    const pinnedByVal = pin ? pinnedBy : null;
    const pinnedAtVal = pin ? new Date().toISOString() : null;
    await dbRun(
      `UPDATE work_messages SET is_pinned = ?, pinned_by = ?, pinned_at = ? WHERE id = ? AND channel_id = ?`,
      [isPinned, pinnedByVal, pinnedAtVal, messageId, channelId],
    );
    return true;
  },
  async getPinnedMessages(channelId: string): Promise<WorkMessageRow[]> {
    return dbAll<WorkMessageRow>(
      `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
       FROM work_messages WHERE channel_id = ? AND is_pinned = 1
       ORDER BY pinned_at ASC`,
      [channelId],
    );
  },

  /**
   * Soft-delete a message: replaces body with '' and type with 'deleted'.
   * Returns `true` if the message existed, `false` if not found.
   */
  async softDelete(messageId: string): Promise<boolean> {
    const existing = await dbGet<Pick<WorkMessageRow, 'id'>>(
      `SELECT id FROM work_messages WHERE id = ?`,
      [messageId],
    );
    if (!existing) return false;
    await dbRun(
      `UPDATE work_messages SET body = '', type = 'deleted', is_deleted = 1 WHERE id = ?`,
      [messageId],
    );
    return true;
  },
};

// ── pruneExpiredWorkMessages ──────────────────────────────────────────────────

/**
 * Hard-delete work messages that are older than the channel's retention_days
 * policy. Runs server-side only; clients never see deleted content after
 * reconnect. Safe to call on any backend (SQLite or PG) via dbRun/dbAll.
 */
export async function pruneExpiredWorkMessages(): Promise<void> {
  // Find channels with a retention policy set
  const channels = await dbAll<{ channel_id: string; retention_days: number }>(
    `SELECT channel_id, retention_days FROM work_channels WHERE retention_days IS NOT NULL`,
  );
  for (const ch of channels) {
    const cutoffMs = Date.now() - ch.retention_days * 86400 * 1000;
    await dbRun(
      `DELETE FROM work_messages WHERE channel_id = ? AND created_at < ?`,
      [ch.channel_id, cutoffMs],
    );
  }
}

// ── workAttachmentRepo ────────────────────────────────────────────────────────

export interface WorkAttachmentRow {
  id: string;
  message_id: string;
  channel_id: string;
  org_id: string;
  /** References a blob stored in the /uploads/ directory by the PoW upload endpoint. */
  blob_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  /** ISO-8601 timestamp string */
  created_at: string;
}

export const workAttachmentRepo = {
  async insert(row: WorkAttachmentRow): Promise<void> {
    await dbRun(
      `INSERT INTO work_attachments (id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.message_id, row.channel_id, row.org_id, row.blob_id, row.filename, row.mime_type, row.size_bytes, row.uploaded_by, row.created_at]
    );
  },

  /**
   * Paginated list of all attachments for a channel.
   * `before` is an ISO-8601 string cursor (exclusive upper bound on created_at).
   */
  async getByChannel(channelId: string, limit: number, before?: string): Promise<WorkAttachmentRow[]> {
    if (before !== undefined) {
      return dbAll<WorkAttachmentRow>(
        `SELECT id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at
         FROM work_attachments WHERE channel_id = ? AND created_at < ?
         ORDER BY created_at DESC LIMIT ?`,
        [channelId, before, limit]
      );
    }
    return dbAll<WorkAttachmentRow>(
      `SELECT id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM work_attachments WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [channelId, limit]
    );
  },

  async getByMessage(messageId: string): Promise<WorkAttachmentRow[]> {
    return dbAll<WorkAttachmentRow>(
      `SELECT id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM work_attachments WHERE message_id = ?
       ORDER BY created_at ASC`,
      [messageId]
    );
  },

  async getById(attachmentId: string): Promise<WorkAttachmentRow | undefined> {
    return dbGet<WorkAttachmentRow>(
      `SELECT id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM work_attachments WHERE id = ?`,
      [attachmentId]
    );
  },
};

// ── workChannelPermissionRepo ─────────────────────────────────────────────────

const ALL_ROLES: WorkRole[] = ['owner', 'admin', 'member'];

export const workChannelPermissionRepo = {
  /**
   * Seed default permissions for a newly created channel.
   * Announcements channels restrict members from sending.
   */
  async seedDefaults(channelId: string, orgId: string, isAnnouncements: boolean): Promise<void> {
    for (const role of ALL_ROLES) {
      const canSend = isAnnouncements && role === 'member' ? 0 : 1;
      if (USE_PG) {
        await dbRun(
          `INSERT INTO work_channel_permissions (channel_id, org_id, role, can_send, can_react, can_upload)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(channel_id, role) DO NOTHING`,
          [channelId, orgId, role, canSend, canSend]
        );
      } else {
        await dbRun(
          `INSERT OR IGNORE INTO work_channel_permissions (channel_id, org_id, role, can_send, can_react, can_upload)
           VALUES (?, ?, ?, ?, 1, ?)`,
          [channelId, orgId, role, canSend, canSend]
        );
      }
    }
  },

  async getAll(channelId: string): Promise<WorkChannelPermissionRow[]> {
    return dbAll<WorkChannelPermissionRow>(
      `SELECT channel_id, org_id, role, can_send, can_react, can_upload
       FROM work_channel_permissions WHERE channel_id = ?`,
      [channelId]
    );
  },

  async getForRole(channelId: string, role: WorkRole): Promise<WorkChannelPermissionRow | undefined> {
    return dbGet<WorkChannelPermissionRow>(
      `SELECT channel_id, org_id, role, can_send, can_react, can_upload
       FROM work_channel_permissions WHERE channel_id = ? AND role = ?`,
      [channelId, role]
    );
  },

  async set(channelId: string, orgId: string, role: WorkRole, perms: { canSend: boolean; canReact: boolean; canUpload: boolean }): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO work_channel_permissions (channel_id, org_id, role, can_send, can_react, can_upload)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, role) DO UPDATE SET can_send = EXCLUDED.can_send, can_react = EXCLUDED.can_react, can_upload = EXCLUDED.can_upload`,
        [channelId, orgId, role, perms.canSend ? 1 : 0, perms.canReact ? 1 : 0, perms.canUpload ? 1 : 0]
      );
    } else {
      await dbRun(
        `INSERT INTO work_channel_permissions (channel_id, org_id, role, can_send, can_react, can_upload)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, role) DO UPDATE SET can_send = excluded.can_send, can_react = excluded.can_react, can_upload = excluded.can_upload`,
        [channelId, orgId, role, perms.canSend ? 1 : 0, perms.canReact ? 1 : 0, perms.canUpload ? 1 : 0]
      );
    }
  },
};

// ── workspaceRepo ─────────────────────────────────────────────────────────────

export interface WorkspaceRow {
  id: string;
  name_enc: string;   // name is stored ciphertext — server never sees plaintext
  admin_id: string;
  created_at: number;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  aegis_id: string;
  role: string;
  joined_at: number;
}

export const workspaceRepo = {
  async create(row: WorkspaceRow): Promise<void> {
    await dbRun(
      `INSERT INTO workspaces (id, name_enc, admin_id, created_at) VALUES (?, ?, ?, ?)`,
      [row.id, row.name_enc, row.admin_id, row.created_at]
    );
  },

  async get(id: string): Promise<WorkspaceRow | undefined> {
    return dbGet<WorkspaceRow>(
      `SELECT id, name_enc, admin_id, created_at FROM workspaces WHERE id = ?`,
      [id]
    );
  },

  async addMember(row: WorkspaceMemberRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO workspace_members (workspace_id, aegis_id, role, joined_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, aegis_id) DO NOTHING`,
        [row.workspace_id, row.aegis_id, row.role, row.joined_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO workspace_members (workspace_id, aegis_id, role, joined_at) VALUES (?, ?, ?, ?)`,
        [row.workspace_id, row.aegis_id, row.role, row.joined_at]
      );
    }
  },

  async removeMember(workspaceId: string, aegisId: string): Promise<boolean> {
    const result = await dbRun(
      `DELETE FROM workspace_members WHERE workspace_id = ? AND aegis_id = ?`,
      [workspaceId, aegisId]
    );
    return result.changes > 0;
  },

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRow[]> {
    return dbAll<WorkspaceMemberRow>(
      `SELECT workspace_id, aegis_id, role, joined_at FROM workspace_members WHERE workspace_id = ?`,
      [workspaceId]
    );
  },

  async isMember(workspaceId: string, aegisId: string): Promise<boolean> {
    const row = await dbGet<{ aegis_id: string }>(
      `SELECT aegis_id FROM workspace_members WHERE workspace_id = ? AND aegis_id = ? LIMIT 1`,
      [workspaceId, aegisId]
    );
    return row !== undefined;
  },
};

// ── backupRepo ────────────────────────────────────────────────────────────────
// Stores one encrypted backup blob per user.
// The key is SHA-256(aegisId) so the aegisId itself never appears in the DB row.
// The envelope column is the raw JSON string of the BackupEnvelope — opaque to
// the server (server never parses its fields beyond treating it as text).

export interface BackupRow {
  id_hash: string;
  envelope: string;
  updated_at: number;
}

export const backupRepo = {
  async upsert(idHash: string, envelope: string): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO backups (id_hash, envelope, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id_hash) DO UPDATE SET envelope = EXCLUDED.envelope, updated_at = EXCLUDED.updated_at`,
        [idHash, envelope, Date.now()]
      );
    } else {
      await dbRun(
        `INSERT INTO backups (id_hash, envelope, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id_hash) DO UPDATE SET envelope = excluded.envelope, updated_at = excluded.updated_at`,
        [idHash, envelope, Date.now()]
      );
    }
  },
  async get(idHash: string): Promise<BackupRow | undefined> {
    return dbGet<BackupRow>(
      `SELECT id_hash, envelope, updated_at FROM backups WHERE id_hash = ?`,
      [idHash]
    );
  },
  async delete(idHash: string): Promise<boolean> {
    const result = await dbRun(`DELETE FROM backups WHERE id_hash = ?`, [idHash]);
    return result.changes > 0;
  },
};
