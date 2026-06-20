/**
 * Ola 10 — SQLCipher at-rest encryption (desktop).
 *
 * Real crypto: better-sqlite3-multiple-ciphers runs natively in Node, so these
 * tests exercise the ACTUAL cipher — not a mock. We mock only Electron's
 * keystore plumbing so getDbKey() can mint/persist a key in memory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import RawDatabase from 'better-sqlite3-multiple-ciphers';

// In-memory keystore backing the mocked secureStorage (reset per test).
let mockKeystore: Record<string, string> = {};
// Mutable flags so a test can force the fail-closed path.
const mockElectronFlags = { isPackaged: false, encryptionAvailable: false };

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

vi.mock('../secureStorage', () => ({
  readKeystore: () => mockKeystore,
  writeKeystore: (k: Record<string, string>) => { mockKeystore = k; },
}));

vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: {
    get isPackaged() { return mockElectronFlags.isPackaged; },
    getPath: () => os.tmpdir(),
  },
  safeStorage: {
    isEncryptionAvailable: () => mockElectronFlags.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
}));

// Imported AFTER the mocks above.
import { openEncrypted, resetDbKeyCache } from '../database';

let dir: string;
let dbPath: string;

beforeEach(() => {
  mockKeystore = {};
  mockElectronFlags.isPackaged = false;
  mockElectronFlags.encryptionAvailable = false;
  resetDbKeyCache();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-sqlcipher-'));
  dbPath = path.join(dir, 'aegislink.db');
});

afterEach(() => {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('openEncrypted — whole-DB SQLCipher', () => {
  it('creates an encrypted DB that is unreadable without the key', () => {
    const db = openEncrypted(dbPath);
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (v) VALUES (?)').run('secret-value');
    db.close();

    // The raw file must NOT be a readable SQLite DB without the cipher key.
    const noKey = new RawDatabase(dbPath);
    expect(() => noKey.exec('SELECT count(*) FROM sqlite_master')).toThrow(/not a database/i);
    noKey.close();

    // The plaintext bytes must not appear on disk.
    const bytes = fs.readFileSync(dbPath);
    expect(bytes.includes(Buffer.from('secret-value'))).toBe(false);
    // A SQLCipher file does NOT start with the "SQLite format 3" magic header.
    expect(bytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
  });

  it('migrates a legacy PLAINTEXT database in place, preserving all rows', () => {
    // Seed a plaintext DB (no key) with rows.
    const plain = new RawDatabase(dbPath);
    plain.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const ins = plain.prepare('INSERT INTO t (v) VALUES (?)');
    for (const v of ['a', 'b', 'c']) ins.run(v);
    plain.close();
    expect(fs.readFileSync(dbPath).subarray(0, 15).toString('latin1')).toBe('SQLite format 3');

    // openEncrypted must detect plaintext, migrate, and return a keyed handle.
    const db = openEncrypted(dbPath);
    const row = db.prepare('SELECT count(*) AS n FROM t').get() as { n: number };
    expect(row.n).toBe(3);
    db.close();

    // The file on disk is now encrypted (unreadable without key).
    const noKey = new RawDatabase(dbPath);
    expect(() => noKey.exec('SELECT count(*) FROM sqlite_master')).toThrow(/not a database/i);
    noKey.close();
    // No leftover temp export file.
    expect(fs.existsSync(dbPath + '.sqlcipher-enc')).toBe(false);
  });

  it('re-opening an already-encrypted DB with the same key works (idempotent, no migration)', () => {
    openEncrypted(dbPath).close();
    resetDbKeyCache(); // force a fresh getDbKey() read from the keystore
    const db = openEncrypted(dbPath);
    expect(() => db.exec('SELECT count(*) FROM sqlite_master')).not.toThrow();
    db.close();
  });

  it('fails closed when OS secure storage is unavailable in a packaged build', () => {
    mockElectronFlags.isPackaged = true;        // production
    mockElectronFlags.encryptionAvailable = false; // no safeStorage
    resetDbKeyCache();
    expect(() => openEncrypted(dbPath)).toThrow(/secure storage unavailable/i);
  });
});
