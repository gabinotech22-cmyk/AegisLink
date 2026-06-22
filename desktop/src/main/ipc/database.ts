import { ipcMain, app, safeStorage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import Database from 'better-sqlite3-multiple-ciphers'
import path from 'path'
import fs from 'fs'
import { is } from '@electron-toolkit/utils'
import { readKeystore, writeKeystore } from './secureStorage'
import nacl from 'tweetnacl'
import { decodeBase64, encodeBase64 } from 'tweetnacl-util'

let db: Database.Database
let cachedDbKey: Uint8Array | null = null

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

// IPC payload size guard (defence-in-depth): a compromised or buggy renderer
// must not be able to push an unbounded string into the main process / SQLite
// (memory-exhaustion / disk-fill). Bounds are generous — far above any legitimate
// value — so they never reject real data, only pathological payloads.
const MAX_RATCHET_STATE_BYTES = 1024 * 1024;   // 1 MB — a session state is a few KB
const MAX_MESSAGE_BODY_BYTES = 8 * 1024 * 1024; // 8 MB — covers large base64 media refs
function assertMaxLen(value: unknown, maxBytes: number, label: string): void {
  if (typeof value === 'string' && value.length > maxBytes) {
    throw new Error(`IPC payload too large: ${label} (${value.length} > ${maxBytes})`)
  }
}

// ─── DB encryption at-rest ───────────────────────────────────────────────────

function getDbEncKeySlot(slot = 'self'): string {
  return slot === 'self' ? 'aegis.dbEncKey.b64' : `aegis.${slot}.dbEncKey.b64`
}

// ─── C-2 Fase 2: PIN-wrapped DB key (second factor at-rest) ──────────────────
//
// When the user enables the app lock, the 32-byte DB key is wrapped under a KEK
// derived from the PIN (Argon2id, derived in the renderer) *inside* the DPAPI
// layer. Opening the DB then requires BOTH the OS session (DPAPI) AND the PIN.
// Format of the keystore value (slot 'self' → `aegis.dbEncKey.b64`):
//   `pinv1:<nonceB64>.<dpapiB64>`   — secretbox(dbKey,nonce,KEK) then DPAPI
//   `pinv1plain:<nonceB64>.<ctB64>` — dev-only fallback when safeStorage absent
// (base64 alphabet has no '.', so it is an unambiguous separator). The KEK salt
// lives separately in `aegis.dbkek.salt.v1` (renderer-owned); only the 32-byte
// KEK crosses IPC — the raw DB key never leaves main.
const PIN_WRAP_PREFIX = 'pinv1:'
const PIN_WRAP_PLAIN_PREFIX = 'pinv1plain:'
const DBKEK_SALT_KEY = 'aegis.dbkek.salt.v1'

export function isPinWrapped(encoded: string | undefined): boolean {
  return (
    !!encoded &&
    (encoded.startsWith(PIN_WRAP_PREFIX) || encoded.startsWith(PIN_WRAP_PLAIN_PREFIX))
  )
}

/** Validate a base64 KEK from the renderer decodes to exactly 32 bytes. */
function assertValidB64Key(b64: unknown): asserts b64 is string {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > 64) {
    throw new Error('invalid KEK')
  }
  if (decodeBase64(b64).length !== 32) throw new Error('KEK must be 32 bytes')
}

/** Wrap `dbKey` under the PIN-derived `kek` (+ DPAPI outer layer). */
export function wrapDbKeyUnderPin(dbKey: Uint8Array, kek: Uint8Array): string {
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const ct = nacl.secretbox(dbKey, nonce, kek)
  const nonceB64 = encodeBase64(nonce)
  const ctB64 = encodeBase64(ct)
  if (safeStorage.isEncryptionAvailable()) {
    const dpapi = safeStorage.encryptString(ctB64).toString('base64')
    return `${PIN_WRAP_PREFIX}${nonceB64}.${dpapi}`
  }
  // No try/catch fallback to plaintext in production (golden rule #1/#6).
  if (app.isPackaged) {
    throw new Error('AegisLink: OS secure storage unavailable — cannot PIN-wrap DB key.')
  }
  return `${PIN_WRAP_PLAIN_PREFIX}${nonceB64}.${ctB64}`
}

