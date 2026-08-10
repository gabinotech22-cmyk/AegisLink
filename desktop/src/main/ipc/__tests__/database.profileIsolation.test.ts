/**
 * Section 11 — isolated profiles, desktop.
 *
 * FIELD BUG THIS PINS: the renderer already exposed a multi-profile shaped API
 * (setActiveDbSlot, getSecretKeySlot, deleteIdentitySlot) and the keystore
 * allow-list already listed activeProfile / activeSlotId / slotsList, but the
 * main process honoured none of it: ONE database file, opened once with the
 * 'self' key, and a single cachedDbKey handed to every slot that asked. Wiring
 * a profile switcher to that would have written profile B's messages, encrypted
 * under A's key, into A's tables — apparent isolation, none of it real, in the
 * feature literally named "isolated profiles".
 *
 * Real crypto throughout: better-sqlite3-multiple-ciphers runs natively, so the
 * cipher here is the one that ships. Only Electron's keystore is mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let mockKeystore: Record<string, string> = {};
const mockElectronFlags = { isPackaged: false, encryptionAvailable: true };
let userDataDir = '';

/** channel -> handler, captured from ipcMain.handle at registration. */
const handlers = new Map<string, (...a: unknown[]) => unknown>();

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

vi.mock('../secureStorage', () => ({
  readKeystore: () => mockKeystore,
  writeKeystore: (k: Record<string, string>) => { mockKeystore = k; },
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (...a: unknown[]) => unknown) => { handlers.set(channel, fn); },
  },
  app: {
    get isPackaged() { return mockElectronFlags.isPackaged; },
    getPath: () => userDataDir,
  },
  safeStorage: {
    isEncryptionAvailable: () => mockElectronFlags.encryptionAvailable,
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
}));

import { registerDatabaseHandlers, openMainDbIfUnwrapped, resetDbKeyCache } from '../database';

/** A senderFrame the trusted-sender check accepts. */
const EVENT = { senderFrame: { url: 'file:///index.html' } };

function call(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`handler not registered: ${channel}`);
  return fn(EVENT, ...args);
}

const OTHER = 'XYZ-1111-2222';

function msg(id: string, chatId: string, body: string) {
  return { id, chatId, direction: 'out', body, createdAt: 1700000000000 };
}

beforeEach(() => {
  mockKeystore = {};
  mockElectronFlags.isPackaged = false;
  mockElectronFlags.encryptionAvailable = true;
  handlers.clear();
  resetDbKeyCache();
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-profiles-'));
  registerDatabaseHandlers();
  openMainDbIfUnwrapped();
});

