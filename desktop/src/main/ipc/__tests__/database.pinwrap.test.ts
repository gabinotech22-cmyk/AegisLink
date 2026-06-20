/**
 * C-2 Fase 2 — PIN-wrapped DB key (second factor at-rest).
 *
 * Real crypto: nacl.secretbox runs in pure JS; we mock only Electron's
 * safeStorage (the DPAPI outer layer) and the keystore. These tests pin the
 * security-critical core: a correct KEK round-trips the DB key, a WRONG KEK
 * (wrong PIN) FAILS CLOSED (throws, never returns a fresh/garbage key), and the
 * format is recognised vs the legacy DPAPI-only formats.
 */
import { describe, it, expect, vi } from 'vitest';
import nacl from 'tweetnacl';

const mockElectronFlags = { isPackaged: false, encryptionAvailable: true };

vi.mock('@electron-toolkit/utils', () => ({ is: { dev: false } }));
vi.mock('../secureStorage', () => ({
  readKeystore: () => ({}),
  writeKeystore: () => {},
}));
vi.mock('electron', () => ({
  ipcMain: { handle: () => {} },
  app: {
    get isPackaged() { return mockElectronFlags.isPackaged; },
    getPath: () => '/tmp',
  },
  safeStorage: {
    isEncryptionAvailable: () => mockElectronFlags.encryptionAvailable,
    // Identity "encryption" is enough to exercise the DPAPI wrap/unwrap layer.
    encryptString: (s: string) => Buffer.from(s, 'utf-8'),
    decryptString: (b: Buffer) => b.toString('utf-8'),
  },
}));

import { wrapDbKeyUnderPin, unwrapDbKeyUnderPin, isPinWrapped } from '../database';

const dbKey = () => nacl.randomBytes(32);
const kekFrom = (seed: number) => {
  const k = new Uint8Array(32);
  k.fill(seed);
  return k;
};

describe('C-2 Fase 2 — PIN-wrapped DB key', () => {
  it('round-trips the DB key under the correct KEK (DPAPI layer on)', () => {
    mockElectronFlags.encryptionAvailable = true;
    const key = dbKey();
    const kek = kekFrom(7);
    const wrapped = wrapDbKeyUnderPin(key, kek);
    expect(wrapped.startsWith('pinv1:')).toBe(true);
    const out = unwrapDbKeyUnderPin(wrapped, kek);
    expect(Buffer.from(out)).toEqual(Buffer.from(key));
  });

  it('FAILS CLOSED with a wrong KEK (wrong PIN) — throws, never returns a key', () => {
    const key = dbKey();
    const wrapped = wrapDbKeyUnderPin(key, kekFrom(7));
    expect(() => unwrapDbKeyUnderPin(wrapped, kekFrom(9))).toThrow(/incorrect PIN/i);
  });

  it('uses the dev plaintext fallback only when safeStorage is unavailable', () => {
    mockElectronFlags.isPackaged = false;
    mockElectronFlags.encryptionAvailable = false;
    const key = dbKey();
    const kek = kekFrom(3);
    const wrapped = wrapDbKeyUnderPin(key, kek);
    expect(wrapped.startsWith('pinv1plain:')).toBe(true);
    expect(Buffer.from(unwrapDbKeyUnderPin(wrapped, kek))).toEqual(Buffer.from(key));
  });

  it('fails closed when packaged + safeStorage unavailable (no plaintext wrap)', () => {
    mockElectronFlags.isPackaged = true;
    mockElectronFlags.encryptionAvailable = false;
    expect(() => wrapDbKeyUnderPin(dbKey(), kekFrom(1))).toThrow(/secure storage unavailable/i);
    mockElectronFlags.isPackaged = false;
    mockElectronFlags.encryptionAvailable = true;
  });

  it('isPinWrapped recognises pinv1 formats and rejects legacy / empty', () => {
    expect(isPinWrapped('pinv1:abc.def')).toBe(true);
    expect(isPinWrapped('pinv1plain:abc.def')).toBe(true);
    expect(isPinWrapped('enc:abc')).toBe(false);
    expect(isPinWrapped('plain:abc')).toBe(false);
    expect(isPinWrapped(undefined)).toBe(false);
    expect(isPinWrapped('')).toBe(false);
  });
});