/** Unwrap a `pinv1:`/`pinv1plain:` value with `kek`; throws on a wrong PIN. */
export function unwrapDbKeyUnderPin(encoded: string, kek: Uint8Array): Uint8Array {
  let nonceB64: string
  let ctB64: string
  if (encoded.startsWith(PIN_WRAP_PREFIX)) {
    const [n, dpapi] = encoded.slice(PIN_WRAP_PREFIX.length).split('.')
    nonceB64 = n
    ctB64 = safeStorage.decryptString(Buffer.from(dpapi, 'base64'))
  } else if (encoded.startsWith(PIN_WRAP_PLAIN_PREFIX)) {
    const [n, c] = encoded.slice(PIN_WRAP_PLAIN_PREFIX.length).split('.')
    nonceB64 = n
    ctB64 = c
  } else {
    throw new Error('not a PIN-wrapped DB key')
  }
  const opened = nacl.secretbox.open(decodeBase64(ctB64), decodeBase64(nonceB64), kek)
  if (!opened) {
    // Wrong PIN (or tampered blob): the unwrap is itself the PIN check. Never
    // fall through to a fresh key — that would orphan all encrypted rows.
    throw new Error('AegisLink: incorrect PIN — DB key unwrap failed.')
  }
  if (opened.length !== 32) throw new Error('decrypted DB key has invalid length')
  return opened
}

function getDbKey(slot = 'self'): Uint8Array {
  if (cachedDbKey) return cachedDbKey
  const slotKey = getDbEncKeySlot(slot)
  const keystore = readKeystore()
  const encoded = keystore[slotKey]
  if (isPinWrapped(encoded)) {
    // PIN-wrapped (Fase 2): recoverable only via db:unlock(kek), which populates
    // cachedDbKey above. Reaching here means the DB is locked — fail closed.
    throw new Error('AegisLink: database is PIN-locked — unlock required before access.')
  }
  if (!encoded) {
    // First run for this slot: generate and persist a fresh DB key.
    if (!safeStorage.isEncryptionAvailable() && app.isPackaged) {
      // Production: never store the DB key in plaintext. Fail closed so the
      // caller surfaces a real error instead of silently downgrading at-rest
      // encryption. (Golden rule #1/#6: encryption never degrades silently;
      // production fails closed.)
      throw new Error(
        'AegisLink: OS secure storage unavailable — cannot create DB key securely.'
      )
    }
    const keyBytes = nacl.randomBytes(32)
    const rawVal = encodeBase64(keyBytes)
    if (safeStorage.isEncryptionAvailable()) {
      keystore[slotKey] = 'enc:' + safeStorage.encryptString(rawVal).toString('base64')
    } else {
      // Dev-only fallback (NOT encrypted) for local development.
      keystore[slotKey] = 'plain:' + Buffer.from(rawVal, 'utf-8').toString('base64')
    }
    writeKeystore(keystore)
    cachedDbKey = keyBytes
    return cachedDbKey
  }
  // A plaintext DB key must never exist in a packaged build — its presence means
  // at-rest encryption silently downgraded. Refuse to serve it rather than
  // operating on cleartext-keyed data (golden rule #1/#6; parity with
  // secureStorage:get, which applies the same refusal on read).
  if (encoded.startsWith('plain:') && app.isPackaged) {
    throw new Error(
      'AegisLink: plaintext DB key found in production build. Key storage is compromised.'
    )
  }
  // Existing key: decrypt it. If this fails we MUST NOT silently mint a new
  // key — that would orphan every previously-encrypted row (silent total
  // history loss). Surface the error so the caller can offer recovery.
  try {
    let decrypted = ''
    if (encoded.startsWith('plain:')) {
      decrypted = Buffer.from(encoded.slice(6), 'base64').toString('utf-8')
    } else {
      const raw = encoded.startsWith('enc:') ? encoded.slice(4) : encoded
      decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'))
    }
    const key = decodeBase64(decrypted)
    if (key.length !== 32) throw new Error('decrypted DB key has invalid length')
    cachedDbKey = key
    return cachedDbKey
  } catch (e) {
    throw new Error(
      'AegisLink: failed to decrypt the local DB key — refusing to regenerate ' +
        '(would orphan existing encrypted data). ' +
        (e instanceof Error ? e.message : String(e))
    )
  }
}

/** Drop the cached DB key (test helper / slot switch). */
export function resetDbKeyCache(): void {
  cachedDbKey = null
}

function encryptBody(body: string, slot = 'self'): string {
  // No try/catch: a cipher failure MUST propagate. Returning the plaintext
  // body here would silently persist cleartext (incl. ratchet state) to disk.
  // (Golden rule #1: encryption never degrades silently.)
  const key = getDbKey(slot)
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
  const bodyBytes = new TextEncoder().encode(body)
  const encrypted = nacl.secretbox(bodyBytes, nonce, key)
  const result = { ct: encodeBase64(encrypted), n: encodeBase64(nonce) }
  return 'encv1:' + JSON.stringify(result)
}

