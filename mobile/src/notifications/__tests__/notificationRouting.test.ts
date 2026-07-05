/**
 * resolveNotificationOpenTarget — notification-tap routing regression tests
 *
 * Field bug: tapping a GROUP notification opened a 1:1 chat with the message
 * sender (or nothing) instead of the group, because the notification data only
 * carried `fromAegisId` (the sender) and the handler never looked at the group.
 * The fix adds `groupId` to the data and routes by it when `isGroup` is set.
 *
 * Field bug 2: tapping a CHANNEL post notification (data: {channelId,
 * isChannel:true} — see notifications/channelNotifications.ts) did nothing,
 * because resolveNotificationOpenTarget never looked at channelId/isChannel at
 * all. The fix adds a channelId branch, checked before the isGroup branch.
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

  it('routes a channel post tap to the channel feed (by channelId)', () => {
    const target = resolveNotificationOpenTarget({
      channelId: 'chan_abc',
      isChannel: true,
    });
    expect(target).toEqual({ channelId: 'chan_abc' });
  });

  it('returns null for a channel tap missing channelId (cannot route)', () => {
    const target = resolveNotificationOpenTarget({ isChannel: true });
    expect(target).toBeNull();
  });

  it('prefers the channel route over group/1:1 fields when isChannel is set', () => {
    // Defensive: a malformed/legacy payload should never route to the wrong
    // surface just because unrelated fields are also present.
    const target = resolveNotificationOpenTarget({
      isChannel: true,
      channelId: 'chan_abc',
      fromAegisId: 'sender-123',
      groupId: 'group_abc',
    });
    expect(target).toEqual({ channelId: 'chan_abc' });
  });
});
