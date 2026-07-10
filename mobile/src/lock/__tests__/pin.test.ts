/**
 * pin.test.ts — app-lock PIN hashing (lock/pin.ts).
 *
 * Covers:
 *   - set/verify round-trip on the current 'a3:' format
 *   - wrong PIN rejected
 *   - 'a2:' (old heavyweight Argon2id) hashes verify and upgrade to 'a3:'
 *   - legacy SHA-256 hashes verify and upgrade to 'a3:'
 *   - duress-salt hashing round-trip + old-format acceptance
 */

const mockStore = new Map<string, string>();
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: async (k: string) => mockStore.get(k) ?? null,
    set: async (k: string, v: string) => { mockStore.set(k, v); },
    delete: async (k: string) => { mockStore.delete(k); },
  },
}));

jest.mock('expo-crypto', () => {
  const { createHash } = require('node:crypto');
  return {
    CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
    digestStringAsync: async (_alg: string, data: string) =>
      createHash('sha256').update(data, 'utf8').digest('hex'),
  };
});

// The a2-migration tests pay the old 46 MiB / 3-pass Argon2id cost once each.
// In pure JS (noble) a single 46 MiB derivation runs ~80-130 s on this machine
// and slower on CI runners, so the per-test budget must clear several of those.
// 120 s was enough locally but timed out the a2-upgrade test in CI.
jest.setTimeout(600_000);

import { argon2id } from '@noble/hashes/argon2';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { createHash } from 'node:crypto';
import {
  setPIN,
  verifyPIN,
  hasStoredPIN,
  clearPIN,
  hashPinWithSalt,
  verifyPinWithSalt,
  DURESS_PIN_SALT,
  getStoredPinLength,
  setStoredPinLength,
} from '../pin';

// pin.ts imports nobleNextTickPatch, which swaps noble's nextTick for a
// setTimeout(0) macrotask so async Argon2id yields to the UI on-device. There
// is no UI in a Jest run, and paying a setTimeout round-trip every 25 ms turns
// the 46 MiB a2 derivations into multi-minute runs that blow the test timeout.
// Restore the cheap microtask yield: the KDF is still computed for real (so the
// a2→a3 upgrade is genuinely exercised), only the UI-yield overhead is removed.
(require('@noble/hashes/utils') as { nextTick: () => Promise<void> }).nextTick = () => Promise.resolve();

const PIN_HASH_KEY = 'aegis.pin.hash';
const PIN_SALT_KEY = 'aegis.pin.salt.v2';
const LEGACY_PIN_SALT = 'aegislink:pin:v1:';
const ARGON_V2 = { t: 3, m: 47104, p: 1, dkLen: 32 } as const;
const enc = new TextEncoder();

function sha256Hex(s: string): string {
  return createHash('sha256').update(s, 'utf8').digest('hex');
}

beforeEach(() => mockStore.clear());

