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

  // 3. Delete SQLite files
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
    dbPromise = SQLite.openDatabaseAsync(dbName).then(async (d) => {
      // Run PRAGMAs in isolation — mixing PRAGMA + DDL in one execAsync call
      // crashes on Android 14 with New Architecture (expo-sqlite v16 JSI).
      await d.execAsync('PRAGMA journal_mode = WAL;');
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
          id           TEXT PRIMARY KEY,
          name         TEXT NOT NULL,
          members      TEXT NOT NULL, -- JSON array of contact aegisIds
          created_at   INTEGER NOT NULL,
          avatar_color TEXT,
          avatar_image TEXT
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
      `);

      // ─── Schema versioning via PRAGMA user_version ──────────────────────────
      // Bump USER_DB_VERSION whenever a migration must run on existing installs.
      const USER_DB_VERSION = 2;
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
      try {
        await d.execAsync('ALTER TABLE groups ADD COLUMN admin_only_invite INTEGER NOT NULL DEFAULT 1;');
      } catch (e) {}
      try {
        await d.execAsync('ALTER TABLE groups ADD COLUMN moderate_new_members INTEGER NOT NULL DEFAULT 0;');
      } catch (e) {}
      try {
        await d.execAsync('ALTER TABLE groups ADD COLUMN admin_id TEXT;');
      } catch (e) {}
      try {
        await d.execAsync('ALTER TABLE groups ADD COLUMN admin_sig TEXT;');
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
  const d = await db();
  await d.runAsync(
    `INSERT OR REPLACE INTO identity (slot, aegis_id, public_key_b64, signing_public_key_b64, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    activeSlot,
    v.aegisId,
    v.publicKeyB64,
    v.signingPublicKeyB64,
    v.createdAt
  );
}

export async function loadIdentity(): Promise<StoredIdentity | null> {
  const secretKeyB64 = await SecureStore.getItemAsync(getSecretKeySlot());
  const signingSecretKeyB64 = await SecureStore.getItemAsync(getSignSecretKeySlot());
  if (!secretKeyB64 || !signingSecretKeyB64) return null;
  const d = await db();
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
    secretKeyB64,
    signingPublicKeyB64: row.signing_public_key_b64,
    signingSecretKeyB64,
    createdAt: row.created_at,
  };
}

export async function clearIdentity(): Promise<void> {
  await SecureStore.deleteItemAsync(getSecretKeySlot());
  await SecureStore.deleteItemAsync(getSignSecretKeySlot());
  const d = await db();
  await d.execAsync(
    `DELETE FROM identity;
     DELETE FROM contacts;
     DELETE FROM messages;
     DELETE FROM ratchet_sessions;
     DELETE FROM groups;
     DELETE FROM chat_state;
     DELETE FROM call_history;`
  );
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
  const d = await db();
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
}

export async function pinContact(aegisId: string, pinned: boolean): Promise<void> {
  const d = await db();
  await d.runAsync('UPDATE contacts SET pinned = ? WHERE aegis_id = ?', pinned ? 1 : 0, aegisId);
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
  const d = await db();
  const rows = profile
    ? await d.getAllAsync<ContactRow>(
        `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online FROM contacts WHERE profile = ? ORDER BY added_at DESC`,
        profile
      )
    : await d.getAllAsync<ContactRow>(
        `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online FROM contacts ORDER BY added_at DESC`
      );
  return rows.map(rowToContact);
}

export async function getContact(aegisId: string): Promise<StoredContact | null> {
  const d = await db();
  const row = await d.getFirstAsync<ContactRow>(
    `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile, pinned, last_seen_at, online FROM contacts WHERE aegis_id = ?`,
    aegisId
  );
  if (!row) return null;
  return rowToContact(row);
}

export async function deleteContactMessages(chatId: string): Promise<void> {
  const d = await db();
  await d.runAsync('DELETE FROM messages WHERE chat_id = ?', chatId);
}

export async function deleteContactRatchetSession(aegisId: string): Promise<void> {
  const d = await db();
  await d.runAsync('DELETE FROM ratchet_sessions WHERE aegis_id = ?', aegisId);
}

export async function deleteContact(aegisId: string): Promise<void> {
  const d = await db();
  await d.runAsync('DELETE FROM contacts WHERE aegis_id = ?', aegisId);
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

export type MessageType = 'text' | 'image' | 'audio' | 'file' | 'poll' | 'location' | 'view_once';

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
  const d = await db();
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
}

export async function updateMessageDelivery(id: string, status: 'sent' | 'delivered' | 'read'): Promise<void> {
  const d = await db();
  await d.runAsync('UPDATE messages SET delivery_status = ? WHERE id = ?', status, id);
}

