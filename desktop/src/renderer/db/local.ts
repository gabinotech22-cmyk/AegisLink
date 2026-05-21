/**
 * AegisLink — Desktop local DB (renderer side)
 *
 * Wraps window.aegis.db.* (better-sqlite3 in the Electron main process) to
 * provide the same public API as mobile/src/db/local.ts. The renderer never
 * touches the filesystem or the sqlite library directly — every call goes
 * through the typed IPC bridge defined in src/preload/index.ts.
 *
 * Security model:
 *   - Private keys live in window.aegis.secureStorage (Keychain/Credential
 *     Vault), NEVER in SQLite.
 *   - Bodies stored in SQLite are encrypted at-rest with a per-install
 *     symmetric key (also kept in secureStorage).
 *   - Multi-slot isolation: the main process is expected to keep separate
 *     better-sqlite3 files per slot; this module only tags rows by slot.
 */

import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import '../crypto/ipc-types';

const db = (): Window['aegis']['db'] => window.aegis.db;
const secureStorage = (): Window['aegis']['secureStorage'] => window.aegis.secureStorage;

// ─── Slot management ─────────────────────────────────────────────────────────

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
  schemaPromise = null;
  cachedDbKey = null;
}

export async function closeActiveDatabase(): Promise<void> {
  // Connection lifecycle is owned by the main process; nothing to close here.
  schemaPromise = null;
  cachedDbKey = null;
}

export async function deleteIdentitySlot(slot: string): Promise<void> {
  // Credentials + E2EE keys
  await secureStorage().delete(getSecretKeySlot(slot)).catch(() => {});
  await secureStorage().delete(getSignSecretKeySlot(slot)).catch(() => {});
  await secureStorage().delete(getDbEncKeySlot(slot)).catch(() => {});

  // Preferences scoped to this slot
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
    await secureStorage().delete(`aegis.${slot}.${pk}`).catch(() => {});
  }
  // NOTE: per-slot DB file deletion happens in the main process; expose a
  // dedicated IPC channel if/when full slot isolation is needed on desktop.
}

// ─── Schema ──────────────────────────────────────────────────────────────────

let schemaPromise: Promise<void> | null = null;

async function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db().exec(`
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
          signing_public_key_b64  TEXT NOT NULL DEFAULT '',
          name                    TEXT NOT NULL,
          verified                INTEGER NOT NULL DEFAULT 0,
          added_at                INTEGER NOT NULL,
          color                   TEXT,
          avatar_image            TEXT,
          muted                   INTEGER NOT NULL DEFAULT 0,
          zero_trust              INTEGER NOT NULL DEFAULT 0,
          status                  TEXT,
          muted_until             INTEGER,
          blocked                 INTEGER NOT NULL DEFAULT 0,
          archived                INTEGER NOT NULL DEFAULT 0,
          profile                 TEXT NOT NULL DEFAULT 'personal'
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
          pinned          INTEGER NOT NULL DEFAULT 0,
          delivery_status TEXT NOT NULL DEFAULT 'sent',
          expires_at      INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at);

        CREATE TABLE IF NOT EXISTS ratchet_sessions (
          aegis_id TEXT PRIMARY KEY,
          state_json TEXT NOT NULL
        );

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
          admin_sig             TEXT
        );

        CREATE TABLE IF NOT EXISTS chat_state (
          chat_id      TEXT PRIMARY KEY,
          draft        TEXT,
          unread_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS call_history (
          id          TEXT PRIMARY KEY,
          contact_id  TEXT NOT NULL,
          direction   TEXT NOT NULL,
          media       TEXT NOT NULL,
          status      TEXT NOT NULL,
          started_at  INTEGER NOT NULL,
          duration_s  INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_calls_contact ON call_history(contact_id, started_at);
      `);
    })();
  }
  return schemaPromise;
}

// ─── Identity ────────────────────────────────────────────────────────────────

export interface StoredIdentity {
  aegisId: string;
  publicKeyB64: string;
  secretKeyB64: string;
  signingPublicKeyB64: string;
  signingSecretKeyB64: string;
  createdAt: number;
}

