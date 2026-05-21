import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Expose electron-toolkit helpers (e.g. process versions) safely
contextBridge.exposeInMainWorld('electron', electronAPI)

// Expose AegisLink IPC surface — no raw ipcRenderer access in renderer
contextBridge.exposeInMainWorld('aegis', {
  secureStorage: {
    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('secureStorage:set', key, value),
    get: (key: string): Promise<string | null> =>
      ipcRenderer.invoke('secureStorage:get', key),
    delete: (key: string): Promise<void> =>
      ipcRenderer.invoke('secureStorage:delete', key)
  },
  db: {
    exec: (sql: string): Promise<void> =>
      ipcRenderer.invoke('db:exec', sql),
    run: (sql: string, params?: unknown[]): Promise<import('better-sqlite3').RunResult> =>
      ipcRenderer.invoke('db:run', sql, params ?? []),
    all: (sql: string, params?: unknown[]): Promise<unknown[]> =>
      ipcRenderer.invoke('db:all', sql, params ?? []),
    get: (sql: string, params?: unknown[]): Promise<unknown> =>
      ipcRenderer.invoke('db:get', sql, params ?? [])
  },
  notifications: {
    show: (title: string, body: string): Promise<void> =>
      ipcRenderer.invoke('notifications:show', title, body)
  }
})
