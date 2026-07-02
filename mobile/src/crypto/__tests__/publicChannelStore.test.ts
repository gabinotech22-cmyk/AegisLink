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
  saveJoinRequest,
  getJoinRequest,
  deleteJoinRequest,
  saveChannelHead,
  getChannelHead,
  saveChannelMeta,
  getChannelMeta,
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

describe('SecureStore key charset (regression)', () => {
  // expo-secure-store rejects keys outside [A-Za-z0-9._-]; channelIds are
  // STANDARD base64 (contain '+', '/', trailing '='), which made channel
  // creation throw "Invalid key provided to SecureStore" on device.
  const VALID_KEY = /^[A-Za-z0-9._-]+$/;
  const UGLY_ID = 'a+b/c3vgfTWu1MxRtJYw==';

  it('never writes a key with characters SecureStore rejects, and still round-trips', async () => {
    await saveChannelSecrets(UGLY_ID, { cek: fixedKey(1), capability: fixedKey(2) });
    await saveChannelSigningKey(UGLY_ID, new Uint8Array(64).fill(7));
    await saveJoinRequest({ channelId: UGLY_ID, name: 'x', epkB64: 'e', eskB64: 's' });

    for (const k of mockStore.keys()) {
      expect(k).toMatch(VALID_KEY);
    }

    // Reads/deletes resolve through the same sanitized keys.
    expect(toHex((await getChannelCEK(UGLY_ID))!)).toBe(toHex(fixedKey(1)));
    expect(await isChannelOwned(UGLY_ID)).toBe(true);
    expect((await getJoinRequest(UGLY_ID))?.name).toBe('x');
    expect(await listChannelIds()).toContain(UGLY_ID); // index keeps the REAL id

    await deleteJoinRequest(UGLY_ID);
    expect(await getJoinRequest(UGLY_ID)).toBeNull();
    await deleteChannel(UGLY_ID);
    expect(await getChannelCEK(UGLY_ID)).toBeNull();
    expect(await listChannelIds()).not.toContain(UGLY_ID);
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

describe('channel chain head (delta-detection cache for background sync)', () => {
  it('round-trips { seqNum, postHash } through SecureStore', async () => {
    const postHash = fixedKey(42);
    await saveChannelHead(CHANNEL_A, { seqNum: 7, postHash });

    const head = await getChannelHead(CHANNEL_A);
    expect(head).not.toBeNull();
    expect(head!.seqNum).toBe(7);
    expect(toHex(head!.postHash)).toBe(toHex(postHash));
  });

  it('returns null for an unknown or malformed head', async () => {
    expect(await getChannelHead(CHANNEL_B)).toBeNull();
    mockStore.set('aegis.pubchannel.head.v1.' + CHANNEL_B.replace(/=+$/, ''), 'not json');
    expect(await getChannelHead(CHANNEL_B)).toBeNull();
  });

  it('deleteChannel wipes the persisted head', async () => {
    await saveChannelSecrets(CHANNEL_A, { cek: fixedKey(1), capability: fixedKey(2) });
    await saveChannelHead(CHANNEL_A, { seqNum: 3, postHash: fixedKey(9) });

    await deleteChannel(CHANNEL_A);

    expect(await getChannelHead(CHANNEL_A)).toBeNull();
  });

  it('deleteAllChannels wipes persisted heads', async () => {
    await saveChannelSecrets(CHANNEL_A, { cek: fixedKey(1), capability: fixedKey(2) });
    await saveChannelHead(CHANNEL_A, { seqNum: 5, postHash: fixedKey(5) });

    await deleteAllChannels();

    expect(await getChannelHead(CHANNEL_A)).toBeNull();
    expect(mockStore.size).toBe(0);
  });
});

describe('channel display metadata (name survives an offline restart)', () => {
  const META = {
    name: 'TESTERS',
    description: 'private testing channel',
    channelType: 'approval',
    avatarHash: 'abc123',
    channelEd25519PubB64: 'cHVia2V5',
  };

  it('round-trips the display metadata through SecureStore', async () => {
    await saveChannelMeta(CHANNEL_A, META);
    expect(await getChannelMeta(CHANNEL_A)).toEqual(META);
  });

  it('tolerates missing optional fields', async () => {
    mockStore.set('aegis.pubchannel.meta.v1.' + CHANNEL_A.replace(/=+$/, ''), JSON.stringify({ name: 'X', channelType: 'open' }));
    expect(await getChannelMeta(CHANNEL_A)).toEqual({
      name: 'X', description: '', channelType: 'open', avatarHash: null, channelEd25519PubB64: null,
    });
  });

  it('returns null for unknown or malformed metadata', async () => {
    expect(await getChannelMeta(CHANNEL_B)).toBeNull();
    mockStore.set('aegis.pubchannel.meta.v1.' + CHANNEL_B.replace(/=+$/, ''), '{bad json');
    expect(await getChannelMeta(CHANNEL_B)).toBeNull();
  });

  it('deleteChannel and deleteAllChannels wipe the metadata', async () => {
    await saveChannelSecrets(CHANNEL_A, { cek: fixedKey(1), capability: fixedKey(2) });
    await saveChannelMeta(CHANNEL_A, META);
    await deleteChannel(CHANNEL_A);
    expect(await getChannelMeta(CHANNEL_A)).toBeNull();

    await saveChannelSecrets(CHANNEL_B, { cek: fixedKey(3), capability: fixedKey(4) });
    await saveChannelMeta(CHANNEL_B, META);
    await deleteAllChannels();
    expect(await getChannelMeta(CHANNEL_B)).toBeNull();
  });
});