export async function saveIdentity(v: StoredIdentity): Promise<void> {
  await ensureSchema();
  await secureStorage().set(getSecretKeySlot(), v.secretKeyB64);
  await secureStorage().set(getSignSecretKeySlot(), v.signingSecretKeyB64);
  await db().run(
    `INSERT OR REPLACE INTO identity (slot, aegis_id, public_key_b64, signing_public_key_b64, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [activeSlot, v.aegisId, v.publicKeyB64, v.signingPublicKeyB64, v.createdAt],
  );
}

export async function loadIdentity(): Promise<StoredIdentity | null> {
  await ensureSchema();
  const secretKeyB64 = await secureStorage().get(getSecretKeySlot());
  const signingSecretKeyB64 = await secureStorage().get(getSignSecretKeySlot());
  if (!secretKeyB64 || !signingSecretKeyB64) return null;
  const row = (await db().get(
    `SELECT aegis_id, public_key_b64, signing_public_key_b64, created_at FROM identity WHERE slot = ?`,
    [activeSlot],
  )) as
    | {
        aegis_id: string;
        public_key_b64: string;
        signing_public_key_b64: string;
        created_at: number;
      }
    | undefined;
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
  await secureStorage().delete(getSecretKeySlot());
  await secureStorage().delete(getSignSecretKeySlot());
  await db().exec(`
    DELETE FROM identity;
    DELETE FROM contacts;
    DELETE FROM messages;
    DELETE FROM ratchet_sessions;
    DELETE FROM groups;
    DELETE FROM chat_state;
    DELETE FROM call_history;
  `);
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
  mutedUntil?: number | null;
  zeroTrust?: boolean;
  status?: string;
  blocked?: boolean;
  archived?: boolean;
  profile?: 'personal' | 'work';
}

export async function saveContact(c: StoredContact): Promise<void> {
  await ensureSchema();
  await db().run(
    `INSERT OR REPLACE INTO contacts
     (aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.aegisId,
      c.publicKeyB64,
      c.signingPublicKeyB64 || '',
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
    ],
  );
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
  };
}

export async function loadContacts(profile?: 'personal' | 'work'): Promise<StoredContact[]> {
  await ensureSchema();
  const rows = profile
    ? ((await db().all(
        `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile FROM contacts WHERE profile = ? ORDER BY added_at DESC`,
        [profile],
      )) as ContactRow[])
    : ((await db().all(
        `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile FROM contacts ORDER BY added_at DESC`,
      )) as ContactRow[]);
  return rows.map(rowToContact);
}

export async function getContact(aegisId: string): Promise<StoredContact | null> {
  await ensureSchema();
  const row = (await db().get(
    `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile FROM contacts WHERE aegis_id = ?`,
    [aegisId],
  )) as ContactRow | undefined;
  if (!row) return null;
  return rowToContact(row);
}

export async function deleteContactMessages(chatId: string): Promise<void> {
  await db().run('DELETE FROM messages WHERE chat_id = ?', [chatId]);
}

export async function deleteContactRatchetSession(aegisId: string): Promise<void> {
  await db().run('DELETE FROM ratchet_sessions WHERE aegis_id = ?', [aegisId]);
}

export async function deleteContact(aegisId: string): Promise<void> {
  await db().run('DELETE FROM contacts WHERE aegis_id = ?', [aegisId]);
}

// ─── DB encryption at-rest ───────────────────────────────────────────────────

let cachedDbKey: Uint8Array | null = null;

async function getDbKey(): Promise<Uint8Array> {
  if (cachedDbKey) return cachedDbKey;
  const slotKey = getDbEncKeySlot();
  let keyB64 = await secureStorage().get(slotKey);
  if (!keyB64) {
    const keyBytes = nacl.randomBytes(32);
    keyB64 = encodeBase64(keyBytes);
    await secureStorage().set(slotKey, keyB64);
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
    const result = { ct: encodeBase64(encrypted), n: encodeBase64(nonce) };
    return 'encv1:' + JSON.stringify(result);
  } catch {
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
  } catch {
    return '[DECRYPTION_ERROR]';
  }
}

// ─── Messages ────────────────────────────────────────────────────────────────

export type MessageType = 'text' | 'image' | 'audio' | 'file' | 'poll' | 'location' | 'view_once';

