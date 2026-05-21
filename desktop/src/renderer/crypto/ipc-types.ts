/**
 * Renderer-side IPC contract — mirrors the surface exposed by
 * desktop/src/preload/index.ts via contextBridge.exposeInMainWorld('aegis', ...).
 *
 * The renderer NEVER accesses Node APIs directly. Every persistent / OS
 * operation goes through these typed IPC channels.
 */

export interface AegisIPC {
  secureStorage: {
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<void>;
  };
  db: {
    exec(sql: string): Promise<void>;
    run(
      sql: string,
      params?: unknown[]
    ): Promise<{ changes: number; lastInsertRowid: number }>;
    all(sql: string, params?: unknown[]): Promise<unknown[]>;
    get(sql: string, params?: unknown[]): Promise<unknown | undefined>;
  };
  notifications: {
    show(title: string, body: string): Promise<void>;
  };
}

declare global {
  interface Window {
    aegis: AegisIPC;
  }
}

export {};
