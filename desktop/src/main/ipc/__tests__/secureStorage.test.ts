/**
 * secureStorage.test.ts — desktop IPC keystore guards (Ola 5 HIGH "suite mínima").
 *
 * The renderer can only reach the OS keychain through these three handlers, so
 * their guards ARE the trust boundary:
 *   - assertTrustedSender  — only the bundled file:// frame (or the dev renderer
 *     URL) may invoke; a hijacked/remote frame is rejected.
 *   - assertKeyAllowed     — a strict allowlist so a compromised renderer cannot
 *     read/write arbitrary keystore entries, only the known `aegis.*` keys.
 *   - assertValidKey/Value — bounds on key/value shape.
 * Plus the production fail-closed rules (golden rule #1/#6): a packaged build
 * never writes plaintext when safeStorage is down and never *serves* a stray
 * `plain:` entry; and panic wipe-prekeys must clear every prekey secret.
 *
 * We exercise the REAL handlers end-to-end by capturing them from a mocked
 * ipcMain.handle and invoking them with synthetic IpcMainInvokeEvents — same
 * Electron-mock convention as database.sqlcipher.test.ts in this directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { IpcMainInvokeEvent } from 'electron';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;
const handlers: Record<string, Handler> = {};

// Mutable Electron behaviour so individual tests can force each path.
const flags = { isPackaged: false, encryptionAvailable: true, userData: '' };

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers[channel] = fn;
    },
  },
  app: {
    get isPackaged() {
      return flags.isPackaged;
    },
    getPath: () => flags.userData,
  },
  safeStorage: {
    isEncryptionAvailable: () => flags.encryptionAvailable,
    // Reversible stand-in for the OS keychain: prefix so we can assert the
    // 'enc:' path was taken, and so decrypt is the exact inverse.
    encryptString: (s: string) => Buffer.from('K:' + s, 'utf-8'),
    decryptString: (b: Buffer) => {
      const raw = b.toString('utf-8');
      if (!raw.startsWith('K:')) throw new Error('bad ciphertext');
      return raw.slice(2);
    },
  },
}));

// Imported AFTER the mocks above.
import { registerSecureStorageHandlers, readKeystore } from '../secureStorage';

registerSecureStorageHandlers();

const TRUSTED = { senderFrame: { url: 'file:///C:/app/index.html' } } as unknown as IpcMainInvokeEvent;
const UNTRUSTED = { senderFrame: { url: 'https://evil.example/x' } } as unknown as IpcMainInvokeEvent;

const set = (e: IpcMainInvokeEvent, k: unknown, v: unknown) =>
  handlers['secureStorage:set'](e, k, v);
const get = (e: IpcMainInvokeEvent, k: unknown) => handlers['secureStorage:get'](e, k) as string | null;
const del = (e: IpcMainInvokeEvent, k: unknown) => handlers['secureStorage:delete'](e, k);
const wipePrekeys = (e: IpcMainInvokeEvent) => handlers['secureStorage:wipe-prekeys'](e);

beforeEach(() => {
  flags.isPackaged = false;
  flags.encryptionAvailable = true;
  flags.userData = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-keystore-'));
});

afterEach(() => {
  try {
    fs.rmSync(flags.userData, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('assertTrustedSender — IPC trust boundary', () => {
  it('rejects every handler from an untrusted (remote) frame', () => {
    expect(() => set(UNTRUSTED, 'aegis.secretKey.b64', 'v')).toThrow(/untrusted IPC sender/);
    expect(() => get(UNTRUSTED, 'aegis.secretKey.b64')).toThrow(/untrusted IPC sender/);
    expect(() => del(UNTRUSTED, 'aegis.secretKey.b64')).toThrow(/untrusted IPC sender/);
    expect(() => wipePrekeys(UNTRUSTED)).toThrow(/untrusted IPC sender/);
  });

  it('accepts the bundled file:// frame', () => {
    expect(() => set(TRUSTED, 'aegis.secretKey.b64', 'v')).not.toThrow();
  });
});

describe('assertKeyAllowed — keystore allowlist', () => {
  it('rejects a key outside the allowlist on set/get/delete', () => {
    expect(() => set(TRUSTED, 'aegis.notAllowed', 'v')).toThrow(/not whitelisted/);
    expect(() => get(TRUSTED, 'aegis.notAllowed')).toThrow(/not whitelisted/);
    expect(() => del(TRUSTED, 'aegis.notAllowed')).toThrow(/not whitelisted/);
  });

  it('rejects keys that merely look related but are not exact matches', () => {
    expect(() => set(TRUSTED, 'aegis.secretKey.b64.evil', 'v')).toThrow(/not whitelisted/);
    expect(() => set(TRUSTED, 'notaegis.secretKey.b64', 'v')).toThrow(/not whitelisted/);
    expect(() => set(TRUSTED, 'aegis.secretKey', 'v')).toThrow(/not whitelisted/);
  });

  it('accepts the known static, profile-scoped, and dynamic key shapes', () => {
    const ok = [
      'aegis.secretKey.b64',
      'aegis.signSecretKey.b64',
      'aegis.work.displayName', // profile-scoped prefix
      'aegis.opkSecret.42', // dynamic keyId
      'aegis.pqSpkSecret.7',
      'aegis.self.ratchet.ABCD-EFGH-JKMN', // Crockford base32 id
      'aegis.prekeys.v1',
    ];
    for (const k of ok) expect(() => set(TRUSTED, k, 'v')).not.toThrow();
  });
});

describe('assertValidKey / assertValidValue — shape bounds', () => {
  it('rejects an empty, oversized, or non-string key', () => {
    expect(() => get(TRUSTED, '')).toThrow(/invalid key/);
    expect(() => get(TRUSTED, 'a'.repeat(513))).toThrow(/invalid key/);
    expect(() => get(TRUSTED, 123)).toThrow(/invalid key/);
  });

  it('rejects an oversized value', () => {
    expect(() => set(TRUSTED, 'aegis.secretKey.b64', 'x'.repeat(65537))).toThrow(/invalid value/);
  });
});

describe('round-trip via the OS keychain (safeStorage available)', () => {
  it('encrypts on set (enc: prefix) and decrypts on get', () => {
    set(TRUSTED, 'aegis.secretKey.b64', 'super-secret');
    // Stored ciphertext must carry the enc: marker, never the raw value.
    const stored = readKeystore()['aegis.secretKey.b64'];
    expect(stored.startsWith('enc:')).toBe(true);
    expect(stored.includes('super-secret')).toBe(false);
    expect(get(TRUSTED, 'aegis.secretKey.b64')).toBe('super-secret');
  });

  it('get returns null for an absent key, and delete removes it', () => {
    expect(get(TRUSTED, 'aegis.displayName')).toBeNull();
    set(TRUSTED, 'aegis.displayName', 'alice');
    expect(get(TRUSTED, 'aegis.displayName')).toBe('alice');
    del(TRUSTED, 'aegis.displayName');
    expect(get(TRUSTED, 'aegis.displayName')).toBeNull();
  });
});

describe('production fail-closed (golden rule #1/#6)', () => {
  it('refuses to write plaintext when safeStorage is down in a packaged build', () => {
    flags.encryptionAvailable = false;
    flags.isPackaged = true;
    expect(() => set(TRUSTED, 'aegis.secretKey.b64', 'v')).toThrow(/safeStorage unavailable/i);
  });

  it('never serves a stray plain: entry in a packaged build (returns null, not the secret)', () => {
    // Simulate a dev-written plaintext entry that survives into a packaged build.
    flags.encryptionAvailable = false; // dev fallback writes plain:
    set(TRUSTED, 'aegis.secretKey.b64', 'leaked');
    expect(readKeystore()['aegis.secretKey.b64'].startsWith('plain:')).toBe(true);
    // Now "ship" it: packaged build must refuse to return the plaintext.
    flags.isPackaged = true;
    expect(get(TRUSTED, 'aegis.secretKey.b64')).toBeNull();
  });
});

describe('panic wipe-prekeys', () => {
  it('clears every prekey secret + secdiag but keeps identity/profile keys', () => {
    const keep = ['aegis.secretKey.b64', 'aegis.signSecretKey.b64', 'aegis.displayName'];
    const wipe = [
      'aegis.spkSecret.b64',
      'aegis.spkSecret.3',
      'aegis.spk.keyId',
      'aegis.pqSpkSecret.9',
      'aegis.pqSpk.keyId',
      'aegis.opkIds.json',
      'aegis.opkSecret.12',
      'aegis.secdiag.v1',
    ];
    for (const k of [...keep, ...wipe]) set(TRUSTED, k, 'v');

    wipePrekeys(TRUSTED);

    const after = readKeystore();
    for (const k of keep) expect(after[k]).toBeDefined();
    for (const k of wipe) expect(after[k]).toBeUndefined();
  });
});
