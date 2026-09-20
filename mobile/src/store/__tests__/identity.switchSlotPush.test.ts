/**
 * switchSlot — the outgoing profile retracts its push bindings BEFORE the
 * socket disconnects (decision B, 2026-09-20: only the active profile
 * notifies). Before this, every identity that had ever been active kept its
 * push token on the relay: a message to an inactive profile produced a
 * generic banner the active profile could not show.
 */

const secureStoreBacking: Record<string, string> = {};
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn((key: string) => Promise.resolve(secureStoreBacking[key] ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => { secureStoreBacking[key] = value; return Promise.resolve(undefined); }),
  deleteItemAsync: jest.fn((key: string) => { delete secureStoreBacking[key]; return Promise.resolve(undefined); }),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
}));
jest.mock('../../utils/secureStore', () => ({
  ss: { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue(undefined), delete: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../db/local', () => ({
  loadIdentity: jest.fn().mockResolvedValue(null),
  saveIdentity: jest.fn().mockResolvedValue(undefined),
  setActiveDbSlot: jest.fn(),
  resetDbConnection: jest.fn(),
  deleteIdentitySlot: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../crypto/ensureRegistered', () => ({ ensureRegistered: jest.fn() }));
jest.mock('../../crypto/media', () => ({ purgeCachedDecryptedMedia: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
jest.mock('../contacts', () => ({ useContacts: { setState: jest.fn(), getState: () => ({ hydrate: jest.fn().mockResolvedValue(undefined) }) } }));
jest.mock('../groups', () => ({ useGroups: { setState: jest.fn(), getState: () => ({ hydrate: jest.fn().mockResolvedValue(undefined) }) } }));
jest.mock('../messages', () => ({ useMessages: { setState: jest.fn() } }));

const order: string[] = [];
const mockDisconnect = jest.fn(() => { order.push('disconnect'); });
const mockUnregister = jest.fn(async () => { order.push('unregister'); });
jest.mock('../../socket/client', () => ({
  getSocket: () => ({ disconnect: mockDisconnect }),
  unregisterPushForActiveIdentity: () => mockUnregister(),
  connect: jest.fn(),
}));

import { useIdentity } from '../identity';

describe('switchSlot retracts push bindings first', () => {
  beforeEach(() => { order.length = 0; jest.clearAllMocks(); });

  it('unregisters the outgoing identity before disconnecting the socket', async () => {
    await useIdentity.getState().switchSlot('work');
    expect(mockUnregister).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['unregister', 'disconnect']);
    expect(secureStoreBacking['aegis.activeSlotId']).toBe('work');
  });

  it('a failing unregister never blocks the switch', async () => {
    mockUnregister.mockRejectedValueOnce(new Error('offline'));
    await useIdentity.getState().switchSlot('work');
    expect(mockDisconnect).toHaveBeenCalled();
    expect(secureStoreBacking['aegis.activeSlotId']).toBe('work');
  });
});