export async function loadMessagesByChat(chatId: string): Promise<StoredMessage[]> {
  const d = await db();
  const rows = await d.getAllAsync<MessageRow>(
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
     FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
    chatId
  );
  return Promise.all(rows.map(async (r) => await rowToMessage(r, await decryptBody(r.body))));
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  const d = await db();
  const row = await d.getFirstAsync<MessageRow>(
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
     FROM messages WHERE id = ?`,
    id
  );
  if (!row) return null;
  return await rowToMessage(row, await decryptBody(row.body));
}

export async function setMessagePinned(id: string, pinned: boolean): Promise<void> {
  const d = await db();
  await d.runAsync(`UPDATE messages SET pinned = ? WHERE id = ?`, pinned ? 1 : 0, id);
}

export async function getPinnedMessage(chatId: string): Promise<StoredMessage | null> {
  const d = await db();
  const row = await d.getFirstAsync<MessageRow>(
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status
     FROM messages WHERE chat_id = ? AND pinned = 1 ORDER BY created_at DESC LIMIT 1`,
    chatId
  );
  if (!row) return null;
  return await rowToMessage(row, await decryptBody(row.body));
}

export async function setMessageStarred(id: string, starred: boolean): Promise<void> {
  const d = await db();
  await d.runAsync(`UPDATE messages SET starred = ? WHERE id = ?`, starred ? 1 : 0, id);
}

export async function setMessageDeleted(id: string): Promise<void> {
  const d = await db();
  // Soft delete: keep row, clear body, mark deleted
  const empty = await encryptBody('');
  await d.runAsync(
    `UPDATE messages SET deleted = 1, body = ?, media_uri = NULL WHERE id = ?`,
    empty,
    id
  );
}

export async function setMessageReactions(id: string, reactions: MessageReactions): Promise<void> {
  const d = await db();
  await d.runAsync(`UPDATE messages SET reactions = ? WHERE id = ?`, JSON.stringify(reactions), id);
}

export async function lastMessageByChat(chatId: string): Promise<StoredMessage | null> {
  const d = await db();
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
}

// ─── Double Ratchet State ──────────────────────────────────────────────────────

export interface StoredRatchetSession {
  aegisId: string;
  stateJson: string;
}

export async function saveRatchetSession(aegisId: string, stateJson: string): Promise<void> {
  const d = await db();
  const encrypted = await encryptBody(stateJson);
  await d.runAsync(
    `INSERT OR REPLACE INTO ratchet_sessions (aegis_id, state_json) VALUES (?, ?)`,
    aegisId,
    encrypted
  );
}

