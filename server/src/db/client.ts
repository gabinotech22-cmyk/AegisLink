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
      expires_at     INTEGER NOT NULL DEFAULT 0
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
      aegis_id       TEXT PRIMARY KEY,
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      signature_b64  TEXT NOT NULL,
      created_at     INTEGER NOT NULL
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
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_audit_org ON work_audit_log(org_id, created_at DESC);

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
  `);

  // Schema migrations for existing deployments
  try { db.exec(`ALTER TABLE identities ADD COLUMN signing_public_key_b64 TEXT NOT NULL DEFAULT '';`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages DROP COLUMN sender;`); } catch { /* absent */ }
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
      expires_at     BIGINT NOT NULL DEFAULT 0
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
      aegis_id       TEXT PRIMARY KEY,
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      signature_b64  TEXT NOT NULL,
      created_at     BIGINT NOT NULL
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
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_work_audit_org ON work_audit_log(org_id, created_at DESC);

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
  `);
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
}

export interface PushTokenRow {
  aegis_id: string;
  expo_token: string;
  platform: 'ios' | 'android' | 'unknown';
  updated_at: number;
}

export interface SignedPreKeyRow {
  aegis_id: string;
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
}

export interface WorkMemberRow {
  org_id: string;
  aegis_id: string;
  team: string;
  role: string;
  joined_at: number;
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
  kind: 'info' | 'warn' | 'ok';
  message: string;
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

export const messageRepo = {
  async enqueue(row: MessageRow): Promise<void> {
    const expiresAt = row.expires_at > 0 ? row.expires_at : row.created_at + MESSAGE_TTL_MS;
    await dbRun(
      `INSERT INTO messages (id, recipient, ciphertext_b64, nonce_b64, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)`,
      [row.id, row.recipient, row.ciphertext_b64, row.nonce_b64, row.created_at, expiresAt]
    );
  },
  async drainFor(recipient: string): Promise<MessageRow[]> {
    return dbAll<MessageRow>(
      `SELECT id, recipient, ciphertext_b64, nonce_b64, created_at, expires_at
       FROM messages WHERE recipient = ? AND (expires_at = 0 OR expires_at > ?)
       ORDER BY created_at ASC`,
      [recipient, Date.now()]
    );
  },
  async delete(id: string): Promise<void> {
    await dbRun(`DELETE FROM messages WHERE id = ?`, [id]);
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
    if (USE_PG) {
      await dbRun(
        `INSERT INTO prekeys_signed (aegis_id, key_id, public_key_b64, signature_b64, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id) DO UPDATE SET key_id = EXCLUDED.key_id, public_key_b64 = EXCLUDED.public_key_b64, signature_b64 = EXCLUDED.signature_b64, created_at = EXCLUDED.created_at`,
        [row.aegis_id, row.key_id, row.public_key_b64, row.signature_b64, row.created_at]
      );
    } else {
      await dbRun(
        `INSERT INTO prekeys_signed (aegis_id, key_id, public_key_b64, signature_b64, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(aegis_id) DO UPDATE SET key_id = excluded.key_id, public_key_b64 = excluded.public_key_b64, signature_b64 = excluded.signature_b64, created_at = excluded.created_at`,
        [row.aegis_id, row.key_id, row.public_key_b64, row.signature_b64, row.created_at]
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
    const spk = await dbGet<{ key_id: number; public_key_b64: string; signature_b64: string }>(
      `SELECT key_id, public_key_b64, signature_b64 FROM prekeys_signed WHERE aegis_id = ?`,
      [aegisId]
    );
    if (!spk) return null;

    const identity = await dbGet<{ signing_public_key_b64: string }>(
      `SELECT signing_public_key_b64 FROM identities WHERE aegis_id = ?`,
      [aegisId]
    );
    const signingPublicKeyB64 = identity?.signing_public_key_b64 ?? '';
    if (signingPublicKeyB64 === '') return null;

    // Pop OPK atomically
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

    return {
      signingPublicKeyB64,
      signedPreKey: {
        keyId: spk.key_id,
        publicKeyB64: spk.public_key_b64,
        signatureB64: spk.signature_b64,
      },
      oneTimePreKey: opk ? { keyId: opk.key_id, publicKeyB64: opk.public_key_b64 } : null,
    };
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
  async createOrg(row: WorkOrgRow): Promise<void> {
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
  async addAudit(row: WorkAuditRow): Promise<void> {
    await dbRun(
      `INSERT INTO work_audit_log (id, org_id, kind, message, created_at) VALUES (?, ?, ?, ?, ?)`,
      [row.id, row.org_id, row.kind, row.message, row.created_at]
    );
  },
  async listAudit(orgId: string, limit = 50): Promise<WorkAuditRow[]> {
    return dbAll<WorkAuditRow>(
      `SELECT * FROM work_audit_log WHERE org_id = ? ORDER BY created_at DESC LIMIT ?`,
      [orgId, limit]
    );
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
