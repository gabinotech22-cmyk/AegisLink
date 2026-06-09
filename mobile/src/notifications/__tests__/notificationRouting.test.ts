/**
 * resolveNotificationOpenTarget — notification-tap routing regression tests
 *
 * Field bug: tapping a GROUP notification opened a 1:1 chat with the message
 * sender (or nothing) instead of the group, because the notification data only
 * carried `fromAegisId` (the sender) and the handler never looked at the group.
 * The fix adds `groupId` to the data and routes by it when `isGroup` is set.
 */

// expo-notifications calls setNotificationHandler at module load — stub the
// surface the module touches so importing push.ts doesn't blow up under jest.
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  AndroidImportance: { HIGH: 4, MAX: 5 },
  AndroidNotificationPriority: { MAX: 'max' },
}));
jest.mock('../../config', () => ({ SERVER_URL: 'https://example.test' }));

import { resolveNotificationOpenTarget } from '../push';

describe('resolveNotificationOpenTarget', () => {
  it('routes a group message tap to the group (by groupId, NOT the sender)', () => {
    const target = resolveNotificationOpenTarget({
      fromAegisId: 'sender-123', // the SENDER — must NOT be used as the chat id
      isGroup: true,
      groupId: 'group_abc',
      groupName: 'XGroup',
    });
    expect(target).toEqual({ groupId: 'group_abc' });
  });

  it('routes a 1:1 message tap to the sender chat', () => {
    const target = resolveNotificationOpenTarget({ fromAegisId: 'peer-9', isGroup: false });
    expect(target).toEqual({ aegisId: 'peer-9' });
  });

  it('returns null for a group tap missing groupId (cannot route — no 1:1 fallback to the sender)', () => {
    const target = resolveNotificationOpenTarget({ fromAegisId: 'sender-123', isGroup: true });
    expect(target).toBeNull();
  });

  it('returns null for a contentless server wake-up push (no chat identity)', () => {
    expect(resolveNotificationOpenTarget({ kind: 'wakeup' })).toBeNull();
    expect(resolveNotificationOpenTarget(undefined)).toBeNull();
  });
});