export async function loadRatchetSession(aegisId: string): Promise<string | null> {
  const d = await db();
  const row = await d.getFirstAsync<{ state_json: string }>(
    `SELECT state_json FROM ratchet_sessions WHERE aegis_id = ?`,
    aegisId
  );
  if (!row) return null;
  return decryptBody(row.state_json);
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
  const d = await db();
  await d.runAsync(
    `INSERT OR REPLACE INTO groups (id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    g.id,
    g.name,
    JSON.stringify(g.members),
    g.createdAt,
    g.avatarColor || null,
    g.avatarImage || null,
    g.adminOnlyInvite !== false ? 1 : 0,
    g.moderateNewMembers ? 1 : 0,
    g.adminId ?? null,
    g.adminSig ?? null
  );
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
  };
}

export async function loadGroups(): Promise<StoredGroup[]> {
  const d = await db();
  const rows = await d.getAllAsync<GroupRow>(
    `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig FROM groups ORDER BY created_at DESC`
  );
  return rows.map(rowToGroup);
}

export async function deleteGroup(id: string): Promise<void> {
  const d = await db();
  await d.runAsync('DELETE FROM groups WHERE id = ?', id);
}

export async function getGroup(id: string): Promise<StoredGroup | null> {
  const d = await db();
  const row = await d.getFirstAsync<GroupRow>(
    `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig FROM groups WHERE id = ?`,
    id
  );
  if (!row) return null;
  return rowToGroup(row);
}

export async function wipeDatabase(): Promise<void> {
  const d = await db();
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
  // Purge forensic remnants: panic config + user preferences.
  // Without this, a post-wipe forensic analysis could detect that a panic-enabled account existed.
  await SecureStore.deleteItemAsync('aegis.panic.v1').catch(() => {});
  await SecureStore.deleteItemAsync('aegis.preferences.v1').catch(() => {});
  await SecureStore.deleteItemAsync('aegis.polls.v1').catch(() => {});
}

// ─── Chat state (draft + unread) ─────────────────────────────────────────────

export async function getChatState(chatId: string): Promise<{ draft: string | null; unreadCount: number }> {
  const d = await db();
  const row = await d.getFirstAsync<{ draft: string | null; unread_count: number }>(
    'SELECT draft, unread_count FROM chat_state WHERE chat_id = ?', chatId
  );
  if (!row) return { draft: null, unreadCount: 0 };
  const decryptedDraft = row.draft ? await decryptBody(row.draft) : null;
  return { draft: decryptedDraft, unreadCount: row.unread_count };
}

export async function setChatDraft(chatId: string, draft: string | null): Promise<void> {
  const d = await db();
  const encrypted = draft ? await encryptBody(draft) : null;
  await d.runAsync(
    'INSERT OR REPLACE INTO chat_state (chat_id, draft, unread_count) VALUES (?, ?, COALESCE((SELECT unread_count FROM chat_state WHERE chat_id = ?), 0))',
    chatId, encrypted, chatId
  );
}

export async function incrementUnread(chatId: string): Promise<void> {
  const d = await db();
  await d.runAsync(
    'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET unread_count = unread_count + 1',
    chatId
  );
}

export async function resetUnread(chatId: string): Promise<void> {
  const d = await db();
  await d.runAsync(
    'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 0) ON CONFLICT(chat_id) DO UPDATE SET unread_count = 0',
    chatId
  );
}

export async function deleteChatState(chatId: string): Promise<void> {
  const d = await db();
  await d.runAsync('DELETE FROM chat_state WHERE chat_id = ?', chatId);
}

export async function getAllUnreadCounts(): Promise<Record<string, number>> {
  const d = await db();
  const rows = await d.getAllAsync<{ chat_id: string; unread_count: number }>(
    'SELECT chat_id, unread_count FROM chat_state WHERE unread_count > 0'
  );
  const result: Record<string, number> = {};
  for (const r of rows) result[r.chat_id] = r.unread_count;
  return result;
}

// ─── Per-chat ephemeral timer ─────────────────────────────────────────────────

export async function setChatEphemeralTimer(chatId: string, seconds: number): Promise<void> {
  const d = await db();
  await d.runAsync(
    `INSERT INTO chat_state (chat_id, ephemeral_timer, unread_count)
     VALUES (?, ?, COALESCE((SELECT unread_count FROM chat_state WHERE chat_id = ?), 0))
     ON CONFLICT(chat_id) DO UPDATE SET ephemeral_timer = excluded.ephemeral_timer`,
    chatId, seconds, chatId
  );
}

export async function getChatEphemeralTimer(chatId: string): Promise<number> {
  const d = await db();
  const row = await d.getFirstAsync<{ ephemeral_timer: number }>(
    'SELECT ephemeral_timer FROM chat_state WHERE chat_id = ?', chatId
  );
  return row?.ephemeral_timer ?? 0;
}

export async function getAllChatEphemeralTimers(): Promise<Record<string, number>> {
  const d = await db();
  const rows = await d.getAllAsync<{ chat_id: string; ephemeral_timer: number }>(
    'SELECT chat_id, ephemeral_timer FROM chat_state WHERE ephemeral_timer > 0'
  );
  const result: Record<string, number> = {};
  for (const r of rows) result[r.chat_id] = r.ephemeral_timer;
  return result;
}

// ─── Ephemeral cleanup ────────────────────────────────────────────────────────

export async function deleteExpiredMessages(_timerSeconds?: number): Promise<void> {
  const d = await db();
  const now = Date.now();
  // Only delete messages that have an explicit expiresAt set and have passed it.
  // The global timer is no longer used — expiresAt is authoritative.
  await d.runAsync(
    'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?',
    now
  );
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
  const d = await db();
  await d.runAsync(
    'INSERT OR REPLACE INTO call_history (id, contact_id, direction, media, status, started_at, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)',
    c.id, c.contactId, c.direction, c.media, c.status, c.startedAt, c.durationS
  );
}

export async function getCallHistory(contactId: string, limit = 50): Promise<StoredCall[]> {
  const d = await db();
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
  const d = await db();
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
}

export async function loadPolls(): Promise<StoredPoll[]> {
  const d = await db();
  const rows = await d.getAllAsync<PollRow>(
    'SELECT id, question, options, votes, created_at, group_id FROM polls ORDER BY created_at DESC'
  );
  return rows.map(rowToPoll);
}

export async function updatePollVotes(id: string, votes: number[]): Promise<void> {
  const d = await db();
  await d.runAsync('UPDATE polls SET votes = ? WHERE id = ?', JSON.stringify(votes), id);
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
  const d = await db();
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
}

export async function loadPendingScheduled(): Promise<StoredScheduledMessage[]> {
  const d = await db();
  const rows = await d.getAllAsync<ScheduledRow>(
    `SELECT id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count
     FROM scheduled_messages WHERE status = 'pending' ORDER BY send_at ASC`,
  );
  return rows.map(rowToScheduled);
}

export async function loadAllScheduled(): Promise<StoredScheduledMessage[]> {
  const d = await db();
  const rows = await d.getAllAsync<ScheduledRow>(
    `SELECT id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count
     FROM scheduled_messages ORDER BY send_at ASC`,
  );
  return rows.map(rowToScheduled);
}

export async function markScheduledSent(id: string): Promise<void> {
  const d = await db();
  await d.runAsync(`UPDATE scheduled_messages SET status = 'sent' WHERE id = ?`, id);
}

export async function markScheduledFailed(id: string, retryCount: number): Promise<void> {
  const d = await db();
  await d.runAsync(
    `UPDATE scheduled_messages SET status = 'failed', retry_count = ? WHERE id = ?`,
    retryCount,
    id,
  );
}

export async function incrementScheduledRetry(id: string, retryCount: number): Promise<void> {
  const d = await db();
  await d.runAsync(
    `UPDATE scheduled_messages SET retry_count = ? WHERE id = ?`,
    retryCount,
    id,
  );
}

export async function deleteScheduled(id: string): Promise<void> {
  const d = await db();
  await d.runAsync(`DELETE FROM scheduled_messages WHERE id = ?`, id);
}
