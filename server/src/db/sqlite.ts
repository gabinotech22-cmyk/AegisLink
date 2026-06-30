/**
 * AegisLink — SQLite backend (development / default)
 *
 * Extracted from db/client.ts (M4 god-file split). Pure relocation: no logic,
 * SQL, or behavior changes. See db/client.ts for the barrel that re-exports
 * the public surface.
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

// Lazily-imported DatabaseSync class (ESM-safe: we import at module level but
// only construct when needed, which is fine since node:sqlite is always available
// in Node 22).
import { DatabaseSync } from 'node:sqlite';

let sqlite: DatabaseSync | null = null;

export function getSqlite(): DatabaseSync {
  if (sqlite) return sqlite;
  const DB_PATH = process.env.AEGIS_DB_PATH ?? './data/aegislink.db';
  mkdirSync(dirname(DB_PATH), { recursive: true });
  sqlite = new DatabaseSync(DB_PATH);
  sqlite.exec('PRAGMA journal_mode = WAL;');
  sqlite.exec('PRAGMA foreign_keys = ON;');
  initSqliteSchema(sqlite);
  return sqlite;
}

/** Close the active SQLite handle and reset module state. Idempotent. */
export function closeSqlite(): void {
  try { sqlite?.close(); } catch { /* already closed */ }
  sqlite = null;
}

