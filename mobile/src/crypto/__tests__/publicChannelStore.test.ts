/**
 * publicChannelStore — per-channel secret persistence (Phase 2b)
 *
 * Verifies that channel secrets (CEK, capability, owned signing key) round-trip
 * through SecureStore, that the delivery token is derived (not stored), that the
 * index tracks held channels, and that delete/panic wipe everything.
 */

const mockStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  __esModule: true,
  getItemAsync: jest.fn((k: string) => Promise.resolve(mockStore.get(k) ?? null)),
  setItemAsync: jest.fn((k: string, v: string) => { mockStore.set(k, v); return Promise.resolve(); }),
  deleteItemAsync: jest.fn((k: string) => { mockStore.delete(k); return Promise.resolve(); }),
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'afterFirstUnlockThisDeviceOnly',
}));

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import {
  saveChannelSecrets,
  getChannelCEK,
  getChannelCapability,
  getChannelDeliveryToken,
  saveChannelSigningKey,
  getChannelSigningKey,
  isChannelOwned,
  listChannelIds,
  deleteChannel,
  deleteAllChannels,
} from '../publicChannelStore';
import { deriveChannelDeliveryToken, generateChannelIdentity } from '../publicChannelKey';

const toHex = (b: Uint8Array) => Buffer.from(b).toString('hex');

beforeEach(() => mockStore.clear());

const CHANNEL_A = 'SKKk3vgfTWu1MxRtJYx6DA==';
const CHANNEL_B = 'AAAA3vgfTWu1MxRtJYx6DA==';

function fixedKey(seed: number): Uint8Array {
  const k = new Uint8Array(32);
  for (let i = 0; i < 32; i++) k[i] = (seed + i) & 0xff;
  return k;
}

describe('channel secrets (CEK + capability)', () => {
  it('round-trips CEK and capability through SecureStore', async () => {
    const cek = fixedKey(10);
    const capability = fixedKey(99);
    await saveChannelSecrets(CHANNEL_A, { cek, capability });

    expect(toHex((await getChannelCEK(CHANNEL_A))!)).toBe(toHex(cek));
    expect(toHex((await getChannelCapability(CHANNEL_A))!)).toBe(toHex(capability));
  });

  it('returns null for an unknown channel', async () => {
    expect(await getChannelCEK('nope')).toBeNull();
    expect(await getChannelCapability('nope')).toBeNull();
    expect(await getChannelDeliveryToken('nope')).toBeNull();
  });

  it('rejects non-32-byte secrets', async () => {
    await expect(saveChannelSecrets(CHANNEL_A, { cek: new Uint8Array(16), capability: fixedKey(1) }))
      .rejects.toThrow('CEK must be 32 bytes');
    await expect(saveChannelSecrets(CHANNEL_A, { cek: fixedKey(1), capability: new Uint8Array(31) }))
      .rejects.toThrow('capability must be 32 bytes');
  });

  it('derives the delivery token from the capability (not stored as its own secret)', async () => {
    const cek = fixedKey(10);
    const capability = fixedKey(99);
    await saveChannelSecrets(CHANNEL_A, { cek, capability });

    const expected = deriveChannelDeliveryToken(capability, CHANNEL_A);
    expect(await getChannelDeliveryToken(CHANNEL_A)).toBe(expected);

    // No delivery-token slot was ever written — only cek, cap (+ index).
    const keys = [...mockStore.keys()];
    expect(keys.some((k) => k.includes('cek'))).toBe(true);
    expect(keys.some((k) => k.includes('cap'))).toBe(true);
    expect(keys.some((k) => k.toLowerCase().includes('token') || k.toLowerCase().includes('delivery'))).toBe(false);
  });
});

describe('owned-channel signing key', () => {
  it('round-trips a 64-byte signing secret and marks the channel owned', async () => {
    const id = generateChannelIdentity();
    await saveChannelSigningKey(id.channelId, id.channelEd25519Secret);

    expect(toHex((await getChannelSigningKey(id.channelId))!)).toBe(toHex(id.channelEd25519Secret));
    expect(await isChannelOwned(id.channelId)).toBe(true);
  });

  it('a subscribed-only channel is not owned', async () => {
    await saveChannelSecrets(CHANNEL_A, { cek: fixedKey(10), capability: fixedKey(99) });
    expect(await isChannelOwned(CHANNEL_A)).toBe(false);
    expect(await getChannelSigningKey(CHANNEL_A)).toBeNull();
  });

  it('rejects a signing secret of the wrong length', async () => {
    await expect(saveChannelSigningKey(CHANNEL_A, new Uint8Array(32)))
      .rejects.toThrow('signing secret must be 64 bytes');
  });
});

describe('index + lifecycle', () => {
  it('tracks every channel we hold a secret for', async () => {
    await saveChannelSecrets(CHANNEL_A, { cek: fixedKey(1), capability: fixedKey(2) });
    const owned = generateChannelIdentity();
    await saveChannelSigningKey(owned.channelId, owned.channelEd25519Secret);

    const ids = await listChannelIds();
    expect(ids).toContain(CHANNEL_A);
    expect(ids).toContain(owned.channelId);
    expect(ids).toHaveLength(2);
  });

  it('does not duplicate a channel in the index', async () => {
    await saveChannelSecrets(CHANNEL_A, { cek: fixedKey(1), capability: fixedKey(2) });
    await saveChannelSecrets(CHANNEL_A, { cek: fixedKey(3), capability: fixedKey(4) });
    expect(await listChannelIds()).toEqual([CHANNEL_A]);
  });

  it('deleteChannel wipes all secrets and drops it from the index', async () => {
    const owned = generateChannelIdentity();
    await saveChannelSecrets(owned.channelId, { cek: fixedKey(1), capability: fixedKey(2) });
    await saveChannelSigningKey(owned.channelId, owned.channelEd25519Secret);

    await deleteChannel(owned.channelId);

    expect(await getChannelCEK(owned.channelId)).toBeNull();
    expect(await getChannelCapability(owned.channelId)).toBeNull();
    expect(await getChannelSigningKey(owned.channelId)).toBeNull();
    expect(await listChannelIds()).not.toContain(owned.channelId);
  });

  it('deleteAllChannels wipes everything (panic mode)', async () => {
    await saveChannelSecrets(CHANNEL_A, { cek: fixedKey(1), capability: fixedKey(2) });
    await saveChannelSecrets(CHANNEL_B, { cek: fixedKey(3), capability: fixedKey(4) });

    await deleteAllChannels();

    expect(await listChannelIds()).toEqual([]);
    expect(await getChannelCEK(CHANNEL_A)).toBeNull();
    expect(await getChannelCEK(CHANNEL_B)).toBeNull();
    expect(mockStore.size).toBe(0);
  });
});
