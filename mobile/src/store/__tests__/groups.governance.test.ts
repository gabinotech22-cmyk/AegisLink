/**
 * groups store — governance signing (Phase 2a)
 *
 * Locks the owner-side contract for roles/permissions:
 *   - createGroup signs initial governance (default permissions, govVersion 1)
 *   - setGroupPermission re-signs with a bumped govVersion
 *   - the produced govSig verifies against the owner's REAL public key
 *
 * Uses real tweetnacl (no crypto mock) so the signature round-trip is genuine.
 */
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { verifyGroupGovernance } from '../../crypto/groupSig';
import { DEFAULT_PERMISSIONS, effectivePermissions } from '../../crypto/groupRoles';

const mockOwnerKp = nacl.sign.keyPair();
const mockOwnerId = 'owner-aegis-id';

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadGroups: jest.fn().mockResolvedValue([]),
  saveGroup: jest.fn().mockResolvedValue(undefined),
  deleteGroup: jest.fn().mockResolvedValue(undefined),
  deleteContactMessages: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({ identity: { aegisId: mockOwnerId, signingSecretKey: mockOwnerKp.secretKey } }),
  },
}));

// createGroup/setGroupPermission don't broadcast in Phase 2a, but addMember etc.
// lazily require these — stub so nothing throws if reached.
jest.mock('../../socket/client', () => ({
  __esModule: true,
  broadcastGroupMetadata: jest.fn().mockResolvedValue(undefined),
  forgetGroupAvatarSent: jest.fn(),
  rekeyGroupAfterRemoval: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../messages', () => ({
  __esModule: true,
  useMessages: { getState: () => ({ clearChat: jest.fn() }) },
}));

import { useGroups } from '../groups';

const OWNER_PUB = encodeBase64(mockOwnerKp.publicKey);

function verify(g: { id: string; adminId?: string; admins?: string[]; moderators?: string[]; permissions?: ReturnType<typeof effectivePermissions>; govSig?: string; govVersion?: number }) {
  return verifyGroupGovernance(
    {
      groupId: g.id,
      ownerId: g.adminId!,
      admins: g.admins ?? [],
      moderators: g.moderators ?? [],
      permissions: effectivePermissions(g),
      govVersion: g.govVersion!,
    },
    g.govSig!,
    OWNER_PUB,
  );
}

describe('groups store — governance signing', () => {
  beforeEach(() => {
    useGroups.setState({ groups: [] });
  });

  it('createGroup signs initial governance (defaults, version 1)', async () => {
    const g = await useGroups.getState().createGroup('Squad', [mockOwnerId, 'peer-1']);
    expect(g.govVersion).toBe(1);
    expect(g.permissions).toEqual(DEFAULT_PERMISSIONS);
    expect(g.govSig).toBeTruthy();
    expect(verify(g)).toBe(true);
  });

  it('setGroupPermission bumps govVersion and re-signs verifiably', async () => {
    const g = await useGroups.getState().createGroup('Squad', [mockOwnerId, 'peer-1']);
    await useGroups.getState().setGroupPermission(g.id, { whoCanSend: 'admins' });
    const updated = useGroups.getState().groups.find((x) => x.id === g.id)!;

    expect(updated.govVersion).toBe(2);
    expect(updated.permissions?.whoCanSend).toBe('admins');
    expect(verify(updated)).toBe(true);

    // The OLD (v1) signature must NOT verify against the NEW state (anti-rollback).
    const rolledBack = verifyGroupGovernance(
      {
        groupId: updated.id,
        ownerId: updated.adminId!,
        admins: [],
        moderators: [],
        permissions: effectivePermissions(updated),
        govVersion: 1,
      },
      g.govSig!,
      OWNER_PUB,
    );
    expect(rolledBack).toBe(false);
  });
});
