/**
 * groups store — leaveGroup tells the others and remembers the group.
 *
 * Leaving used to be local-only: the other members kept the leaver in their
 * roster (and kept encrypting to them) and the next group message recreated
 * the group on the leaver's device. Verifies:
 *   1. leaveGroup broadcasts the [group:left] marker BEFORE wiping.
 *   2. The group id lands in preferences.leftGroupIds.
 *   3. A broadcast failure never keeps the user in the group.
 * Same harness as groups.dissolve.test.ts.
 */

const mockSaveGroup = jest.fn().mockResolvedValue(undefined);
const mockDeleteGroup = jest.fn().mockResolvedValue(undefined);
const mockDeleteContactMessages = jest.fn().mockResolvedValue(undefined);
jest.mock('../../db/local', () => ({
  __esModule: true,
  loadGroups: jest.fn().mockResolvedValue([]),
  saveGroup: (...args: unknown[]) => mockSaveGroup(...args),
  deleteGroup: (...args: unknown[]) => mockDeleteGroup(...args),
  deleteContactMessages: (...args: unknown[]) => mockDeleteContactMessages(...args),
}));
const mockIdentityState = { identity: { aegisId: 'me', signingSecretKey: require('../../crypto/__tests__/helpers/rawIdentity').testSignKey() } };
jest.mock('../identity', () => ({ __esModule: true, useIdentity: { getState: () => mockIdentityState } }));
const mockBroadcastGroupLeave = jest.fn().mockResolvedValue(undefined);
jest.mock('../../socket/client', () => ({
  __esModule: true,
  broadcastGroupLeave: (...args: unknown[]) => mockBroadcastGroupLeave(...args),
  broadcastGroupDissolve: jest.fn(),
}));
const mockClearChat = jest.fn();
jest.mock('../messages', () => ({ __esModule: true, useMessages: { getState: () => ({ clearChat: mockClearChat }) } }));
const mockPrefSet = jest.fn().mockResolvedValue(undefined);
const mockPrefs = { leftGroupIds: [] as string[], duressActive: false, set: (...a: unknown[]) => mockPrefSet(...a) };
jest.mock('../preferences', () => ({ __esModule: true, usePreferences: { getState: () => mockPrefs } }));
// The crypto facade (native libsodium) with a stubbed `nacl`: these tests
// only need the calls to succeed, not real cryptography.
jest.mock('../../crypto/sodium', () => ({
  ...jest.requireActual('../../crypto/sodium'),
  nacl: {   sign: { detached: jest.fn().mockReturnValue(new Uint8Array(64)) }
  },
}));
jest.mock('tweetnacl-util', () => ({ encodeBase64: jest.fn().mockReturnValue('sig=='), decodeBase64: jest.fn().mockReturnValue(new Uint8Array(32)) }));

import { useGroups } from '../groups';
import type { StoredGroup } from '../../db/local';

const group: StoredGroup = { id: 'g-1', name: 'Team', members: ['peer-1', 'me', 'peer-2'], createdAt: 1000, adminId: 'peer-1', adminSig: 'sig==' };

describe('groups store — leaveGroup', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrefs.leftGroupIds = [];
    useGroups.setState({ groups: [group] });
  });

  it('broadcasts the left marker before wiping, and records the group as left', async () => {
    const order: string[] = [];
    mockBroadcastGroupLeave.mockImplementation(async () => { order.push('broadcast'); });
    mockDeleteGroup.mockImplementation(async () => { order.push('wipe'); });
    await useGroups.getState().leaveGroup('g-1');
    expect(mockBroadcastGroupLeave).toHaveBeenCalledWith(mockIdentityState.identity, 'g-1');
    expect(order).toEqual(['broadcast', 'wipe']);
    expect(mockPrefSet).toHaveBeenCalledWith('leftGroupIds', ['g-1']);
    expect(useGroups.getState().groups).toEqual([]);
    expect(mockClearChat).toHaveBeenCalledWith('g-1');
  });

  it('a broadcast failure still leaves the group locally', async () => {
    mockBroadcastGroupLeave.mockRejectedValueOnce(new Error('offline'));
    await useGroups.getState().leaveGroup('g-1');
    expect(mockDeleteGroup).toHaveBeenCalledWith('g-1');
    expect(mockPrefSet).toHaveBeenCalledWith('leftGroupIds', ['g-1']);
  });

  it('does not duplicate an id already in leftGroupIds', async () => {
    mockPrefs.leftGroupIds = ['g-1'];
    await useGroups.getState().leaveGroup('g-1');
    expect(mockPrefSet).not.toHaveBeenCalledWith('leftGroupIds', expect.anything());
  });
});