afterEach(() => {
  resetDbKeyCache();
  try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('one database file per profile', () => {
  it('keeps each profile in its own file, named after the slot', () => {
    call('db:save-message', 'self', msg('m1', 'chat-a', 'from the first profile'));
    call('db:switch-slot', OTHER);
    call('db:save-message', OTHER, msg('m2', 'chat-b', 'from the second profile'));

    expect(fs.existsSync(path.join(userDataDir, 'aegislink.db'))).toBe(true);
    expect(fs.existsSync(path.join(userDataDir, `aegislink-${OTHER}.db`))).toBe(true);
  });

  it('does not show one profile the other profile’s messages', () => {
    call('db:save-message', 'self', msg('m1', 'shared-chat-id', 'private to the first'));
    expect(call('db:load-messages-by-chat', 'self', 'shared-chat-id')).toHaveLength(1);

    // Same chatId on purpose: a slot COLUMN would have needed a WHERE clause
    // here, and forgetting it is exactly the leak this design removes.
    call('db:switch-slot', OTHER);
    expect(call('db:load-messages-by-chat', OTHER, 'shared-chat-id')).toHaveLength(0);

    call('db:save-message', OTHER, msg('m2', 'shared-chat-id', 'private to the second'));
    const second = call('db:load-messages-by-chat', OTHER, 'shared-chat-id') as { body: string }[];
    expect(second).toHaveLength(1);
    expect(second[0].body).toBe('private to the second');

    call('db:switch-slot', 'self');
    const first = call('db:load-messages-by-chat', 'self', 'shared-chat-id') as { body: string }[];
    expect(first).toHaveLength(1);
    expect(first[0].body).toBe('private to the first');
  });

  it('gives each profile its own DB key', () => {
    call('db:save-message', 'self', msg('m1', 'c', 'x'));
    call('db:switch-slot', OTHER);
    call('db:save-message', OTHER, msg('m2', 'c', 'y'));

    const a = mockKeystore['aegis.dbEncKey.b64'];
    const b = mockKeystore[`aegis.${OTHER}.dbEncKey.b64`];
    expect(a).toBeTruthy();
    expect(b).toBeTruthy();
    // The single cachedDbKey bug made these identical.
    expect(a).not.toBe(b);
  });

  it('refuses a slot id that is not safe to use as a filename', () => {
    expect(() => call('db:switch-slot', '../../etc/passwd')).toThrow(/invalid slot id/i);
    expect(() => call('db:switch-slot', 'a/b')).toThrow(/invalid slot id/i);
  });
});

describe('the slot guard', () => {
  it('refuses a write whose slot is not the open profile', () => {
    // The renderer believes it is on OTHER while 'self' is open. Writing here
    // would encrypt B's body with A's key and file it in A's table.
    expect(() => call('db:save-message', OTHER, msg('m1', 'c', 'wrong profile')))
      .toThrow(/profile mismatch/i);
  });

  it('refuses a read whose slot is not the open profile', () => {
    call('db:switch-slot', OTHER);
    expect(() => call('db:load-messages-by-chat', 'self', 'c')).toThrow(/profile mismatch/i);
  });
});

describe('the app lock covers every profile', () => {
  const KEK_B64 = Buffer.from(new Uint8Array(32).fill(7)).toString('base64');

  it('wraps the keys of profiles that are not the active one', () => {
    // Two profiles exist, both with keys minted before the lock is enabled.
    call('db:save-message', 'self', msg('m1', 'c', 'a'));
    call('db:switch-slot', OTHER);
    call('db:save-message', OTHER, msg('m2', 'c', 'b'));
    call('db:switch-slot', 'self');

    call('db:enable-pin-wrap', KEK_B64);

    // A PIN that guards your main profile and leaves the second one openable
    // is worse than no PIN: it reads as protected.
    expect(mockKeystore['aegis.dbEncKey.b64']).toMatch(/^pinv1/);
    expect(mockKeystore[`aegis.${OTHER}.dbEncKey.b64`]).toMatch(/^pinv1/);
  });

  it('unwraps every profile when the lock is turned off', () => {
    call('db:save-message', 'self', msg('m1', 'c', 'a'));
    call('db:switch-slot', OTHER);
    call('db:save-message', OTHER, msg('m2', 'c', 'b'));
    call('db:switch-slot', 'self');
    call('db:enable-pin-wrap', KEK_B64);

    call('db:disable-pin-wrap');

    // Leaving a profile wrapped under a PIN that no longer exists would make it
    // permanently unreadable — silent data loss, not a lock.
    expect(mockKeystore['aegis.dbEncKey.b64']).not.toMatch(/^pinv1/);
    expect(mockKeystore[`aegis.${OTHER}.dbEncKey.b64`]).not.toMatch(/^pinv1/);
  });

  it('wraps a profile created while the lock is already on', () => {
    call('db:enable-pin-wrap', KEK_B64);
    call('db:switch-slot', OTHER); // mints OTHER's key for the first time
    expect(mockKeystore[`aegis.${OTHER}.dbEncKey.b64`]).toMatch(/^pinv1/);
  });

  it('fails closed when a wrapped profile is opened with no KEK cached', () => {
    call('db:enable-pin-wrap', KEK_B64);
    resetDbKeyCache(); // simulates a cold start: nothing unlocked yet
    expect(() => call('db:switch-slot', OTHER)).toThrow(/PIN-locked/i);
  });
});

describe('panic', () => {
  it('wipes the other profiles too, files and keys', () => {
    call('db:save-message', 'self', msg('m1', 'c', 'a'));
    call('db:switch-slot', OTHER);
    call('db:save-message', OTHER, msg('m2', 'c', 'b'));
    call('db:switch-slot', 'self');

    const otherPath = path.join(userDataDir, `aegislink-${OTHER}.db`);
    expect(fs.existsSync(otherPath)).toBe(true);

    call('db:wipe-database', 'self');

    // A second profile surviving a panic wipe breaks the promise outright, and
    // its presence on disk is itself the evidence the wipe exists to destroy.
    expect(fs.existsSync(otherPath)).toBe(false);
    expect(mockKeystore[`aegis.${OTHER}.dbEncKey.b64`]).toBeUndefined();
    expect(mockKeystore['aegis.dbEncKey.b64']).toBeUndefined();
    // The roster is metadata as well: it records who existed.
    expect(mockKeystore['aegis.slotsList']).toBeUndefined();
  });

  it('empties the active profile', () => {
    call('db:save-message', 'self', msg('m1', 'c', 'a'));
    call('db:wipe-database', 'self');
    expect(call('db:load-messages-by-chat', 'self', 'c')).toHaveLength(0);
  });
});
