import { getPermissions } from '../utils/workPermissions';

describe('getPermissions', () => {
  it('gives owner all permissions', () => {
    const p = getPermissions('owner');
    expect(p.canManageMembers).toBe(true);
    expect(p.canCreateChannels).toBe(true);
    expect(p.canDeleteChannels).toBe(true);
    expect(p.canPinMessages).toBe(true);
    expect(p.canSendAnnouncements).toBe(true);
    expect(p.canInvite).toBe(true);
    expect(p.canKickMembers).toBe(true);
    expect(p.canPromoteToAdmin).toBe(true);
    expect(p.canDemoteAdmin).toBe(true);
    expect(p.canDeleteOrg).toBe(true);
  });

  it('gives admin most permissions but not owner-only ones', () => {
    const p = getPermissions('admin');
    expect(p.canPinMessages).toBe(true);
    expect(p.canSendAnnouncements).toBe(true);
    expect(p.canInvite).toBe(true);
    expect(p.canKickMembers).toBe(true);
    // Owner-only
    expect(p.canDeleteChannels).toBe(false);
    expect(p.canPromoteToAdmin).toBe(false);
    expect(p.canDemoteAdmin).toBe(false);
    expect(p.canDeleteOrg).toBe(false);
  });

  it('gives member only basic permissions', () => {
    const p = getPermissions('member');
    expect(p.canManageMembers).toBe(false);
    expect(p.canCreateChannels).toBe(false);
    expect(p.canDeleteChannels).toBe(false);
    expect(p.canPinMessages).toBe(false);
    expect(p.canSendAnnouncements).toBe(false);
    expect(p.canInvite).toBe(false);
    expect(p.canKickMembers).toBe(false);
    expect(p.canPromoteToAdmin).toBe(false);
    expect(p.canDemoteAdmin).toBe(false);
    expect(p.canDeleteOrg).toBe(false);
  });

  it('returns stable references for each role', () => {
    // Same call returns the same frozen object
    expect(getPermissions('owner')).toBe(getPermissions('owner'));
    expect(getPermissions('admin')).toBe(getPermissions('admin'));
    expect(getPermissions('member')).toBe(getPermissions('member'));
  });
});