export interface MessageReactions {
  [emoji: string]: string[];
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
  await ensureSchema();
  const encrypted = await encryptBody(m.body);
  const encryptedMediaUri = m.mediaUri ? await encryptBody(m.mediaUri) : null;
  await db().run(
    `INSERT OR REPLACE INTO messages
     (id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
  );
}

export async function updateMessageDelivery(id: string, status: 'sent' | 'delivered' | 'read'): Promise<void> {
  await db().run('UPDATE messages SET delivery_status = ? WHERE id = ?', [status, id]);
}

export async function loadMessagesByChat(chatId: string): Promise<StoredMessage[]> {
  await ensureSchema();
  const rows = (await db().all(
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
     FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
    [chatId],
  )) as MessageRow[];
  return Promise.all(rows.map(async (r) => await rowToMessage(r, await decryptBody(r.body))));
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  const row = (await db().get(
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
     FROM messages WHERE id = ?`,
    [id],
  )) as MessageRow | undefined;
  if (!row) return null;
  return await rowToMessage(row, await decryptBody(row.body));
}

export async function setMessagePinned(id: string, pinned: boolean): Promise<void> {
  await db().run('UPDATE messages SET pinned = ? WHERE id = ?', [pinned ? 1 : 0, id]);
}

export async function getPinnedMessage(chatId: string): Promise<StoredMessage | null> {
  const row = (await db().get(
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
     FROM messages WHERE chat_id = ? AND pinned = 1 ORDER BY created_at DESC LIMIT 1`,
    [chatId],
  )) as MessageRow | undefined;
  if (!row) return null;
  return await rowToMessage(row, await decryptBody(row.body));
}

export async function setMessageStarred(id: string, starred: boolean): Promise<void> {
  await db().run('UPDATE messages SET starred = ? WHERE id = ?', [starred ? 1 : 0, id]);
}

export async function setMessageDeleted(id: string): Promise<void> {
  const empty = await encryptBody('');
  await db().run(
    'UPDATE messages SET deleted = 1, body = ?, media_uri = NULL WHERE id = ?',
    [empty, id],
  );
}

export async function setMessageReactions(id: string, reactions: MessageReactions): Promise<void> {
  await db().run('UPDATE messages SET reactions = ? WHERE id = ?', [JSON.stringify(reactions), id]);
}

export async function lastMessageByChat(chatId: string): Promise<StoredMessage | null> {
  const row = (await db().get(
    `SELECT id, chat_id, direction, body, created_at FROM messages
     WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
    [chatId],
  )) as { id: string; chat_id: string; direction: string; body: string; created_at: number } | undefined;
  if (!row) return null;
  return {
    id: row.id,
    chatId: row.chat_id,
    direction: row.direction as 'in' | 'out',
    body: await decryptBody(row.body),
    createdAt: row.created_at,
  };
}

// ─── Double Ratchet sessions ─────────────────────────────────────────────────

export interface StoredRatchetSession {
  aegisId: string;
  stateJson: string;
}

export async function saveRatchetSession(aegisId: string, stateJson: string): Promise<void> {
  await ensureSchema();
  const encrypted = await encryptBody(stateJson);
  await db().run(
    'INSERT OR REPLACE INTO ratchet_sessions (aegis_id, state_json) VALUES (?, ?)',
    [aegisId, encrypted],
  );
}

export async function loadRatchetSession(aegisId: string): Promise<string | null> {
  const row = (await db().get(
    'SELECT state_json FROM ratchet_sessions WHERE aegis_id = ?',
    [aegisId],
  )) as { state_json: string } | undefined;
  if (!row) return null;
  return decryptBody(row.state_json);
}

// ─── Groups ──────────────────────────────────────────────────────────────────

export interface StoredGroup {
  id: string;
  name: string;
  members: string[];
  createdAt: number;
  avatarColor?: string;
  avatarImage?: string;
  adminOnlyInvite?: boolean;
  moderateNewMembers?: boolean;
  adminId?: string;
  adminSig?: string;
  moderators?: string[];
  admins?: string[];
  permissions?: {
    onlyAdminsSend?: boolean;
    disableReactions?: boolean;
  };
}