describe('app-lock PIN (a3 format)', () => {
  it('round-trips set → verify and stores an a3 hash', async () => {
    await setPIN('1234');
    expect(await hasStoredPIN()).toBe(true);
    expect(mockStore.get(PIN_HASH_KEY)).toMatch(/^a3:/);
    expect(await verifyPIN('1234')).toBe(true);
    expect(await verifyPIN('9999')).toBe(false);
  });

  it('clearPIN removes the stored hash', async () => {
    await setPIN('1234');
    await clearPIN();
    expect(await hasStoredPIN()).toBe(false);
    expect(await verifyPIN('1234')).toBe(false);
  });

  it('clearPIN also removes the per-install salt, leaving no orphaned trace', async () => {
    await setPIN('1234');
    expect(mockStore.has(PIN_SALT_KEY)).toBe(true);
    await clearPIN();
    expect(mockStore.has(PIN_HASH_KEY)).toBe(false);
    expect(mockStore.has(PIN_SALT_KEY)).toBe(false);
    // A fresh setPIN() after clearing must still work (mints a new salt).
    await setPIN('5678');
    expect(await verifyPIN('5678')).toBe(true);
  });

  it('verifies an old a2 hash and upgrades it to a3', async () => {
    const salt = new Uint8Array(16).fill(7);
    mockStore.set(PIN_SALT_KEY, encodeBase64(salt));
    const a2 = 'a2:' + encodeBase64(argon2id(enc.encode('1234'), salt, ARGON_V2));
    mockStore.set(PIN_HASH_KEY, a2);

    expect(await verifyPIN('1234')).toBe(true);
    expect(mockStore.get(PIN_HASH_KEY)).toMatch(/^a3:/); // upgraded
    expect(await verifyPIN('1234')).toBe(true); // still verifies post-upgrade
    // salt must survive the upgrade (a3 hash uses the same per-install salt)
    expect(decodeBase64(mockStore.get(PIN_SALT_KEY)!)).toEqual(salt);
  });

  it('verifies a legacy SHA-256 hash and upgrades it to a3', async () => {
    mockStore.set(PIN_HASH_KEY, sha256Hex(LEGACY_PIN_SALT + '1234'));
    expect(await verifyPIN('1234')).toBe(true);
    expect(mockStore.get(PIN_HASH_KEY)).toMatch(/^a3:/);
    expect(await verifyPIN('1234')).toBe(true);
  });

  it('rejects the wrong PIN against an old a2 hash without upgrading', async () => {
    const salt = new Uint8Array(16).fill(7);
    mockStore.set(PIN_SALT_KEY, encodeBase64(salt));
    const a2 = 'a2:' + encodeBase64(argon2id(enc.encode('1234'), salt, ARGON_V2));
    mockStore.set(PIN_HASH_KEY, a2);

    expect(await verifyPIN('0000')).toBe(false);
    expect(mockStore.get(PIN_HASH_KEY)).toBe(a2); // untouched
  });

  it('setPIN persists the PIN length flag (4 vs 6) for the lock screen', async () => {
    expect(await getStoredPinLength()).toBeNull(); // no flag yet — migration case
    await setPIN('1234');
    expect(await getStoredPinLength()).toBe(4);
    await setPIN('123456');
    expect(await getStoredPinLength()).toBe(6);
  });

  it('rejects a PIN that is not exactly 4 or 6 digits without persisting anything', async () => {
    await expect(setPIN('12345')).rejects.toThrow(/4 or 6/);
    expect(mockStore.has(PIN_HASH_KEY)).toBe(false);
    expect(mockStore.has(PIN_SALT_KEY)).toBe(false);
    expect(await getStoredPinLength()).toBeNull();
    expect(await hasStoredPIN()).toBe(false);
  });

  it('setStoredPinLength persists the flag without touching the hash', async () => {
    await setPIN('1234');
    const hashBefore = mockStore.get(PIN_HASH_KEY);
    await setStoredPinLength(6);
    expect(await getStoredPinLength()).toBe(6);
    expect(mockStore.get(PIN_HASH_KEY)).toBe(hashBefore); // untouched
  });

  it('clearPIN also removes the stored PIN length flag', async () => {
    await setPIN('1234');
    expect(await getStoredPinLength()).toBe(4);
    await clearPIN();
    expect(await getStoredPinLength()).toBeNull();
  });
});

describe('duress PIN (caller-supplied salt)', () => {
  it('round-trips hash → verify on the a3 format', async () => {
    const stored = await hashPinWithSalt('4321', DURESS_PIN_SALT);
    expect(stored).toMatch(/^a3:/);
    expect(await verifyPinWithSalt('4321', DURESS_PIN_SALT, stored)).toBe(true);
    expect(await verifyPinWithSalt('1111', DURESS_PIN_SALT, stored)).toBe(false);
  });

  it('accepts an old a2 duress hash', async () => {
    const a2 =
      'a2:' +
      encodeBase64(argon2id(enc.encode('4321'), enc.encode(DURESS_PIN_SALT), ARGON_V2));
    expect(await verifyPinWithSalt('4321', DURESS_PIN_SALT, a2)).toBe(true);
    expect(await verifyPinWithSalt('1111', DURESS_PIN_SALT, a2)).toBe(false);
  });

  it('accepts a legacy SHA-256 duress hash', async () => {
    const legacy = sha256Hex(DURESS_PIN_SALT + '4321');
    expect(await verifyPinWithSalt('4321', DURESS_PIN_SALT, legacy)).toBe(true);
    expect(await verifyPinWithSalt('1111', DURESS_PIN_SALT, legacy)).toBe(false);
  });
});
