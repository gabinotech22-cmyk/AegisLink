/**
 * groups store — immediate metadata propagation regression tests
 *
 * Field bug: changing a group's avatar (or name) only reached other members on
 * the admin's NEXT chat message, because updateGroupAvatar/renameGroup persisted
 * + re-signed locally but never sent anything. The fix pushes the change right
 * away via client.broadcastGroupMetadata().
 *
 * These tests lock the contract:
 *   - renameGroup       → broadcasts metadata once
 *   - updateGroupAvatar → re-arms the avatar (forgetGroupAvatarSent) + broadcasts
 *   - createGroup       → does NOT broadcast (the Groups screen sends the
 *                         "Group created" message that carries the metadata)
 */

// ── db/local (top-level imports in the store) ──────────────────────────────
const mockSaveGroup = jest.fn().mockResolvedValue(undefined);
jest.mock('../../db/local', () => ({
  __esModule: true,
  loadGroups: jest.fn().mockResolvedValue([]),
  saveGroup: (...args: unknown[]) => mockSaveGroup(...args),
  deleteGroup: jest.fn().mockResolvedValue(undefined),
  deleteContactMessages: jest.fn().mockResolvedValue(undefined),
}));

// ── store/identity (lazy required by signAsAdmin + the broadcast helpers) ──
jest.mock('../identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({ identity: { aegisId: 'admin-id', signingSecretKey: new Uint8Array(64) } }),
  },
}));

// ── socket/client (lazy required) — the propagation boundary we assert on ──
const mockBroadcastGroupMetadata = jest.fn().mockResolvedValue(undefined);
const mockForgetGroupAvatarSent = jest.fn();
const mockRekeyGroupAfterRemoval = jest.fn().mockResolvedValue(undefined);
jest.mock('../../socket/client', () => ({
  __esModule: true,
  broadcastGroupMetadata: (...args: unknown[]) => mockBroadcastGroupMetadata(...args),
  forgetGroupAvatarSent: (...args: unknown[]) => mockForgetGroupAvatarSent(...args),
  rekeyGroupAfterRemoval: (...args: unknown[]) => mockRekeyGroupAfterRemoval(...args),
}));

// ── store/messages (leaveGroup calls clearChat) ────────────────────────────
jest.mock('../messages', () => ({
  __esModule: true,
  useMessages: { getState: () => ({ clearChat: jest.fn() }) },
}));

// ── tweetnacl / tweetnacl-util (signAsAdmin) ───────────────────────────────
jest.mock('tweetnacl', () => ({
  sign: { detached: jest.fn().mockReturnValue(new Uint8Array(64)) },
}));
jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn().mockReturnValue('sig=='),
  decodeBase64: jest.fn().mockReturnValue(new Uint8Array(32)),
}));

import { useGroups } from '../groups';
import type { StoredGroup } from '../../db/local';

const baseGroup: StoredGroup = {
  id: 'g-1',
  name: 'Old Name',
  members: ['admin-id', 'peer-1'],
  createdAt: 1000,
  adminId: 'admin-id',
  adminSig: 'old==',
  avatarColor: '#ffcc00',
};

describe('groups store — immediate metadata propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useGroups.setState({ groups: [{ ...baseGroup }] });
  });

  it('renameGroup pushes the new name to members immediately', async () => {
    await useGroups.getState().renameGroup('g-1', 'New Name');

    expect(mockSaveGroup).toHaveBeenCalledTimes(1);
    expect(mockSaveGroup.mock.calls[0][0]).toMatchObject({ id: 'g-1', name: 'New Name' });
    expect(mockBroadcastGroupMetadata).toHaveBeenCalledTimes(1);
    expect(mockBroadcastGroupMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ aegisId: 'admin-id' }),
      'g-1',
    );
  });

  it('updateGroupAvatar re-arms the avatar and broadcasts the change', async () => {
    // A data: URI skips the file:// → documentDirectory copy branch (no FS mock needed).
    await useGroups.getState().updateGroupAvatar('g-1', 'data:image/jpeg;base64,QQ==');

    expect(mockSaveGroup).toHaveBeenCalledTimes(1);
    expect(mockSaveGroup.mock.calls[0][0]).toMatchObject({
      id: 'g-1',
      avatarImage: 'data:image/jpeg;base64,QQ==',
    });
    // Order matters: re-arm BEFORE broadcasting so the image data URI rides along.
    expect(mockForgetGroupAvatarSent).toHaveBeenCalledWith('g-1');
    expect(mockBroadcastGroupMetadata).toHaveBeenCalledTimes(1);
    expect(mockBroadcastGroupMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ aegisId: 'admin-id' }),
      'g-1',
    );
  });

  it('createGroup does NOT broadcast metadata (the create message carries it)', async () => {
    await useGroups.getState().createGroup('Fresh', ['admin-id', 'peer-2'], '#05b875', undefined);

    expect(mockBroadcastGroupMetadata).not.toHaveBeenCalled();
  });

  it('addMember welcomes the new member by broadcasting the roster carrier', async () => {
    await useGroups.getState().addMember('g-1', 'peer-2');

    // Member added, rosterVersion bumped, re-signed and persisted.
    const saved = mockSaveGroup.mock.calls[0][0];
    expect(saved.members).toContain('peer-2');
    expect(saved.rosterVersion).toBe((baseGroup.rosterVersion ?? 1) + 1);

    // The fix: the new member's client only materializes the group from a
    // carrier, so adding MUST push one immediately (symmetric to removeMember).
    expect(mockBroadcastGroupMetadata).toHaveBeenCalledTimes(1);
    expect(mockBroadcastGroupMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ aegisId: 'admin-id' }),
      'g-1',
    );
  });

  it('addMember is a no-op for someone already in the group (no broadcast)', async () => {
    await useGroups.getState().addMember('g-1', 'peer-1');

    expect(mockSaveGroup).not.toHaveBeenCalled();
    expect(mockBroadcastGroupMetadata).not.toHaveBeenCalled();
  });

  it('removeMember re-keys AND broadcasts the new roster to remaining members', async () => {
    await useGroups.getState().removeMember('g-1', 'peer-1');

    // Roster updated (peer-1 dropped), rosterVersion bumped, persisted.
    const saved = mockSaveGroup.mock.calls[0][0];
    expect(saved.members).not.toContain('peer-1');
    expect(saved.rosterVersion).toBe((baseGroup.rosterVersion ?? 1) + 1);

    // Forward secrecy: rotate the SenderKey for the remaining members.
    expect(mockRekeyGroupAfterRemoval).toHaveBeenCalledTimes(1);

    // The fix: remaining members must be told the new roster NOW, otherwise they
    // keep showing the removed member until some future carrier arrives.
    expect(mockBroadcastGroupMetadata).toHaveBeenCalledTimes(1);
    expect(mockBroadcastGroupMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ aegisId: 'admin-id' }),
      'g-1',
    );
  });
});