export function initSqliteSchema(db: DatabaseSync) {
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
      sender_pub_b64 TEXT,
      epk_b64        TEXT
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

    -- Sealed-sender (Phase 1): the recipient registers ONLY the hash of their
    -- delivery token; senders present the raw token to submit a sealed envelope
    -- without authenticating as a sender. The relay never stores the raw token
    -- and never learns the sender. See docs/SEALED-SENDER-ARCHITECTURE.md §3.3.
    CREATE TABLE IF NOT EXISTS delivery_tokens (
      aegis_id       TEXT PRIMARY KEY,
      token_hash_b64 TEXT NOT NULL,
      updated_at     INTEGER NOT NULL
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
      device_id      TEXT NOT NULL DEFAULT 'default',
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (aegis_id, device_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS prekeys_pq_signed (
      aegis_id       TEXT NOT NULL,
      device_id      TEXT NOT NULL DEFAULT 'default',
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      signature_b64  TEXT NOT NULL,
      created_at     INTEGER NOT NULL,
      PRIMARY KEY (aegis_id, device_id)
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

    CREATE TABLE IF NOT EXISTS backups (
      id_hash    TEXT PRIMARY KEY,
      envelope   TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sender_key_dist_queue (
      id              TEXT PRIMARY KEY,
      recipient       TEXT NOT NULL,
      group_id        TEXT NOT NULL,
      sender_aegis_id TEXT NOT NULL,
      ciphertext_b64  TEXT NOT NULL,
      nonce_b64       TEXT NOT NULL,
      iteration       INTEGER NOT NULL,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      drained_by      TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_skdq_recipient
      ON sender_key_dist_queue(recipient, created_at);

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

    -- B-5: Work channel bodies are E2EE ciphertext (M-6). Indexing ciphertext in
    -- FTS is useless (no plaintext term ever matches) and needlessly duplicates
    -- ciphertext at-rest, so the triggers index an EMPTY body. Full-text search
    -- over E2EE content is done client-side after decryption. Body is stored as
    -- '' on both insert and delete so the external-content FTS index stays
    -- consistent (delete must replay the same value that was indexed).
    CREATE TRIGGER IF NOT EXISTS work_messages_ai AFTER INSERT ON work_messages BEGIN
      INSERT INTO work_messages_fts(rowid, id, body, sender_id, channel_id, org_id)
      VALUES (new.rowid, new.id, '', new.sender_id, new.channel_id, new.org_id);
    END;

    CREATE TRIGGER IF NOT EXISTS work_messages_ad AFTER DELETE ON work_messages BEGIN
      INSERT INTO work_messages_fts(work_messages_fts, rowid, id, body, sender_id, channel_id, org_id)
      VALUES('delete', old.rowid, old.id, '', old.sender_id, old.channel_id, old.org_id);
    END;

    CREATE TRIGGER IF NOT EXISTS work_messages_au AFTER UPDATE ON work_messages BEGIN
      INSERT INTO work_messages_fts(work_messages_fts, rowid, id, body, sender_id, channel_id, org_id)
      VALUES('delete', old.rowid, old.id, '', old.sender_id, old.channel_id, old.org_id);
      INSERT INTO work_messages_fts(rowid, id, body, sender_id, channel_id, org_id)
      VALUES (new.rowid, new.id, '', new.sender_id, new.channel_id, new.org_id);
    END;

    -- ── Public Channels (Phase 1, docs/SEALED-PUBLIC-CHANNELS.md) ──────────
    CREATE TABLE IF NOT EXISTS public_channels (
      channel_id              TEXT PRIMARY KEY,
      signed_manifest_blob    TEXT NOT NULL,
      delivery_token_hash_b64 TEXT NOT NULL,
      channel_type            TEXT NOT NULL DEFAULT 'open',
      content_key_envelope    TEXT NOT NULL DEFAULT '',
      created_at              INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS public_channel_posts (
      id              TEXT PRIMARY KEY,
      channel_id      TEXT NOT NULL,
      seq_num         INTEGER NOT NULL,
      ciphertext_b64  TEXT NOT NULL,
      nonce_b64       TEXT NOT NULL,
      post_hash_b64   TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_public_channel_posts_channel_seq
      ON public_channel_posts(channel_id, seq_num);

    CREATE TABLE IF NOT EXISTS public_channel_pending_joins (
      join_pubkey_b64 TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      created_at      INTEGER NOT NULL,
      expires_at      INTEGER NOT NULL,
      PRIMARY KEY (join_pubkey_b64, channel_id)
    );
  `);

  // Schema migrations for existing deployments
  // Slice 2 — channel avatars: stores the blob ID (from blob store) associated
  // with the channel's public avatar. Nullable — absence means no avatar set.
  try { db.exec(`ALTER TABLE public_channels ADD COLUMN avatar_blob_id TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE identities ADD COLUMN signing_public_key_b64 TEXT NOT NULL DEFAULT '';`); } catch { /* exists */ }
  // Sealed public channels: the wrapped CEK envelope a joiner unwraps with the
  // capability (docs §4.2/§10.1). Added after Phase 1 shipped the table.
  try { db.exec(`ALTER TABLE public_channels ADD COLUMN content_key_envelope TEXT NOT NULL DEFAULT '';`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN expires_at INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages DROP COLUMN sender;`); } catch { /* absent */ }
  // C-3 (security roadmap Ola 2): the SenderKey chain key must never be persisted
  // by the relay. Drop the legacy plaintext column from existing deployments.
  try { db.exec(`ALTER TABLE sender_key_dist_queue DROP COLUMN chain_key_b64;`); } catch { /* absent */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN drained_by TEXT NOT NULL DEFAULT '[]';`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN sender_pub_b64 TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE messages ADD COLUMN epk_b64 TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE prekeys_signed ADD COLUMN device_id TEXT NOT NULL DEFAULT 'default';`); } catch { /* exists */ }
  // M-2: prekeys_onetime per-device. Old PK was (aegis_id, key_id); SQLite can't
  // change a PK in place, and OPKs are ephemeral (clients re-upload on reconnect),
  // so when device_id is absent we drop+recreate with PK (aegis_id, device_id,
  // key_id). Guarded by PRAGMA so it runs at most once.
  try {
    const cols = db.prepare(`PRAGMA table_info(prekeys_onetime)`).all() as Array<{ name: string }>;
    if (cols.length > 0 && !cols.some((c) => c.name === 'device_id')) {
      db.exec(`DROP TABLE prekeys_onetime;`);
      db.exec(`
        CREATE TABLE prekeys_onetime (
          aegis_id       TEXT NOT NULL,
          device_id      TEXT NOT NULL DEFAULT 'default',
          key_id         INTEGER NOT NULL,
          public_key_b64 TEXT NOT NULL,
          created_at     INTEGER NOT NULL,
          PRIMARY KEY (aegis_id, device_id, key_id)
        );
      `);
    }
  } catch { /* table absent or already migrated */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN pinned_by TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN pinned_at TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN parent_id TEXT;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  try { db.exec(`ALTER TABLE work_messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0;`); } catch { /* exists */ }
  // B-5: recreate the FTS triggers so they index an EMPTY body (E2EE ciphertext
  // must never enter the FTS index). Existing deployments already have the old
  // triggers, and CREATE TRIGGER IF NOT EXISTS won't replace them — so drop and
  // recreate. Also rebuild the index to evict any ciphertext indexed previously.
  try {
    db.exec(`
      DROP TRIGGER IF EXISTS work_messages_ai;
      DROP TRIGGER IF EXISTS work_messages_ad;
      DROP TRIGGER IF EXISTS work_messages_au;
      CREATE TRIGGER work_messages_ai AFTER INSERT ON work_messages BEGIN
        INSERT INTO work_messages_fts(rowid, id, body, sender_id, channel_id, org_id)
        VALUES (new.rowid, new.id, '', new.sender_id, new.channel_id, new.org_id);
      END;
      CREATE TRIGGER work_messages_ad AFTER DELETE ON work_messages BEGIN
        INSERT INTO work_messages_fts(work_messages_fts, rowid, id, body, sender_id, channel_id, org_id)
        VALUES('delete', old.rowid, old.id, '', old.sender_id, old.channel_id, old.org_id);
      END;
      CREATE TRIGGER work_messages_au AFTER UPDATE ON work_messages BEGIN
        INSERT INTO work_messages_fts(work_messages_fts, rowid, id, body, sender_id, channel_id, org_id)
        VALUES('delete', old.rowid, old.id, '', old.sender_id, old.channel_id, old.org_id);
        INSERT INTO work_messages_fts(rowid, id, body, sender_id, channel_id, org_id)
        VALUES (new.rowid, new.id, '', new.sender_id, new.channel_id, new.org_id);
      END;
    `);
    // Clear any previously-indexed ciphertext bodies. NOTE: do NOT 'rebuild' — on
    // an external-content FTS5 table that re-reads work_messages.body directly
    // (bypassing the triggers), re-indexing the very ciphertext we want gone.
    try { db.exec(`INSERT INTO work_messages_fts(work_messages_fts) VALUES('delete-all');`); } catch { /* fts table may not exist on very old DBs */ }
  } catch { /* triggers/fts absent on older schema — created fresh above */ }
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
