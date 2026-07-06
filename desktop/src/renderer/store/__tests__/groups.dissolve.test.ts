/**
 * groups store — dissolveGroup regression tests (desktop parity with mobile
 * mobile/src/store/__tests__/groups.dissolve.test.ts).
 *
 * Field bug: deleting a group as the admin only wiped it LOCALLY (leaveGroup),
 * leaving every other member with a live, undissolved group + its full
 * history. dissolveGroup fixes this by broadcasting a signed dissolution
 * marker (see broadcastGroupDissolve / socket/client.ts signGroupDissolve /
 * canonicalGroupDissolveBytes) BEFORE wiping the local copy — offline-safe via
 * the group offline queue, and admin-only (enforced by the store itself, not
 * just hidden in the UI).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── db/local (top-level import in the store) ───────────────────────────────
const mockSaveGroup = vi.fn().mockResolvedValue(undefined);
const mockDeleteGroup = vi.fn().mockResolvedValue(undefined);
const mockDeleteContactMessages = vi.fn().mockResolvedValue(undefined);
vi.mock('../../db/local', () => ({
  loadGroups: vi.fn().mockResolvedValue([]),
  saveGroup: (...args: unknown[]) => mockSaveGroup(...args),
  deleteGroup: (...args: unknown[]) => mockDeleteGroup(...args),
  deleteContactMessages: (...args: unknown[]) => mockDeleteContactMessages(...args),
}));

// ── store/identity (dynamically imported by dissolveGroup) ─────────────────
const mockIdentityState: { identity: { aegisId: string; signingSecretKey: Uint8Array } | null } = {
  identity: { aegisId: 'admin-id', signingSecretKey: new Uint8Array(64) },
};
vi.mock('../identity', () => ({
  useIdentity: { getState: () => mockIdentityState },
}));

// ── socket/client (dynamically imported by dissolveGroup) — the propagation
//    boundary we assert on. Mocking the whole module avoids touching
//    window.aegis, which is out of scope for this node-env vitest config.
const mockBroadcastGroupDissolve = vi.fn().mockResolvedValue(undefined);
vi.mock('../../socket/client', () => ({
  broadcastGroupDissolve: (...args: unknown[]) => mockBroadcastGroupDissolve(...args),
}));

// ── store/messages (dissolveGroup/leaveGroup call clearChat) ───────────────
const mockClearChat = vi.fn();
vi.mock('../messages', () => ({
  useMessages: { getState: () => ({ clearChat: mockClearChat }) },
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
    vi.clearAllMocks();
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
    expect(useGroups.getState().groups.find((g) => g.id === 'g-2')).toBeDefined();
  });

  it('is a no-op when no identity is loaded', async () => {
    mockIdentityState.identity = null;

    await useGroups.getState().dissolveGroup('g-1');

    expect(mockBroadcastGroupDissolve).not.toHaveBeenCalled();
    expect(mockDeleteGroup).not.toHaveBeenCalled();
  });
});
