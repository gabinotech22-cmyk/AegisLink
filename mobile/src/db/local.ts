import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';
import * as FileSystem from 'expo-file-system/legacy';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';

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
  return slot === 'self' ? 'aegis.secretKey.b64' : `aegis.${slot}.secretKey.b64`;
}

export function getSignSecretKeySlot(slot = activeSlot): string {
  return slot === 'self' ? 'aegis.signSecretKey.b64' : `aegis.${slot}.signSecretKey.b64`;
}

export function getDbEncKeySlot(slot = activeSlot): string {
  return slot === 'self' ? 'aegis.dbEncKey.b64' : `aegis.${slot}.dbEncKey.b64`;
}

export function setActiveDbSlot(slot: string): void {
  activeSlot = slot;
  dbPromise = null;
  cachedDbKey = null;
}

export async function closeActiveDatabase(): Promise<void> {
  if (dbPromise) {
    const d = await dbPromise;
    await d.closeAsync();
    dbPromise = null;
    cachedDbKey = null;
  }
}

export async function deleteIdentitySlot(slot: string): Promise<void> {
  // 1. Delete credentials and E2EE keys
  await SecureStore.deleteItemAsync(getSecretKeySlot(slot)).catch(() => {});
  await SecureStore.deleteItemAsync(getSignSecretKeySlot(slot)).catch(() => {});
  await SecureStore.deleteItemAsync(getDbEncKeySlot(slot)).catch(() => {});

  // 2. Delete preferences for this slot
  const prefKeys = [
    'activeProfile',
    'displayName',
    'avatarColor',
    'avatarImage',
    'profileStatus',
    'workDisplayName',
    'workAvatarColor',
    'workAvatarImage',
    'workProfileStatus',
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

async function db(): Promise<SQLite.SQLiteDatabase> {
  if (!dbPromise) {
    const dbName = activeSlot === 'self' ? 'aegislink.db' : `aegislink_${activeSlot}.db`;
    dbPromise = SQLite.openDatabaseAsync(dbName).then(async (d) => {
      await d.execAsync(`
        PRAGMA journal_mode = WAL;

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
      return d;
    });
  }
  return dbPromise;
}

// ─── Identity ────────────────────────────────────────────────────────────────

export async function saveIdentity(v: StoredIdentity): Promise<void> {
  await SecureStore.setItemAsync(getSecretKeySlot(), v.secretKeyB64);
  await SecureStore.setItemAsync(getSignSecretKeySlot(), v.signingSecretKeyB64);
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
  let keyB64 = await SecureStore.getItemAsync(slotKey);
  if (!keyB64) {
    const keyBytes = nacl.randomBytes(32);
    keyB64 = encodeBase64(keyBytes);
    await SecureStore.setItemAsync(slotKey, keyB64);
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
    return body;
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
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status
     FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
    chatId
  );
  return Promise.all(rows.map(async (r) => await rowToMessage(r, await decryptBody(r.body))));
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  const d = await db();
  const row = await d.getFirstAsync<MessageRow>(
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status
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
  // clearIdentity deletes SECRET_KEY_SLOT + SIGN_SECRET_KEY_SLOT and the identity table row.
  await clearIdentity();
  // Also purge the at-rest DB encryption key so recovered storage cannot be decrypted.
  cachedDbKey = null;
  await SecureStore.deleteItemAsync(getDbEncKeySlot());
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

// ─── Ephemeral cleanup ────────────────────────────────────────────────────────

export async function deleteExpiredMessages(timerSeconds: number): Promise<void> {
  const d = await db();
  const now = Date.now();
  // 1. Delete explicitly expired messages (location/ephemeral)
  await d.runAsync(
    'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?',
    now
  );

  // 2. Delete traditional global ephemeral messages if applicable
  if (timerSeconds > 0) {
    const cutoff = now - timerSeconds * 1000;
    await d.runAsync(
      'DELETE FROM messages WHERE created_at < ? AND expires_at IS NULL AND deleted = 0',
      cutoff
    );
  }
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
