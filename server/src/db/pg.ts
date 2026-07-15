/**
 * AegisLink — PostgreSQL backend (production)
 *
 * Extracted from db/client.ts (M4 god-file split). Pure relocation: no logic,
 * SQL, or behavior changes. Selected when DATABASE_URL is a postgres:// URL.
 */

import pg from 'pg';
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL ?? '';

let pgPool: pg.Pool | null = null;

export function getPool(): pg.Pool {
  if (pgPool) return pgPool;
  pgPool = new Pool({ connectionString: DATABASE_URL });
  return pgPool;
}

/** Close the active PG pool and reset module state. Idempotent. */
export async function closePg(): Promise<void> {
  if (pgPool) {
    try { await pgPool.end(); } catch { /* already ended */ }
    pgPool = null;
  }
}

export async function initPgSchema(): Promise<void> {
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
      sender_pub_b64 TEXT,
      epk_b64        TEXT
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

    -- iOS VoIP (PushKit) tokens — see SQLite schema above for rationale.
    CREATE TABLE IF NOT EXISTS voip_tokens (
      aegis_id    TEXT NOT NULL,
      voip_token  TEXT NOT NULL,
      updated_at  BIGINT NOT NULL,
      PRIMARY KEY (aegis_id, voip_token)
    );

    -- Sealed-sender (Phase 1) — see SQLite schema above for rationale.
    CREATE TABLE IF NOT EXISTS delivery_tokens (
      aegis_id       TEXT PRIMARY KEY,
      token_hash_b64 TEXT NOT NULL,
      updated_at     BIGINT NOT NULL
    );

    -- Slice 2b.3b: UnifiedPush endpoint per mailbox id — see SQLite schema.
    CREATE TABLE IF NOT EXISTS push_endpoints (
      mailbox_id TEXT PRIMARY KEY,
      endpoint   TEXT NOT NULL,
      updated_at BIGINT NOT NULL
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
      device_id      TEXT NOT NULL DEFAULT 'default',
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      created_at     BIGINT NOT NULL,
      PRIMARY KEY (aegis_id, device_id, key_id)
    );

    CREATE TABLE IF NOT EXISTS prekeys_pq_signed (
      aegis_id       TEXT NOT NULL,
      device_id      TEXT NOT NULL DEFAULT 'default',
      key_id         INTEGER NOT NULL,
      public_key_b64 TEXT NOT NULL,
      signature_b64  TEXT NOT NULL,
      created_at     BIGINT NOT NULL,
      PRIMARY KEY (aegis_id, device_id)
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

    CREATE TABLE IF NOT EXISTS backups (
      id_hash    TEXT PRIMARY KEY,
      envelope   TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sender_key_dist_queue (
      id              TEXT PRIMARY KEY,
      recipient       TEXT NOT NULL,
      group_id        TEXT NOT NULL,
      sender_aegis_id TEXT NOT NULL,
      ciphertext_b64  TEXT NOT NULL,
      nonce_b64       TEXT NOT NULL,
      iteration       INTEGER NOT NULL,
      created_at      BIGINT NOT NULL,
      expires_at      BIGINT NOT NULL,
      drained_by      TEXT NOT NULL DEFAULT '[]'
    );

    CREATE INDEX IF NOT EXISTS idx_skdq_recipient
      ON sender_key_dist_queue(recipient, created_at);

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

    -- ── Public Channels (Phase 1, docs/SEALED-PUBLIC-CHANNELS.md) ──────────
    CREATE TABLE IF NOT EXISTS public_channels (
      channel_id              TEXT PRIMARY KEY,
      signed_manifest_blob    TEXT NOT NULL,
      delivery_token_hash_b64 TEXT NOT NULL,
      channel_type            TEXT NOT NULL DEFAULT 'open',
      content_key_envelope    TEXT NOT NULL DEFAULT '',
      created_at              BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS public_channel_posts (
      id              TEXT PRIMARY KEY,
      channel_id      TEXT NOT NULL,
      seq_num         INTEGER NOT NULL,
      ciphertext_b64  TEXT NOT NULL,
      nonce_b64       TEXT NOT NULL,
      post_hash_b64   TEXT NOT NULL,
      created_at      BIGINT NOT NULL,
      expires_at      BIGINT NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_public_channel_posts_channel_seq
      ON public_channel_posts(channel_id, seq_num);

    CREATE TABLE IF NOT EXISTS public_channel_pending_joins (
      join_pubkey_b64 TEXT NOT NULL,
      channel_id      TEXT NOT NULL,
      created_at      BIGINT NOT NULL,
      expires_at      BIGINT NOT NULL,
      PRIMARY KEY (join_pubkey_b64, channel_id)
    );
  `);

  // ── PG migrations (safe to run repeatedly) ─────────────────────────────────
  // These mirror the SQLite ALTER TABLE migrations below. Existing deployments
  // may have tables from an older schema that lack newer columns. Each statement
  // is wrapped in a DO block so it's a no-op when the column already exists.
  const pgMigrations = [
    `ALTER TABLE public_channels ADD COLUMN content_key_envelope TEXT NOT NULL DEFAULT ''`, // sealed channels CEK envelope
    `ALTER TABLE public_channel_pending_joins ADD COLUMN approval_envelope TEXT`, // Phase 4 approval flow: owner-sealed capability

    `ALTER TABLE prekeys_signed ADD COLUMN device_id TEXT NOT NULL DEFAULT 'default'`,
    `ALTER TABLE prekeys_onetime ADD COLUMN device_id TEXT NOT NULL DEFAULT 'default'`, // M-2

    `ALTER TABLE messages ADD COLUMN drained_by TEXT NOT NULL DEFAULT '[]'`,
    `ALTER TABLE messages ADD COLUMN sender_pub_b64 TEXT`,
    `ALTER TABLE messages ADD COLUMN epk_b64 TEXT`,
    `ALTER TABLE work_messages ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE work_messages ADD COLUMN pinned_by TEXT`,
    `ALTER TABLE work_messages ADD COLUMN pinned_at TEXT`,
    `ALTER TABLE work_messages ADD COLUMN parent_id TEXT`,
    `ALTER TABLE work_messages ADD COLUMN reply_count INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE work_messages ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE work_orgs ADD COLUMN display_name TEXT`,
    `ALTER TABLE work_orgs ADD COLUMN invite_policy TEXT NOT NULL DEFAULT 'invite_only'`,
    `ALTER TABLE work_channels ADD COLUMN retention_days INTEGER`,
    // C-3 (security roadmap Ola 2): drop the legacy plaintext SenderKey chain key.
    `ALTER TABLE sender_key_dist_queue DROP COLUMN IF EXISTS chain_key_b64`,
    // Slice 2 — channel avatars
    `ALTER TABLE public_channels ADD COLUMN avatar_blob_id TEXT`,
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

  // M-2: same PK fix for prekeys_onetime. Old PK was (aegis_id, key_id); the new
  // PK is (aegis_id, device_id, key_id). Existing rows keep device_id='default'
  // (self-consistent with the 'default' SPK uploaded at onboarding).
  try {
    await pool.query(`ALTER TABLE prekeys_onetime DROP CONSTRAINT IF EXISTS prekeys_onetime_pkey`);
    await pool.query(`ALTER TABLE prekeys_onetime ADD PRIMARY KEY (aegis_id, device_id, key_id)`);
  } catch { /* already correct or concurrent migration — safe to ignore */ }
}
