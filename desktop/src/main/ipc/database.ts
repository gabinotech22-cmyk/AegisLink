import { ipcMain, app } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import Database from 'better-sqlite3'
import path from 'path'
import { is } from '@electron-toolkit/utils'

let db: Database.Database

function assertTrustedSender(e: IpcMainInvokeEvent): void {
  const url = e.senderFrame?.url ?? ''
  const trusted =
    url.startsWith('file://') ||
    (is.dev && url.startsWith(process.env['ELECTRON_RENDERER_URL'] ?? 'http://localhost'))
  if (!trusted) throw new Error('untrusted IPC sender')
}

function assertSafeSql(sql: string): void {
  if (typeof sql !== 'string' || sql.length > 4096) throw new Error('invalid sql')
  const upper = sql.toUpperCase()
  const blocked = ['ATTACH ', 'LOAD_EXTENSION', 'PRAGMA ']
  if (blocked.some((b) => upper.includes(b))) throw new Error('blocked sql keyword')
}

export function registerDatabaseHandlers(): void {
  const dbPath = path.join(app.getPath('userData'), 'aegislink.db')
  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON')

  // db:exec is intentionally NOT exposed over IPC — migrations run in main process only

  ipcMain.handle('db:run', (event, sql: string, params: unknown[]): Database.RunResult => {
    assertTrustedSender(event)
    assertSafeSql(sql)
    return db.prepare(sql).run(...params)
  })

  ipcMain.handle('db:all', (event, sql: string, params: unknown[]): unknown[] => {
    assertTrustedSender(event)
    assertSafeSql(sql)
    return db.prepare(sql).all(...params)
  })

  ipcMain.handle('db:get', (event, sql: string, params: unknown[]): unknown => {
    assertTrustedSender(event)
    assertSafeSql(sql)
    return db.prepare(sql).get(...params)
  })
}

export function closeDatabase(): void {
  if (db && db.open) {
    db.close()
  }
}
