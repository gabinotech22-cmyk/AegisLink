import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

// ─── Module state ────────────────────────────────────────────────────────────

let initialized = false;
let cachedDbKey = null;

const DB_ENC_KEY_SLOT = 'aegis.dbEncKey.b64';

function requireSecureStore() {
  if (typeof window === 'undefined' || !window.secureStore) {
    throw new Error('db: window.secureStore IPC bridge unavailable');
  }
  return window.secureStore;
}

function requireDbBridge() {
  if (typeof window === 'undefined' || !window.db) {
    throw new Error('db: window.db IPC bridge unavailable');
  }
  return window.db;
}

// ─── Initialization ──────────────────────────────────────────────────────────

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS contacts (
    aegis_id                TEXT PRIMARY KEY,
    public_key_b64          TEXT NOT NULL,
    signing_public_key_b64  TEXT NOT NULL DEFAULT '',
    name                    TEXT NOT NULL,
    verified                INTEGER NOT NULL DEFAULT 0,
    added_at                INTEGER NOT NULL,
    color                   TEXT,
    avatar_image            TEXT,
    blocked                 INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS ratchet_sessions (
    aegis_id   TEXT PRIMARY KEY,
    state_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS groups (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    members    TEXT NOT NULL,
    admin_id   TEXT,
    admin_sig  TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS call_history (
    id               TEXT PRIMARY KEY,
    peer_id          TEXT NOT NULL,
    media            TEXT NOT NULL,
    status           TEXT NOT NULL,
    started_at       INTEGER NOT NULL,
    ended_at         INTEGER,
    duration_seconds INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS scheduled_messages (
    id      TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL,
    body    TEXT NOT NULL,
    send_at INTEGER NOT NULL,
    sent    INTEGER DEFAULT 0
  )`,
];

export async function initDB() {
  if (initialized) return;
  const d = requireDbBridge();
  for (const sql of SCHEMA_STATEMENTS) {
    await d.run(sql, []);
  }
  // Migrate: add blocked column if not present (safe no-op if already exists)
  try {
    await d.run(`ALTER TABLE contacts ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0`, []);
  } catch { /* column already exists */ }
  initialized = true;
}

// ─── At-rest body encryption ─────────────────────────────────────────────────

async function getDbKey() {
  if (cachedDbKey) return cachedDbKey;
  const ss = requireSecureStore();
  let keyB64 = await ss.get(DB_ENC_KEY_SLOT);
  if (!keyB64) {
    const keyBytes = nacl.randomBytes(32);
    keyB64 = encodeBase64(keyBytes);
    await ss.set(DB_ENC_KEY_SLOT, keyB64);
  }
  cachedDbKey = decodeBase64(keyB64);
  return cachedDbKey;
}

export async function encryptBody(body) {
  try {
    const key = await getDbKey();
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
    const bodyBytes = new TextEncoder().encode(body);
    const encrypted = nacl.secretbox(bodyBytes, nonce, key);
    return 'encv1:' + JSON.stringify({ ct: encodeBase64(encrypted), n: encodeBase64(nonce) });
  } catch {
    return body;
  }
}

export async function decryptBody(encryptedBody) {
  if (!encryptedBody || !encryptedBody.startsWith('encv1:')) return encryptedBody;
  try {
    const key = await getDbKey();
    const parsed = JSON.parse(encryptedBody.slice(6));
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

export async function saveMessage(m) {
  const d = requireDbBridge();
  const encrypted = await encryptBody(m.body);
  await d.run(
    `INSERT OR REPLACE INTO messages
     (id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, delivery_status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      m.id,
      m.chatId,
      m.direction,
      encrypted,
      m.createdAt,
      m.type ?? 'text',
      m.mediaUri ?? null,
      m.replyToId ?? null,
      m.reactions ? JSON.stringify(m.reactions) : null,
      m.starred ? 1 : 0,
      m.deleted ? 1 : 0,
      m.deliveryStatus ?? 'sent',
      m.expiresAt ?? null,
    ],
  );
}

export async function loadMessages(chatId) {
  const d = requireDbBridge();
  const rows = await d.all(
    `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, delivery_status, expires_at
     FROM messages WHERE chat_id = ? AND deleted = 0 ORDER BY created_at ASC`,
    [chatId],
  );
  const out = [];
  for (const r of rows) {
    let reactions;
    if (r.reactions) {
      try { reactions = JSON.parse(r.reactions); } catch { /* ignore */ }
    }
    out.push({
      id: r.id,
      chatId: r.chat_id,
      direction: r.direction,
      body: await decryptBody(r.body),
      createdAt: r.created_at,
      type: r.type ?? 'text',
      mediaUri: r.media_uri ?? null,
      replyToId: r.reply_to_id ?? null,
      reactions,
      starred: r.starred === 1,
      deleted: r.deleted === 1,
      deliveryStatus: r.delivery_status ?? 'sent',
      expiresAt: r.expires_at ?? null,
    });
  }
  return out;
}

export async function updateMessageStatus(id, deliveryStatus) {
  const d = requireDbBridge();
  await d.run(
    `UPDATE messages SET delivery_status = ? WHERE id = ?`,
    [deliveryStatus, id],
  );
}

export async function updateMessageReactions(id, reactions) {
  const d = requireDbBridge();
  await d.run(
    `UPDATE messages SET reactions = ? WHERE id = ?`,
    [reactions ? JSON.stringify(reactions) : null, id],
  );
}

export async function deleteMessage(id) {
  const d = requireDbBridge();
  await d.run(
    `UPDATE messages SET deleted = 1 WHERE id = ?`,
    [id],
  );
}

// ─── Ratchet sessions ────────────────────────────────────────────────────────

export async function saveRatchetSession(aegisId, stateJson) {
  const d = requireDbBridge();
  const encrypted = await encryptBody(stateJson);
  await d.run(
    `INSERT OR REPLACE INTO ratchet_sessions (aegis_id, state_json) VALUES (?, ?)`,
    [aegisId, encrypted],
  );
}

export async function loadRatchetSession(aegisId) {
  const d = requireDbBridge();
  const row = await d.get(
    `SELECT state_json FROM ratchet_sessions WHERE aegis_id = ?`,
    [aegisId],
  );
  if (!row) return null;
  return decryptBody(row.state_json);
}

// ─── Contacts ────────────────────────────────────────────────────────────────

export async function saveContact(c) {
  const d = requireDbBridge();
  await d.run(
    `INSERT OR REPLACE INTO contacts
     (aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, blocked)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      c.aegisId,
      c.publicKeyB64,
      c.signingPublicKeyB64 || '',
      c.name,
      c.verified ? 1 : 0,
      c.addedAt,
      c.color || null,
      c.avatarImage || null,
      c.blocked ? 1 : 0,
    ],
  );
}

export async function loadContacts() {
  const d = requireDbBridge();
  const rows = await d.all(
    `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, blocked
     FROM contacts ORDER BY added_at DESC`,
    [],
  );
  return rows.map((r) => ({
    aegisId: r.aegis_id,
    publicKeyB64: r.public_key_b64,
    signingPublicKeyB64: r.signing_public_key_b64 || undefined,
    name: r.name,
    verified: r.verified === 1,
    addedAt: r.added_at,
    color: r.color || undefined,
    avatarImage: r.avatar_image || null,
    blocked: r.blocked === 1,
  }));
}

export async function setContactBlocked(aegisId, blocked) {
  const d = requireDbBridge();
  await d.run(
    `UPDATE contacts SET blocked = ? WHERE aegis_id = ?`,
    [blocked ? 1 : 0, aegisId],
  );
}

// ─── Settings ────────────────────────────────────────────────────────────────

export async function loadSetting(key) {
  try {
    const d = requireDbBridge();
    const row = await d.get(`SELECT value FROM settings WHERE key = ?`, [key]);
    return row ? row.value : null;
  } catch {
    return null;
  }
}

export async function saveSetting(key, value) {
  try {
    const d = requireDbBridge();
    await d.run(
      `INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`,
      [key, String(value)],
    );
  } catch {
    // best-effort
  }
}

// ─── Groups ──────────────────────────────────────────────────────────────────

export async function saveGroup(group) {
  const d = requireDbBridge();
  await d.run(
    `INSERT OR REPLACE INTO groups (id, name, members, admin_id, admin_sig, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      group.id,
      group.name,
      JSON.stringify(group.members),
      group.adminId ?? null,
      group.adminSig ?? null,
      group.createdAt,
    ],
  );
}

export async function getGroup(id) {
  const d = requireDbBridge();
  const row = await d.get(`SELECT * FROM groups WHERE id = ?`, [id]);
  if (!row) return null;
  return { ...row, members: JSON.parse(row.members) };
}

export async function getAllGroups() {
  const d = requireDbBridge();
  const rows = await d.all(`SELECT * FROM groups ORDER BY created_at DESC`, []);
  return rows.map(row => ({ ...row, members: JSON.parse(row.members) }));
}

// ─── Scheduled messages ──────────────────────────────────────────────────────

export async function saveScheduledMessage(msg) {
  const d = requireDbBridge();
  await d.run(
    `INSERT OR REPLACE INTO scheduled_messages (id, chat_id, body, send_at, sent)
     VALUES (?, ?, ?, ?, ?)`,
    [msg.id, msg.chatId, msg.body, msg.sendAt, msg.sent ? 1 : 0],
  );
}

export async function getPendingScheduled() {
  const d = requireDbBridge();
  return d.all(
    `SELECT * FROM scheduled_messages WHERE sent = 0 AND send_at <= ?`,
    [Date.now()],
  );
}
