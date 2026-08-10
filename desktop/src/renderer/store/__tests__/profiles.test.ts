/**
 * ProfilesStore — Section 11 on desktop. Parity with
 * mobile/src/store/profiles.ts.
 *
 * The two properties worth pinning are not "the list renders":
 *
 *   1. DURESS CONTAINMENT. Under duress the real roster must never be served.
 *      It would reveal both that several isolated identities exist and what
 *      they are called — the exact "there is a hidden real account" signal the
 *      decoy exists to deny. Nothing else in the app can compensate: a screen
 *      that forgets to check leaks it.
 *   2. THE DATABASE MOVES FIRST. On desktop switching profile is a real file
 *      close/open in the main process. If the stores are reset before that
 *      lands, their refetch races the switch and reads the profile the user
 *      just left.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockSwitchDbSlot = vi.fn().mockResolvedValue(undefined);
const mockSaveIdentity = vi.fn().mockResolvedValue(undefined);
const mockDeleteIdentitySlot = vi.fn().mockResolvedValue(undefined);

/** Ordered log of the calls whose sequence matters. */
let callOrder: string[] = [];

vi.mock('../../db/local', () => ({
  switchDbSlot: (...a: unknown[]) => { callOrder.push('switchDbSlot'); return mockSwitchDbSlot(...a); },
  saveIdentity: (...a: unknown[]) => mockSaveIdentity(...a),
  deleteIdentitySlot: (...a: unknown[]) => mockDeleteIdentitySlot(...a),
}));

vi.mock('../contacts', () => ({
  useContacts: {
    setState: () => { callOrder.push('resetStores'); },
    getState: () => ({ hydrate: vi.fn().mockResolvedValue(undefined) }),
  },
}));
vi.mock('../groups', () => ({
  useGroups: {
    setState: vi.fn(),
    getState: () => ({ hydrate: vi.fn().mockResolvedValue(undefined) }),
  },
}));
vi.mock('../messages', () => ({ useMessages: { setState: vi.fn() } }));

let duressActive = false;
vi.mock('../preferences', () => ({
  usePreferences: { getState: () => ({ duressActive }) },
}));

const identityState = {
  identity: { aegisId: 'DEC-OY00-0000', publicKeyB64: 'pk', createdAt: 1700000000000 },
  displayName: 'decoy',
  avatarColor: '#05b875',
  activeSlotId: 'self',
  hydrate: vi.fn().mockResolvedValue(undefined),
  updateProfile: vi.fn().mockResolvedValue(undefined),
};
vi.mock('../identity', () => ({
  useIdentity: { getState: () => identityState, setState: vi.fn() },
}));

vi.mock('../../socket/client', () => ({
  getSocket: () => null,
  connect: vi.fn(),
}));

vi.mock('../../crypto/identity', () => ({
  createIdentity: () => ({
    aegisId: 'NEW-PROF-0001',
    publicKeyB64: 'npk',
    secretKeyB64: 'nsk',
    signingPublicKeyB64: 'nspk',
    signingSecretKeyB64: 'nssk',
    createdAt: 1700000001000,
  }),
}));

let store: Record<string, string> = {};

beforeEach(() => {
  vi.clearAllMocks();
  callOrder = [];
  duressActive = false;
  store = {};
  (globalThis as unknown as { window: unknown }).window = {
    aegis: {
      secureStorage: {
        get: (k: string) => Promise.resolve(store[k] ?? null),
        set: (k: string, v: string) => { store[k] = v; return Promise.resolve(); },
        delete: (k: string) => { delete store[k]; return Promise.resolve(); },
      },
    },
  };
});

async function freshStore() {
  vi.resetModules();
  const mod = await import('../profiles');
  return mod.useProfiles;
}

describe('duress containment', () => {
  it('never serves the real roster while the decoy is showing', async () => {
    store['aegis.profiles.v1'] = JSON.stringify([
      { slotId: 'self', aegisId: 'AAA-1111-2222', displayName: 'real life', avatarColor: '#05b875', createdAt: 1 },
      { slotId: 'BBB-3333-4444', aegisId: 'BBB-3333-4444', displayName: 'the hidden one', avatarColor: '#8b5cf6', createdAt: 2 },
    ]);
    duressActive = true;

    const useProfiles = await freshStore();
    await useProfiles.getState().hydrate();

    const { profiles } = useProfiles.getState();
    // One profile, mirroring the decoy. Two would prove a hidden account exists.
    expect(profiles).toHaveLength(1);
    expect(profiles[0].slotId).toBe('self');
    expect(profiles[0].displayName).toBe('decoy');
    expect(JSON.stringify(profiles)).not.toContain('the hidden one');
    expect(JSON.stringify(profiles)).not.toContain('BBB-3333-4444');
  });

  it('serves the real roster when duress is off', async () => {
    store['aegis.profiles.v1'] = JSON.stringify([
      { slotId: 'self', aegisId: 'AAA-1111-2222', displayName: 'real life', avatarColor: '#05b875', createdAt: 1 },
      { slotId: 'BBB-3333-4444', aegisId: 'BBB-3333-4444', displayName: 'the hidden one', avatarColor: '#8b5cf6', createdAt: 2 },
    ]);

    const useProfiles = await freshStore();
    await useProfiles.getState().hydrate();
    expect(useProfiles.getState().profiles).toHaveLength(2);
  });
});

