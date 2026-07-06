/**
 * groups store — dissolveGroup regression tests
 *
 * Field bug: deleting a group as the admin only wiped it LOCALLY (leaveGroup),
 * leaving every other member with a live, undissolved group. dissolveGroup
 * fixes this by broadcasting a signed dissolution marker (see
 * broadcastGroupDissolve / crypto/groupSig.ts canonicalGroupDissolveBytes)
 * BEFORE wiping the local copy — offline-safe via the outbox, and admin-only.
 */

// ── db/local (top-level imports in the store) ──────────────────────────────
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

// ── store/identity (lazy required by dissolveGroup/signAsAdmin) ────────────
const mockIdentityState: { identity: { aegisId: string; signingSecretKey: Uint8Array } | null } = {
  identity: { aegisId: 'admin-id', signingSecretKey: new Uint8Array(64) },
};
jest.mock('../identity', () => ({
  __esModule: true,
  useIdentity: { getState: () => mockIdentityState },
}));

// ── socket/client (lazy required) — the propagation boundary we assert on ──
const mockBroadcastGroupDissolve = jest.fn().mockResolvedValue(undefined);
jest.mock('../../socket/client', () => ({
  __esModule: true,
  broadcastGroupDissolve: (...args: unknown[]) => mockBroadcastGroupDissolve(...args),
}));

// ── store/messages (dissolveGroup/leaveGroup call clearChat) ───────────────
const mockClearChat = jest.fn();
jest.mock('../messages', () => ({
  __esModule: true,
  useMessages: { getState: () => ({ clearChat: mockClearChat }) },
}));

// ── tweetnacl / tweetnacl-util (signAsAdmin, unrelated to dissolve but
//    imported at module load by the store) ─────────────────────────────────
jest.mock('tweetnacl', () => ({
  sign: { detached: jest.fn().mockReturnValue(new Uint8Array(64)) },
}));
jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn().mockReturnValue('sig=='),
  decodeBase64: jest.fn().mockReturnValue(new Uint8Array(32)),
}));

import { useGroups } from '../groups';
import type { StoredGroup } from '../../db/local';

const adminGroup: StoredGroup = {
  id: 'g-1',
  name: 'Team',
  members: ['admin-id', 'peer-1', 'peer-2'],
  createdAt: 1000,
  adminId: 'admin-id',
  adminSig: 'sig==',
};

const memberGroup: StoredGroup = {
  ...adminGroup,
  id: 'g-2',
  adminId: 'peer-1', // local user ("admin-id") is NOT the admin of this one
};

describe('groups store — dissolveGroup (admin-only, signed broadcast)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIdentityState.identity = { aegisId: 'admin-id', signingSecretKey: new Uint8Array(64) };
    useGroups.setState({ groups: [{ ...adminGroup }, { ...memberGroup }] });
  });

  it('broadcasts the signed dissolution BEFORE wiping the group locally', async () => {
    const callOrder: string[] = [];
    mockBroadcastGroupDissolve.mockImplementation(async () => {
      callOrder.push('broadcast');
    });
    mockDeleteGroup.mockImplementation(async () => {
      callOrder.push('deleteGroup');
    });

    await useGroups.getState().dissolveGroup('g-1');

    expect(mockBroadcastGroupDissolve).toHaveBeenCalledWith(
      expect.objectContaining({ aegisId: 'admin-id' }),
      'g-1',
    );
    expect(mockDeleteContactMessages).toHaveBeenCalledWith('g-1');
    expect(mockDeleteGroup).toHaveBeenCalledWith('g-1');
    expect(callOrder).toEqual(['broadcast', 'deleteGroup']);

    // Local state and in-memory chat wiped, same as leaveGroup.
    expect(useGroups.getState().groups.find((g) => g.id === 'g-1')).toBeUndefined();
    expect(mockClearChat).toHaveBeenCalledWith('g-1');
  });

  it('still wipes the group locally even if the broadcast throws (offline)', async () => {
    mockBroadcastGroupDissolve.mockRejectedValue(new Error('offline'));

    await useGroups.getState().dissolveGroup('g-1');

    expect(mockDeleteGroup).toHaveBeenCalledWith('g-1');
    expect(useGroups.getState().groups.find((g) => g.id === 'g-1')).toBeUndefined();
  });

  it('is a no-op for a group where the local user is NOT the admin', async () => {
    await useGroups.getState().dissolveGroup('g-2');

    expect(mockBroadcastGroupDissolve).not.toHaveBeenCalled();
    expect(mockDeleteGroup).not.toHaveBeenCalled();
    expect(mockDeleteContactMessages).not.toHaveBeenCalled();
    // The group is untouched.
    expect(useGroups.getState().groups.find((g) => g.id === 'g-2')).toBeDefined();
  });

  it('is a no-op when no identity is loaded', async () => {
    mockIdentityState.identity = null;

    await useGroups.getState().dissolveGroup('g-1');

    expect(mockBroadcastGroupDissolve).not.toHaveBeenCalled();
    expect(mockDeleteGroup).not.toHaveBeenCalled();
  });
});
