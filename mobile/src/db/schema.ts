import * as SQLite from 'expo-sqlite';

async function addColumn(d: SQLite.SQLiteDatabase, table: string, colDef: string) {
  try {
    await d.execAsync(`ALTER TABLE ${table} ADD COLUMN ${colDef};`);
  } catch (e: unknown) {
    if (e instanceof Error && e.message.includes('duplicate column name')) return;
    throw e;
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
export async function initSchema(d: SQLite.SQLiteDatabase): Promise<void> {
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
      expires_at      INTEGER,
      sender_id       TEXT
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
      post_meta         TEXT,
      channel_id        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_send_at ON scheduled_messages(send_at, status);

    -- Sealed-channel feed cache: the projected post list per channel, stored as
    -- posts_enc = encryptBody(JSON FeedPost[]). The relay does NOT retain channel
    -- broadcast history forever, and the verified chain head IS persisted, so a
    -- cold launch would delta-pull (since = head) into an empty in-memory feed and
    -- show nothing. This local cache restores the feed on restart; the delta pull
    -- then appends only newer posts. Zero-metadata: only opaque ciphertext at rest.
    CREATE TABLE IF NOT EXISTS channel_feed (
      channel_id TEXT PRIMARY KEY,
      posts_enc  TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

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

    -- Stateless-mailbox-drain pending acks (durable at-least-once, Slice 6).
    -- The stateless Tor drain (mailboxSocket.fetchMailboxOverTor) acks the
    -- envelope ids it persisted on the NEXT fetch, so the relay never deletes a
    -- row before we've stored it. That pending-ack list used to live only in an
    -- in-memory Map: if iOS killed the backgrounded app between "persist" and
    -- "next fetch", the acks were lost and the server queue kept redelivering.
    -- Persisting the list here makes it survive process death. ack_ids =
    -- encryptBody(JSON string[]) — envelope ids are opaque but still metadata, so
    -- only ciphertext lands on disk (zero-metadata at-rest, golden rule #10).
    CREATE TABLE IF NOT EXISTS mailbox_pending_acks (
      mailbox_id TEXT PRIMARY KEY,
      ack_ids    TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // ─── Schema versioning via PRAGMA user_version ──────────────────────────
  // Bump USER_DB_VERSION whenever a migration must run on existing installs.
  const USER_DB_VERSION = 13;
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
    await addColumn(d, 'messages', "delivery_status TEXT NOT NULL DEFAULT 'sent';");
    await d.execAsync('PRAGMA user_version = 2');
  }

  if (currentVersion < 3) {
    // v2 → v3: add admin/permission columns to groups table.
    // The CREATE TABLE above includes these for fresh installs; here we patch
    // existing databases that were created with the old 6-column schema.
    // Each ALTER is wrapped individually — "duplicate column name" means the
    // column already exists (e.g. from an earlier unconditional migration run),
    // which is harmless and should be silently ignored.
    await addColumn(d, 'groups', 'admin_only_invite INTEGER NOT NULL DEFAULT 1;');
    await addColumn(d, 'groups', 'moderate_new_members INTEGER NOT NULL DEFAULT 0;');
    await addColumn(d, 'groups', 'admin_id TEXT;');
    await addColumn(d, 'groups', 'admin_sig TEXT;');
    await d.execAsync('PRAGMA user_version = 3');
  }

  if (currentVersion < 4) {
    // v3 → v4: add moderators column (JSON array of aegisIds).
    // Fresh installs already have this column via CREATE TABLE above.
    await addColumn(d, 'groups', 'moderators TEXT;');
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
    await addColumn(d, 'scheduled_messages', 'group_id TEXT;');
    await addColumn(d, 'scheduled_messages', 'post_meta TEXT;');
    await d.execAsync('PRAGMA user_version = 7');
  }

  if (currentVersion < 8) {
    // v7 → v8: add roster_version to groups (monotonic counter for the
    // by-reference roster of large groups — aegis.group.v2). Fresh installs
    // already have the column via CREATE TABLE above. NULL means "legacy /
    // unset" and is treated as version 1 by readers.
    await addColumn(d, 'groups', 'roster_version INTEGER;');
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
    await addColumn(d, 'groups', 'permissions TEXT;');
    await addColumn(d, 'groups', 'gov_sig TEXT;');
    await addColumn(d, 'groups', 'gov_version INTEGER;');
    await d.execAsync('PRAGMA user_version = 9');
  }

  if (currentVersion < 10) {
    // v9 → v10: add pending flag to groups (unaccepted group invitations, see
    // requireGroupApproval). Fresh installs already have the column via CREATE
    // TABLE above. NULL on existing rows → treated as not pending (joined).
    await addColumn(d, 'groups', 'pending INTEGER;');
    await d.execAsync('PRAGMA user_version = 10');
  }

  if (currentVersion < 11) {
    // v10 → v11: add channel_id to scheduled_messages (scheduled channel posts).
    // Fresh installs already have the column via CREATE TABLE above.
    await addColumn(d, 'scheduled_messages', 'channel_id TEXT;');
    await d.execAsync('PRAGMA user_version = 11');
  }

  if (currentVersion < 12) {
    // v11 → v12: add sender_id to messages (native group-chat sender attribution).
    // Replaces the fragile body-prefix parsing ("Name: text") with a dedicated
    // column populated from the authenticated E2EE envelope. Fresh installs
    // already have the column via CREATE TABLE above. NULL on old rows →
    // GroupBubble falls back to legacy body parsing for backwards compat.
    await addColumn(d, 'messages', 'sender_id TEXT;');
    await d.execAsync('PRAGMA user_version = 12');
  }

  if (currentVersion < 13) {
    // v12 → v13: add mailbox_pending_acks table (durable at-least-once acks for
    // the stateless Tor mailbox drain — survives an iOS app-kill between persist
    // and next fetch). Brand-new table already created by the CREATE TABLE IF NOT
    // EXISTS block above for fresh installs; this branch just bumps the version
    // for existing installs. No ALTER / data migration needed.
    await d.execAsync('PRAGMA user_version = 13');
  }

  // Suppress USER_DB_VERSION "unused" warning — the constant documents intent.
  void USER_DB_VERSION;

  // Database migrations: Alter tables safely to append optional columns on existing installs
  await addColumn(d, 'contacts', 'signing_public_key_b64 TEXT DEFAULT "";');
  await addColumn(d, 'contacts', 'color TEXT;');
  await addColumn(d, 'contacts', 'avatar_image TEXT;');

  await addColumn(d, 'groups', 'avatar_color TEXT;');
  await addColumn(d, 'groups', 'avatar_image TEXT;');
  // Contact capabilities (mute, zero-trust mode, status, block)
  await addColumn(d, 'contacts', 'muted INTEGER NOT NULL DEFAULT 0;');
  await addColumn(d, 'contacts', 'zero_trust INTEGER NOT NULL DEFAULT 0;');
  await addColumn(d, 'contacts', 'status TEXT;');
  await addColumn(d, 'contacts', 'muted_until INTEGER;');
  await addColumn(d, 'contacts', 'blocked INTEGER NOT NULL DEFAULT 0;');
  await addColumn(d, 'contacts', 'archived INTEGER NOT NULL DEFAULT 0;');
  await addColumn(d, 'contacts', "profile TEXT NOT NULL DEFAULT 'personal';");
  await addColumn(d, 'contacts', 'pinned INTEGER NOT NULL DEFAULT 0;');
  // `hidden` = chat removed from the list but contact kept (reappears on next
  // message). Distinct from `archived` (moved to the archived section).
  await addColumn(d, 'contacts', 'hidden INTEGER NOT NULL DEFAULT 0;');
  await addColumn(d, 'contacts', 'last_seen_at INTEGER;');
  await addColumn(d, 'contacts', 'online INTEGER NOT NULL DEFAULT 0;');
  // `pending` = auto-added from an unknown incoming sender (message request).
  // The chat opens in "accept/block/delete" mode and sending is gated until the
  // user accepts — a stranger never lands directly in a normal thread.
  await addColumn(d, 'contacts', 'pending INTEGER NOT NULL DEFAULT 0;');

  // Message capabilities (replies, reactions, star, delete, media)
  await addColumn(d, 'messages', 'type TEXT;');
  await addColumn(d, 'messages', 'media_uri TEXT;');
  await addColumn(d, 'messages', 'reply_to_id TEXT;');
  await addColumn(d, 'messages', 'reactions TEXT;');
  await addColumn(d, 'messages', 'starred INTEGER NOT NULL DEFAULT 0;');
  await addColumn(d, 'messages', 'deleted INTEGER NOT NULL DEFAULT 0;');
  await addColumn(d, 'messages', 'pinned INTEGER NOT NULL DEFAULT 0;');
  await addColumn(d, 'messages', 'expires_at INTEGER;');
  await addColumn(d, 'messages', 'attachments TEXT;');
  await addColumn(d, 'messages', 'sender_id TEXT;');
  await addColumn(d, 'chat_state', 'ephemeral_timer INTEGER NOT NULL DEFAULT 0;');
}