describe('switchProfile', () => {
  it('moves the database before resetting the stores', async () => {
    store['aegis.profiles.v1'] = JSON.stringify([
      { slotId: 'self', aegisId: 'AAA-1111-2222', displayName: 'a', avatarColor: '#05b875', createdAt: 1 },
      { slotId: 'BBB-3333-4444', aegisId: 'BBB-3333-4444', displayName: 'b', avatarColor: '#8b5cf6', createdAt: 2 },
    ]);
    const useProfiles = await freshStore();
    await useProfiles.getState().hydrate();

    await useProfiles.getState().switchProfile('BBB-3333-4444');

    expect(mockSwitchDbSlot).toHaveBeenCalledWith('BBB-3333-4444');
    // Reset-then-switch would let a store refetch read the OLD profile.
    expect(callOrder.indexOf('switchDbSlot')).toBeLessThan(callOrder.indexOf('resetStores'));
    expect(useProfiles.getState().activeSlotId).toBe('BBB-3333-4444');
    expect(store['aegis.activeSlotId']).toBe('BBB-3333-4444');
  });

  it('does nothing when the target is already active', async () => {
    const useProfiles = await freshStore();
    await useProfiles.getState().switchProfile('self');
    expect(mockSwitchDbSlot).not.toHaveBeenCalled();
  });
});

describe('createProfile', () => {
  it('returns to the previous profile even when writing the identity fails', async () => {
    mockSaveIdentity.mockRejectedValueOnce(new Error('disk full'));
    const useProfiles = await freshStore();

    await expect(
      useProfiles.getState().createProfile('scratch', '#8b5cf6')
    ).rejects.toThrow('disk full');

    // Left pointing at the half-made profile, the app would keep running on a
    // database whose identity row was never written.
    expect(mockSwitchDbSlot).toHaveBeenLastCalledWith('self');
  });

  it('registers the slot so a panic wipe can find its key material', async () => {
    const useProfiles = await freshStore();
    await useProfiles.getState().createProfile('scratch', '#8b5cf6');
    expect(JSON.parse(store['aegis.slotsList'])).toContain('NEW-PROF-0001');
    expect(store['aegis.NEW-PROF-0001.secretKey.b64']).toBe('nsk');
  });
});

describe('removeProfile', () => {
  it('refuses to remove the last profile', async () => {
    store['aegis.profiles.v1'] = JSON.stringify([
      { slotId: 'self', aegisId: 'AAA-1111-2222', displayName: 'a', avatarColor: '#05b875', createdAt: 1 },
    ]);
    const useProfiles = await freshStore();
    await useProfiles.getState().hydrate();
    await expect(useProfiles.getState().removeProfile('self')).rejects.toThrow(/last profile/i);
  });

  it('refuses to remove the primary profile', async () => {
    store['aegis.profiles.v1'] = JSON.stringify([
      { slotId: 'self', aegisId: 'AAA-1111-2222', displayName: 'a', avatarColor: '#05b875', createdAt: 1 },
      { slotId: 'BBB-3333-4444', aegisId: 'BBB-3333-4444', displayName: 'b', avatarColor: '#8b5cf6', createdAt: 2 },
    ]);
    const useProfiles = await freshStore();
    await useProfiles.getState().hydrate();
    await expect(useProfiles.getState().removeProfile('self')).rejects.toThrow(/primary profile/i);
  });

  it('drops the slot from slotsList as well as its keys', async () => {
    store['aegis.profiles.v1'] = JSON.stringify([
      { slotId: 'self', aegisId: 'AAA-1111-2222', displayName: 'a', avatarColor: '#05b875', createdAt: 1 },
      { slotId: 'BBB-3333-4444', aegisId: 'BBB-3333-4444', displayName: 'b', avatarColor: '#8b5cf6', createdAt: 2 },
    ]);
    store['aegis.slotsList'] = JSON.stringify(['self', 'BBB-3333-4444']);
    const useProfiles = await freshStore();
    await useProfiles.getState().hydrate();

    await useProfiles.getState().removeProfile('BBB-3333-4444');

    expect(mockDeleteIdentitySlot).toHaveBeenCalledWith('BBB-3333-4444');
    // A stale entry sends a later panic wipe hunting for a profile that is gone.
    expect(JSON.parse(store['aegis.slotsList'])).toEqual(['self']);
    expect(useProfiles.getState().profiles).toHaveLength(1);
  });
});
