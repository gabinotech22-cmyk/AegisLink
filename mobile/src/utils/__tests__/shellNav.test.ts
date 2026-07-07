/**
 * shellNav — imperative navigation escape hatch used by
 * FloatingGroupCallBarRoot (App.tsx) to jump straight to a group's
 * GroupChatScreen when the floating group-call banner is tapped.
 *
 * Verifies:
 *  1. navigateToGroupChat resolves the group from the groups store and
 *     pushes { name: 'groupChat', group } through the registered nav.
 *  2. Returns false and does not push when no ShellNav is registered.
 *  3. Returns false and does not push when the groupId can't be found.
 *  4. Returns false and does not push when groupId is null/undefined.
 *  5. __resetShellNavForTests clears a previously registered nav.
 */

const mockGroups: { id: string; name: string; members: string[]; createdAt: number }[] = [];

jest.mock('../../store/groups', () => ({
  useGroups: { getState: () => ({ groups: mockGroups }) },
}));

import {
  registerShellNav,
  navigateToGroupChat,
  __resetShellNavForTests,
} from '../shellNav';

describe('shellNav', () => {
  beforeEach(() => {
    __resetShellNavForTests();
    mockGroups.length = 0;
  });

  afterEach(() => {
    __resetShellNavForTests();
  });

  it('resolves the group and pushes the groupChat route', () => {
    const group = { id: 'group-1', name: 'Team', members: ['a', 'b'], createdAt: 1 };
    mockGroups.push(group);
    const push = jest.fn();
    registerShellNav({ push });

    const result = navigateToGroupChat('group-1');

    expect(result).toBe(true);
    expect(push).toHaveBeenCalledTimes(1);
    expect(push).toHaveBeenCalledWith({ name: 'groupChat', group });
  });

  it('returns false and does not push when no ShellNav is registered', () => {
    const group = { id: 'group-1', name: 'Team', members: ['a', 'b'], createdAt: 1 };
    mockGroups.push(group);

    const result = navigateToGroupChat('group-1');

    expect(result).toBe(false);
  });

  it('returns false and does not push when the group cannot be found', () => {
    const push = jest.fn();
    registerShellNav({ push });

    const result = navigateToGroupChat('missing-group');

    expect(result).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('returns false and does not push when groupId is null or undefined', () => {
    const push = jest.fn();
    registerShellNav({ push });

    expect(navigateToGroupChat(null)).toBe(false);
    expect(navigateToGroupChat(undefined)).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it('__resetShellNavForTests clears a previously registered nav', () => {
    const group = { id: 'group-1', name: 'Team', members: ['a', 'b'], createdAt: 1 };
    mockGroups.push(group);
    const push = jest.fn();
    registerShellNav({ push });

    __resetShellNavForTests();

    const result = navigateToGroupChat('group-1');
    expect(result).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});