function decryptBody(encryptedBody: string, slot = 'self'): string {
  if (!encryptedBody || !encryptedBody.startsWith('encv1:')) return encryptedBody
  try {
    const key = getDbKey(slot)
    const jsonStr = encryptedBody.slice(6)
    const parsed = JSON.parse(jsonStr)
    const ct = decodeBase64(parsed.ct)
    const nonce = decodeBase64(parsed.n)
    const decrypted = nacl.secretbox.open(ct, nonce, key)
    if (!decrypted) return '[DECRYPTION_ERROR]'
    return new TextDecoder().decode(decrypted)
  } catch {
    return '[DECRYPTION_ERROR]'
  }
}

// ─── Schema Setup ─────────────────────────────────────────────────────────────

function ensureSchema(db: Database.Database): void {
  const statements = [
    `CREATE TABLE IF NOT EXISTS identity (
      slot                    TEXT PRIMARY KEY,
      aegis_id                TEXT NOT NULL,
      public_key_b64          TEXT NOT NULL,
      signing_public_key_b64  TEXT NOT NULL,
      created_at              INTEGER NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS contacts (
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
      pinned          INTEGER NOT NULL DEFAULT 0,
      delivery_status TEXT NOT NULL DEFAULT 'sent',
      expires_at      INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, created_at)`,
    `CREATE TABLE IF NOT EXISTS ratchet_sessions (
      aegis_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS groups (
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
    )`,
    `CREATE TABLE IF NOT EXISTS chat_state (
      chat_id      TEXT PRIMARY KEY,
      draft        TEXT,
      unread_count INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS call_history (
      id          TEXT PRIMARY KEY,
      contact_id  TEXT NOT NULL,
      direction   TEXT NOT NULL,
      media       TEXT NOT NULL,
      status      TEXT NOT NULL,
      started_at  INTEGER NOT NULL,
      duration_s  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_calls_contact ON call_history(contact_id, started_at)`,
  ]
  for (const sql of statements) {
    db.prepare(sql).run()
  }

  function safeAddColumn(table: string, column: string, definition: string): void {
    try {
      db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run()
    } catch (e) {
      const msg = (e as Error)?.message ?? String(e)
      if (!msg.includes('duplicate column name') && !msg.includes('no such table')) {
        throw e
      }
    }
  }

  // Migrations for databases created before each column existed. CREATE TABLE
  // IF NOT EXISTS never upgrades an existing table, so every column added
  // after first release must ALSO be listed here. Cheap no-ops when current.
  safeAddColumn('messages', 'type', 'TEXT')
  safeAddColumn('messages', 'media_uri', 'TEXT')
  safeAddColumn('messages', 'reply_to_id', 'TEXT')
  safeAddColumn('messages', 'reactions', 'TEXT')
  safeAddColumn('messages', 'starred', 'INTEGER NOT NULL DEFAULT 0')
  safeAddColumn('messages', 'deleted', 'INTEGER NOT NULL DEFAULT 0')
  safeAddColumn('messages', 'pinned', 'INTEGER NOT NULL DEFAULT 0')
  safeAddColumn('messages', 'delivery_status', "TEXT NOT NULL DEFAULT 'sent'")
  safeAddColumn('messages', 'expires_at', 'INTEGER')

  safeAddColumn('contacts', 'signing_public_key_b64', "TEXT NOT NULL DEFAULT ''")
  safeAddColumn('contacts', 'color', 'TEXT')
  safeAddColumn('contacts', 'avatar_image', 'TEXT')
  safeAddColumn('contacts', 'muted', 'INTEGER NOT NULL DEFAULT 0')
  safeAddColumn('contacts', 'zero_trust', 'INTEGER NOT NULL DEFAULT 0')
  safeAddColumn('contacts', 'status', 'TEXT')
  safeAddColumn('contacts', 'muted_until', 'INTEGER')
  safeAddColumn('contacts', 'blocked', 'INTEGER NOT NULL DEFAULT 0')
  safeAddColumn('contacts', 'archived', 'INTEGER NOT NULL DEFAULT 0')
  safeAddColumn('contacts', 'profile', "TEXT NOT NULL DEFAULT 'personal'")

  safeAddColumn('groups', 'avatar_color', 'TEXT')
  safeAddColumn('groups', 'avatar_image', 'TEXT')
  safeAddColumn('groups', 'admin_only_invite', 'INTEGER NOT NULL DEFAULT 1')
  safeAddColumn('groups', 'moderate_new_members', 'INTEGER NOT NULL DEFAULT 0')
  safeAddColumn('groups', 'admin_id', 'TEXT')
  safeAddColumn('groups', 'admin_sig', 'TEXT')

  safeAddColumn('call_history', 'duration_s', 'INTEGER NOT NULL DEFAULT 0')
}

