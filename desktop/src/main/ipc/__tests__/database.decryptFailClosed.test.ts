/**
 * Regression test for golden rule #1 — "el cifrado nunca degrada en silencio".
 *
 * Desktop parity twin of mobile/src/db/__tests__/decryptFailClosed.test.ts.
 * decryptBody (DISPLAY path) may return a VISIBLE marker on failure, but the
 * KEY-MATERIAL path (decryptSecretOrNull, used by db:load-ratchet-session) MUST
 * fail closed by returning null — never the sentinel string, which would
 * otherwise be parsed into garbage key material.
 *
 * Real crypto: exercises the actual NaCl secretbox; only Electron's keystore
 * plumbing is mocked so getDbKey() can mint a key in memory.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import os from 'os';

let mockKeystore: Record<string, string> = {};
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

import { encryptBody, decryptBody, decryptSecretOrNull, resetDbKeyCache } from '../database';

const SENTINEL = '[DECRYPTION_ERROR]';

beforeEach(() => {
  mockKeystore = {};
  mockElectronFlags.isPackaged = false;
  mockElectronFlags.encryptionAvailable = false;
  resetDbKeyCache();
});

describe('at-rest decryption fail-closed semantics (desktop)', () => {
  it('round-trips a value through encryptBody/decryptBody/decryptSecretOrNull', () => {
    const plaintext = 'ratchet-state-or-secret-key-material';
    const enc = encryptBody(plaintext);
    expect(enc.startsWith('encv1:')).toBe(true);
    expect(decryptBody(enc)).toBe(plaintext);
    expect(decryptSecretOrNull(enc)).toBe(plaintext);
  });

  it('decryptSecretOrNull returns null (NOT the sentinel) on a corrupt envelope', () => {
    const result = decryptSecretOrNull('encv1:not-valid-json');
    expect(result).toBeNull();
    expect(result).not.toBe(SENTINEL);
  });

  it('decryptSecretOrNull returns null on an authentication (MAC) failure', () => {
    const enc = encryptBody('secret');
    const json = JSON.parse(enc.slice('encv1:'.length)) as { ct: string; n: string };
    const tamperedCt = json.ct.slice(0, -4) + (json.ct.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA');
    const tampered = 'encv1:' + JSON.stringify({ ct: tamperedCt, n: json.n });
    expect(decryptSecretOrNull(tampered)).toBeNull();
  });

  it('decryptBody (display path) still returns a VISIBLE marker on failure', () => {
    expect(decryptBody('encv1:not-valid-json')).toBe(SENTINEL);
  });

  it('passes through non-encrypted (no encv1: prefix) values unchanged', () => {
    expect(decryptBody('plain')).toBe('plain');
    expect(decryptSecretOrNull('plain')).toBe('plain');
  });
});
