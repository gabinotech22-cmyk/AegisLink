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
jest.setTimeout(120_000);

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
} from '../pin';

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
