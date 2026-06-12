import { ipcMain, app, safeStorage } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import Database from 'better-sqlite3'
import path from 'path'
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

// ─── DB encryption at-rest ───────────────────────────────────────────────────

function getDbEncKeySlot(slot = 'self'): string {
  return slot === 'self' ? 'aegis.dbEncKey.b64' : `aegis.${slot}.dbEncKey.b64`
}

function getDbKey(slot = 'self'): Uint8Array {
  if (cachedDbKey) return cachedDbKey
  const slotKey = getDbEncKeySlot(slot)
  const keystore = readKeystore()
  const encoded = keystore[slotKey]
  if (!encoded) {
    const keyBytes = nacl.randomBytes(32)
    const rawVal = encodeBase64(keyBytes)
    if (safeStorage.isEncryptionAvailable()) {
      keystore[slotKey] = 'enc:' + safeStorage.encryptString(rawVal).toString('base64')
    } else {
      keystore[slotKey] = 'plain:' + Buffer.from(rawVal, 'utf-8').toString('base64')
    }
    writeKeystore(keystore)
    cachedDbKey = keyBytes
  } else {
    try {
      let decrypted = ''
      if (encoded.startsWith('plain:')) {
        decrypted = Buffer.from(encoded.slice(6), 'base64').toString('utf-8')
      } else {
        const raw = encoded.startsWith('enc:') ? encoded.slice(4) : encoded
        decrypted = safeStorage.decryptString(Buffer.from(raw, 'base64'))
      }
      cachedDbKey = decodeBase64(decrypted)
    } catch {
      const keyBytes = nacl.randomBytes(32)
      cachedDbKey = keyBytes
    }
  }
  return cachedDbKey
}

function encryptBody(body: string, slot = 'self'): string {
  try {
    const key = getDbKey(slot)
    const nonce = nacl.randomBytes(nacl.secretbox.nonceLength)
    const bodyBytes = new TextEncoder().encode(body)
    const encrypted = nacl.secretbox(bodyBytes, nonce, key)
    const result = { ct: encodeBase64(encrypted), n: encodeBase64(nonce) }
    return 'encv1:' + JSON.stringify(result)
  } catch {
    return body
  }
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

// ─── Handlers Registration ────────────────────────────────────────────────────

export function registerDatabaseHandlers(): void {
  const dbPath = path.join(app.getPath('userData'), 'aegislink.db')
  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON')

  // Run database schema and migrations
  ensureSchema(db)

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
    db.prepare('DELETE FROM messages').run()
    db.prepare('DELETE FROM contacts').run()
    db.prepare('DELETE FROM groups').run()
    db.prepare('DELETE FROM ratchet_sessions').run()
    db.prepare('DELETE FROM chat_state').run()
    db.prepare('DELETE FROM call_history').run()
    db.prepare('DELETE FROM identity').run()
    cachedDbKey = null
    const keystore = readKeystore()
    delete keystore[getDbEncKeySlot(activeSlot)]
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
