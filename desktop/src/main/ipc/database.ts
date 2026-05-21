import { ipcMain, app } from 'electron'
import Database from 'better-sqlite3'
import path from 'path'

let db: Database.Database

export function registerDatabaseHandlers(): void {
  const dbPath = path.join(app.getPath('userData'), 'aegislink.db')
  db = new Database(dbPath)

  // Enable WAL mode for better concurrent read performance
  db.pragma('journal_mode = WAL')
  // Enforce foreign key constraints
  db.pragma('foreign_keys = ON')

  ipcMain.handle('db:exec', (_event, sql: string): void => {
    db.exec(sql)
  })

  ipcMain.handle('db:run', (_event, sql: string, params: unknown[]): Database.RunResult => {
    return db.prepare(sql).run(...params)
  })

  ipcMain.handle('db:all', (_event, sql: string, params: unknown[]): unknown[] => {
    return db.prepare(sql).all(...params)
  })

  ipcMain.handle('db:get', (_event, sql: string, params: unknown[]): unknown => {
    return db.prepare(sql).get(...params)
  })
}

export function closeDatabase(): void {
  if (db && db.open) {
    db.close()
  }
}