export async function saveGroup(g: StoredGroup): Promise<void> {
  await ensureSchema();
  await db().run(
    `INSERT OR REPLACE INTO groups (id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
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
    ],
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
  await ensureSchema();
  const rows = (await db().all(
    `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig FROM groups ORDER BY created_at DESC`,
  )) as GroupRow[];
  return rows.map(rowToGroup);
}

export async function deleteGroup(id: string): Promise<void> {
  await db().run('DELETE FROM groups WHERE id = ?', [id]);
}

export async function getGroup(id: string): Promise<StoredGroup | null> {
  const row = (await db().get(
    `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig FROM groups WHERE id = ?`,
    [id],
  )) as GroupRow | undefined;
  if (!row) return null;
  return rowToGroup(row);
}

// ─── Panic wipe ──────────────────────────────────────────────────────────────

export async function wipeDatabase(): Promise<void> {
  await db().run('DELETE FROM messages');
  await db().run('DELETE FROM contacts');
  await db().run('DELETE FROM groups');
  await db().run('DELETE FROM ratchet_sessions');
  await db().run('DELETE FROM chat_state');
  await db().run('DELETE FROM call_history');
  await clearIdentity();
  cachedDbKey = null;
  await secureStorage().delete(getDbEncKeySlot());
  await secureStorage().delete('aegis.panic.v1').catch(() => {});
  await secureStorage().delete('aegis.preferences.v1').catch(() => {});
  await secureStorage().delete('aegis.polls.v1').catch(() => {});
}

// ─── Chat state (draft + unread) ─────────────────────────────────────────────

export async function getChatState(chatId: string): Promise<{ draft: string | null; unreadCount: number }> {
  await ensureSchema();
  const row = (await db().get(
    'SELECT draft, unread_count FROM chat_state WHERE chat_id = ?',
    [chatId],
  )) as { draft: string | null; unread_count: number } | undefined;
  if (!row) return { draft: null, unreadCount: 0 };
  const decryptedDraft = row.draft ? await decryptBody(row.draft) : null;
  return { draft: decryptedDraft, unreadCount: row.unread_count };
}

export async function setChatDraft(chatId: string, draft: string | null): Promise<void> {
  const encrypted = draft ? await encryptBody(draft) : null;
  await db().run(
    'INSERT OR REPLACE INTO chat_state (chat_id, draft, unread_count) VALUES (?, ?, COALESCE((SELECT unread_count FROM chat_state WHERE chat_id = ?), 0))',
    [chatId, encrypted, chatId],
  );
}

export async function incrementUnread(chatId: string): Promise<void> {
  await db().run(
    'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET unread_count = unread_count + 1',
    [chatId],
  );
}

export async function resetUnread(chatId: string): Promise<void> {
  await db().run(
    'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 0) ON CONFLICT(chat_id) DO UPDATE SET unread_count = 0',
    [chatId],
  );
}

export async function deleteChatState(chatId: string): Promise<void> {
  await db().run('DELETE FROM chat_state WHERE chat_id = ?', [chatId]);
}

export async function getAllUnreadCounts(): Promise<Record<string, number>> {
  await ensureSchema();
  const rows = (await db().all(
    'SELECT chat_id, unread_count FROM chat_state WHERE unread_count > 0',
  )) as Array<{ chat_id: string; unread_count: number }>;
  const result: Record<string, number> = {};
  for (const r of rows) result[r.chat_id] = r.unread_count;
  return result;
}

// ─── Ephemeral cleanup ───────────────────────────────────────────────────────

export async function deleteExpiredMessages(timerSeconds: number): Promise<void> {
  const now = Date.now();
  await db().run(
    'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?',
    [now],
  );
  if (timerSeconds > 0) {
    const cutoff = now - timerSeconds * 1000;
    await db().run(
      'DELETE FROM messages WHERE created_at < ? AND expires_at IS NULL AND deleted = 0',
      [cutoff],
    );
  }
}

// ─── Call history ────────────────────────────────────────────────────────────

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
  await ensureSchema();
  await db().run(
    'INSERT OR REPLACE INTO call_history (id, contact_id, direction, media, status, started_at, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [c.id, c.contactId, c.direction, c.media, c.status, c.startedAt, c.durationS],
  );
}

export async function getCallHistory(contactId: string, limit = 50): Promise<StoredCall[]> {
  await ensureSchema();
  const rows = (await db().all(
    'SELECT id, contact_id, direction, media, status, started_at, duration_s FROM call_history WHERE contact_id = ? ORDER BY started_at DESC LIMIT ?',
    [contactId, limit],
  )) as Array<{
    id: string;
    contact_id: string;
    direction: string;
    media: string;
    status: string;
    started_at: number;
    duration_s: number;
  }>;
  return rows.map((r) => ({
    id: r.id,
    contactId: r.contact_id,
    direction: r.direction as 'in' | 'out',
    media: r.media as 'audio' | 'video',
    status: r.status as 'missed' | 'answered' | 'declined',
    startedAt: r.started_at,
    durationS: r.duration_s,
  }));
}