// ─── SQLCipher at-rest encryption (Ola 10) ────────────────────────────────────

/** Lowercase hex of the 32-byte DB key for `PRAGMA key = "x'…'"`. */
function dbKeyHex(slot = 'self'): string {
  return Buffer.from(getDbKey(slot)).toString('hex')
}

/**
 * Open `dbPath` encrypted at-rest, migrating a legacy plaintext file in place.
 *
 * Detection probes whether the file is readable with NO key (⇒ plaintext); if so
 * it is encrypted in place via `PRAGMA rekey` (SQLite3MultipleCiphers supports
 * plaintext→encrypted rekey, preserving all rows). The key PRAGMA is applied as
 * the first statement on the returned handle. Fails closed: getDbKey() throws
 * when OS secure storage is unavailable in a packaged build.
 */
export function openEncrypted(dbPath: string, slot = 'self'): Database.Database {
  const keyHex = dbKeyHex(slot)

  // ── Migrate a pre-existing PLAINTEXT database (readable without a key) ──────
  if (fs.existsSync(dbPath) && fs.statSync(dbPath).size > 0) {
    let plaintext = false
    const probe = new Database(dbPath)
    try {
      probe.exec('SELECT count(*) FROM sqlite_master') // no key → succeeds iff plaintext
      plaintext = true
    } catch {
      plaintext = false // unreadable without a key → already encrypted
    } finally {
      probe.close()
    }
    if (plaintext) {
      const plain = new Database(dbPath)
      try {
        plain.pragma(`rekey="x'${keyHex}'"`) // encrypt in place, rows preserved
      } finally {
        plain.close()
      }
    }
  }

  const handle = new Database(dbPath)
  handle.pragma(`key="x'${keyHex}'"`)
  return handle
}

// ─── Handlers Registration ────────────────────────────────────────────────────

let mainDbPath = ''

/**
 * Open the main DB handle (idempotent). Ola 10: whole-DB SQLCipher encryption
 * (key from getDbKey, migrates legacy plaintext DBs). The key PRAGMA must be the
 * first statement on the handle, so it precedes journal_mode/foreign_keys.
 *
 * For PIN-wrapped installs (Fase 2) this is deferred until db:unlock has set
 * cachedDbKey; getDbKey() then returns the unlocked key.
 */
function openMainDb(): void {
  if (db) return
  db = openEncrypted(mainDbPath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  ensureSchema(db)
}

export function registerDatabaseHandlers(): void {
  mainDbPath = path.join(app.getPath('userData'), 'aegislink.db')

  // C-2 Fase 2: if the DB key is PIN-wrapped, DEFER opening until db:unlock
  // supplies the PIN-derived KEK. Legacy / no-PIN installs open eagerly as before
  // (fully backward compatible).
  const encoded = readKeystore()[getDbEncKeySlot('self')]
  if (!isPinWrapped(encoded)) {
    openMainDb()
  }

  // ─── Lock / unlock (C-2 Fase 2) ───
  ipcMain.handle('db:lock-state', (event): { pinWrapped: boolean; opened: boolean } => {
    assertTrustedSender(event)
    const enc = readKeystore()[getDbEncKeySlot('self')]
    return { pinWrapped: isPinWrapped(enc), opened: !!db }
  })

  ipcMain.handle('db:unlock', (event, kekB64: string): void => {
    assertTrustedSender(event)
    if (db) return // already unlocked/open
    const enc = readKeystore()[getDbEncKeySlot('self')]
    if (isPinWrapped(enc)) {
      assertValidB64Key(kekB64)
      const kek = decodeBase64(kekB64)
      try {
        cachedDbKey = unwrapDbKeyUnderPin(enc as string, kek) // throws on wrong PIN
      } finally {
        kek.fill(0)
      }
    }
    // Legacy/no-PIN: open without a KEK. PIN-wrapped: cachedDbKey now set.
    openMainDb()
  })

  ipcMain.handle('db:enable-pin-wrap', (event, kekB64: string): void => {
    assertTrustedSender(event)
    assertValidB64Key(kekB64)
    const dbKey = getDbKey('self') // DB must be open/unlocked
    const kek = decodeBase64(kekB64)
    try {
      const keystore = readKeystore()
      keystore[getDbEncKeySlot('self')] = wrapDbKeyUnderPin(dbKey, kek)
      writeKeystore(keystore)
    } finally {
      kek.fill(0)
    }
  })

  ipcMain.handle('db:disable-pin-wrap', (event): void => {
    assertTrustedSender(event)
    const dbKey = getDbKey('self') // DB must be open/unlocked
    const keystore = readKeystore()
    const rawVal = encodeBase64(dbKey)
    if (safeStorage.isEncryptionAvailable()) {
      keystore[getDbEncKeySlot('self')] = 'enc:' + safeStorage.encryptString(rawVal).toString('base64')
    } else if (app.isPackaged) {
      throw new Error('AegisLink: OS secure storage unavailable — cannot rewrap DB key.')
    } else {
      keystore[getDbEncKeySlot('self')] = 'plain:' + Buffer.from(rawVal, 'utf-8').toString('base64')
    }
    writeKeystore(keystore)
  })

  // ─── Identity ───
  ipcMain.handle('db:save-identity', (event, activeSlot: string, identity: any): void => {
    assertTrustedSender(event)
    const sql = `INSERT OR REPLACE INTO identity (slot, aegis_id, public_key_b64, signing_public_key_b64, created_at)
                 VALUES (?, ?, ?, ?, ?)`
    db.prepare(sql).run(
      activeSlot,
      identity.aegisId,
      identity.publicKeyB64,
      identity.signingPublicKeyB64,
      identity.createdAt
    )
  })

  ipcMain.handle('db:load-identity', (event, activeSlot: string): any => {
    assertTrustedSender(event)
    const row: any = db
      .prepare(
        `SELECT aegis_id, public_key_b64, signing_public_key_b64, created_at FROM identity WHERE slot = ?`
      )
      .get(activeSlot)
    return row
      ? {
          aegisId: row.aegis_id,
          publicKeyB64: row.public_key_b64,
          signingPublicKeyB64: row.signing_public_key_b64,
          createdAt: row.created_at
        }
      : null
  })

  ipcMain.handle('db:clear-identity', (event): void => {
    assertTrustedSender(event)
    for (const table of [
      'identity',
      'contacts',
      'messages',
      'ratchet_sessions',
      'groups',
      'chat_state',
      'call_history'
    ]) {
      db.prepare(`DELETE FROM ${table}`).run()
    }
  })

  // ─── Contacts ───
  ipcMain.handle('db:save-contact', (event, c: any): void => {
    assertTrustedSender(event)
    const sql = `INSERT OR REPLACE INTO contacts
     (aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    db.prepare(sql).run(
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
      c.profile ?? 'personal'
    )
  })

  ipcMain.handle('db:load-contacts', (event, profile?: string): any[] => {
    assertTrustedSender(event)
    let rows: any[]
    if (profile) {
      rows = db
        .prepare(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile FROM contacts WHERE profile = ? ORDER BY added_at DESC`
        )
        .all(profile)
    } else {
      rows = db
        .prepare(
          `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile FROM contacts ORDER BY added_at DESC`
        )
        .all()
    }
    return rows.map((r) => ({
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
      profile: r.profile
    }))
  })

  ipcMain.handle('db:get-contact', (event, aegisId: string): any => {
    assertTrustedSender(event)
    const r: any = db
      .prepare(
        `SELECT aegis_id, public_key_b64, signing_public_key_b64, name, verified, added_at, color, avatar_image, muted, zero_trust, status, muted_until, blocked, archived, profile FROM contacts WHERE aegis_id = ?`
      )
      .get(aegisId)
    return r
      ? {
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
          profile: r.profile
        }
      : null
  })

  ipcMain.handle('db:delete-contact-messages', (event, chatId: string): void => {
    assertTrustedSender(event)
    db.prepare('DELETE FROM messages WHERE chat_id = ?').run(chatId)
  })

  ipcMain.handle('db:delete-contact-ratchet-session', (event, aegisId: string): void => {
    assertTrustedSender(event)
    db.prepare('DELETE FROM ratchet_sessions WHERE aegis_id = ?').run(aegisId)
  })

  ipcMain.handle('db:delete-contact', (event, aegisId: string): void => {
    assertTrustedSender(event)
    db.prepare('DELETE FROM contacts WHERE aegis_id = ?').run(aegisId)
  })

  // ─── Messages ───
  ipcMain.handle('db:save-message', (event, activeSlot: string, m: any): void => {
    assertTrustedSender(event)
    assertMaxLen(m?.body, MAX_MESSAGE_BODY_BYTES, 'message.body')
    assertMaxLen(m?.mediaUri, MAX_MESSAGE_BODY_BYTES, 'message.mediaUri')
    const encrypted = encryptBody(m.body, activeSlot)
    const encryptedMediaUri = m.mediaUri ? encryptBody(m.mediaUri, activeSlot) : null
    const sql = `INSERT OR REPLACE INTO messages
     (id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    db.prepare(sql).run(
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
    )
  })

  ipcMain.handle('db:update-message-delivery', (event, id: string, status: string): void => {
    assertTrustedSender(event)
    db.prepare('UPDATE messages SET delivery_status = ? WHERE id = ?').run(status, id)
  })

  ipcMain.handle('db:load-messages-by-chat', (event, activeSlot: string, chatId: string): any[] => {
    assertTrustedSender(event)
    const rows = db
      .prepare(
        `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
       FROM messages WHERE chat_id = ? ORDER BY created_at ASC`
      )
      .all(chatId) as any[]

    return rows.map((r) => {
      let reactions: any
      if (r.reactions) {
        try {
          reactions = JSON.parse(r.reactions)
        } catch {
          /* ignore */
        }
      }
      const decryptedBody = decryptBody(r.body, activeSlot)
      const decryptedMediaUri = r.media_uri ? decryptBody(r.media_uri, activeSlot) : null
      return {
        id: r.id,
        chatId: r.chat_id,
        direction: r.direction,
        body: decryptedBody,
        createdAt: r.created_at,
        type: r.type ?? 'text',
        mediaUri: decryptedMediaUri,
        replyToId: r.reply_to_id ?? null,
        reactions,
        starred: r.starred === 1,
        deleted: r.deleted === 1,
        pinned: r.pinned === 1,
        deliveryStatus: r.delivery_status ?? 'sent',
        expiresAt: r.expires_at ?? null
      }
    })
  })

  ipcMain.handle('db:get-message', (event, activeSlot: string, id: string): any => {
    assertTrustedSender(event)
    const r: any = db
      .prepare(
        `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
       FROM messages WHERE id = ?`
      )
      .get(id)
    if (!r) return null
    let reactions: any
    if (r.reactions) {
      try {
        reactions = JSON.parse(r.reactions)
      } catch {
        /* ignore */
      }
    }
    const decryptedBody = decryptBody(r.body, activeSlot)
    const decryptedMediaUri = r.media_uri ? decryptBody(r.media_uri, activeSlot) : null
    return {
      id: r.id,
      chatId: r.chat_id,
      direction: r.direction,
      body: decryptedBody,
      createdAt: r.created_at,
      type: r.type ?? 'text',
      mediaUri: decryptedMediaUri,
      replyToId: r.reply_to_id ?? null,
      reactions,
      starred: r.starred === 1,
      deleted: r.deleted === 1,
      pinned: r.pinned === 1,
      deliveryStatus: r.delivery_status ?? 'sent',
      expiresAt: r.expires_at ?? null
    }
  })

  ipcMain.handle('db:set-message-pinned', (event, id: string, pinned: boolean): void => {
    assertTrustedSender(event)
    db.prepare('UPDATE messages SET pinned = ? WHERE id = ?').run(pinned ? 1 : 0, id)
  })

  ipcMain.handle('db:get-pinned-message', (event, activeSlot: string, chatId: string): any => {
    assertTrustedSender(event)
    const r: any = db
      .prepare(
        `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at
       FROM messages WHERE chat_id = ? AND pinned = 1 ORDER BY created_at DESC LIMIT 1`
      )
      .get(chatId)
    if (!r) return null
    let reactions: any
    if (r.reactions) {
      try {
        reactions = JSON.parse(r.reactions)
      } catch {
        /* ignore */
      }
    }
    const decryptedBody = decryptBody(r.body, activeSlot)
    const decryptedMediaUri = r.media_uri ? decryptBody(r.media_uri, activeSlot) : null
    return {
      id: r.id,
      chatId: r.chat_id,
      direction: r.direction,
      body: decryptedBody,
      createdAt: r.created_at,
      type: r.type ?? 'text',
      mediaUri: decryptedMediaUri,
      replyToId: r.reply_to_id ?? null,
      reactions,
      starred: r.starred === 1,
      deleted: r.deleted === 1,
      pinned: r.pinned === 1,
      deliveryStatus: r.delivery_status ?? 'sent',
      expiresAt: r.expires_at ?? null
    }
  })

  ipcMain.handle('db:set-message-starred', (event, id: string, starred: boolean): void => {
    assertTrustedSender(event)
    db.prepare('UPDATE messages SET starred = ? WHERE id = ?').run(starred ? 1 : 0, id)
  })

  ipcMain.handle('db:set-message-deleted', (event, activeSlot: string, id: string): void => {
    assertTrustedSender(event)
    const empty = encryptBody('', activeSlot)
    db.prepare('UPDATE messages SET deleted = 1, body = ?, media_uri = NULL WHERE id = ?').run(
      empty,
      id
    )
  })

  ipcMain.handle('db:set-message-reactions', (event, id: string, reactions: any): void => {
    assertTrustedSender(event)
    db.prepare('UPDATE messages SET reactions = ? WHERE id = ?').run(JSON.stringify(reactions), id)
  })

  ipcMain.handle('db:last-message-by-chat', (event, activeSlot: string, chatId: string): any => {
    assertTrustedSender(event)
    const r: any = db
      .prepare(
        `SELECT id, chat_id, direction, body, created_at FROM messages
       WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`
      )
      .get(chatId)
    if (!r) return null
    return {
      id: r.id,
      chatId: r.chat_id,
      direction: r.direction,
      body: decryptBody(r.body, activeSlot),
      createdAt: r.created_at
    }
  })

  // ─── Double Ratchet sessions ───
  ipcMain.handle(
    'db:save-ratchet-session',
    (event, activeSlot: string, aegisId: string, stateJson: string): void => {
      assertTrustedSender(event)
      assertMaxLen(stateJson, MAX_RATCHET_STATE_BYTES, 'ratchet stateJson')
      const encrypted = encryptBody(stateJson, activeSlot)
      db.prepare('INSERT OR REPLACE INTO ratchet_sessions (aegis_id, state_json) VALUES (?, ?)').run(
        aegisId,
        encrypted
      )
    }
  )

  ipcMain.handle(
    'db:load-ratchet-session',
    (event, activeSlot: string, aegisId: string): string | null => {
      assertTrustedSender(event)
      const r: any = db
        .prepare('SELECT state_json FROM ratchet_sessions WHERE aegis_id = ?')
        .get(aegisId)
      if (!r) return null
      return decryptBody(r.state_json, activeSlot)
    }
  )

  // ─── Groups ───
  ipcMain.handle('db:save-group', (event, g: any): void => {
    assertTrustedSender(event)
    db.prepare(
      `INSERT OR REPLACE INTO groups (id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
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
    )
  })

  ipcMain.handle('db:load-groups', (event): any[] => {
    assertTrustedSender(event)
    const rows = db
      .prepare(
        `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig FROM groups ORDER BY created_at DESC`
      )
      .all() as any[]
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      members: JSON.parse(r.members),
      createdAt: r.created_at,
      avatarColor: r.avatar_color || undefined,
      avatarImage: r.avatar_image || undefined,
      adminOnlyInvite: r.admin_only_invite === 1,
      moderateNewMembers: r.moderate_new_members === 1,
      adminId: r.admin_id ?? undefined,
      adminSig: r.admin_sig ?? undefined
    }))
  })

  ipcMain.handle('db:delete-group', (event, id: string): void => {
    assertTrustedSender(event)
    db.prepare('DELETE FROM groups WHERE id = ?').run(id)
  })

  ipcMain.handle('db:get-group', (event, id: string): any => {
    assertTrustedSender(event)
    const r: any = db
      .prepare(
        `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig FROM groups WHERE id = ?`
      )
      .get(id)
    if (!r) return null
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
      adminSig: r.admin_sig ?? undefined
    }
  })

  // ─── Panic wipe ───
  ipcMain.handle('db:wipe-database', (event, activeSlot: string): void => {
    assertTrustedSender(event)
    // Tolerate a LOCKED DB (Fase 2 cold-start panic, before db:unlock): the SQL
    // deletes are skipped, but the keystore wipe below removes the DB key blob —
    // the encrypted DB file is then unrecoverable, so panic still leaves nothing.
    if (db) {
      db.prepare('DELETE FROM messages').run()
      db.prepare('DELETE FROM contacts').run()
      db.prepare('DELETE FROM groups').run()
      db.prepare('DELETE FROM ratchet_sessions').run()
      db.prepare('DELETE FROM chat_state').run()
      db.prepare('DELETE FROM call_history').run()
      db.prepare('DELETE FROM identity').run()
    } else {
      // Locked cold-start panic (Fase 2): no open handle, so remove the encrypted
      // file outright. The DB key blob is deleted below anyway (file unrecoverable),
      // and a clean file lets a fresh DB mint cleanly on the next open.
      for (const suffix of ['', '-wal', '-shm']) {
        try {
          if (mainDbPath && fs.existsSync(mainDbPath + suffix)) fs.rmSync(mainDbPath + suffix)
        } catch { /* best-effort */ }
      }
    }
    if (cachedDbKey) cachedDbKey.fill(0) // zeroize the in-memory DB key (rule #9)
    cachedDbKey = null
    const keystore = readKeystore()
    delete keystore[getDbEncKeySlot(activeSlot)]
    delete keystore[DBKEK_SALT_KEY] // Fase 2: drop the PIN-KEK salt too (hygiene)
    delete keystore['aegis.panic.v1']
    delete keystore['aegis.preferences.v1']
    delete keystore['aegis.polls.v1']
    writeKeystore(keystore)
  })

  // ─── Chat state ───
  ipcMain.handle('db:get-chat-state', (event, activeSlot: string, chatId: string): any => {
    assertTrustedSender(event)
    const r: any = db
      .prepare('SELECT draft, unread_count FROM chat_state WHERE chat_id = ?')
      .get(chatId)
    if (!r) return { draft: null, unreadCount: 0 }
    const decryptedDraft = r.draft ? decryptBody(r.draft, activeSlot) : null
    return { draft: decryptedDraft, unreadCount: r.unread_count }
  })

  ipcMain.handle(
    'db:set-chat-draft',
    (event, activeSlot: string, chatId: string, draft: string | null): void => {
      assertTrustedSender(event)
      const encrypted = draft ? encryptBody(draft, activeSlot) : null
      db.prepare(
        'INSERT OR REPLACE INTO chat_state (chat_id, draft, unread_count) VALUES (?, ?, COALESCE((SELECT unread_count FROM chat_state WHERE chat_id = ?), 0))'
      ).run(chatId, encrypted, chatId)
    }
  )

  ipcMain.handle('db:increment-unread', (event, chatId: string): void => {
    assertTrustedSender(event)
    db.prepare(
      'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET unread_count = unread_count + 1'
    ).run(chatId)
  })

  ipcMain.handle('db:reset-unread', (event, chatId: string): void => {
    assertTrustedSender(event)
    db.prepare(
      'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 0) ON CONFLICT(chat_id) DO UPDATE SET unread_count = 0'
    ).run(chatId)
  })

  ipcMain.handle('db:delete-chat-state', (event, chatId: string): void => {
    assertTrustedSender(event)
    db.prepare('DELETE FROM chat_state WHERE chat_id = ?').run(chatId)
  })

  ipcMain.handle('db:get-all-unread-counts', (event): Record<string, number> => {
    assertTrustedSender(event)
    const rows = db
      .prepare('SELECT chat_id, unread_count FROM chat_state WHERE unread_count > 0')
      .all() as any[]
    const result: Record<string, number> = {}
    for (const r of rows) result[r.chat_id] = r.unread_count
    return result
  })

  // ─── Ephemeral cleanup ───
  ipcMain.handle('db:delete-expired-messages', (event, timerSeconds: number): void => {
    assertTrustedSender(event)
    const now = Date.now()
    db.prepare('DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ?').run(now)
    if (timerSeconds > 0) {
      const cutoff = now - timerSeconds * 1000
      db.prepare(
        'DELETE FROM messages WHERE created_at < ? AND expires_at IS NULL AND deleted = 0'
      ).run(cutoff)
    }
  })

  // ─── Call history ───
  ipcMain.handle('db:save-call', (event, c: any): void => {
    assertTrustedSender(event)
    db.prepare(
      'INSERT OR REPLACE INTO call_history (id, contact_id, direction, media, status, started_at, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(c.id, c.contactId, c.direction, c.media, c.status, c.startedAt, c.durationS)
  })

  ipcMain.handle('db:get-call-history', (event, contactId: string, limit: number): any[] => {
    assertTrustedSender(event)
    const rows = db
      .prepare(
        'SELECT id, contact_id, direction, media, status, started_at, duration_s FROM call_history WHERE contact_id = ? ORDER BY started_at DESC LIMIT ?'
      )
      .all(contactId, limit) as any[]
    return rows.map((r) => ({
      id: r.id,
      contactId: r.contact_id,
      direction: r.direction,
      media: r.media,
      status: r.status,
      startedAt: r.started_at,
      durationS: r.duration_s
    }))
  })
}

export function closeDatabase(): void {
  if (db && db.open) {
    db.close()
  }
}
