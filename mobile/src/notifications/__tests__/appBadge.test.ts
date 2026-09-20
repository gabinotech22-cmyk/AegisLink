/**
 * App-icon badge = unread total, re-derived on every counter change.
 *
 * Until 1.0.7 the badge was only ever bumped when a notification fired
 * (`totalUnread + 1`) and never recomputed, so after reading every message the
 * icon still showed a count. syncAppBadge derives it from the same unread
 * counters the chat list shows, and the messages store calls it after each
 * mutation (append / markRead / loadAllUnreads); App.tsx on foreground; the
 * Notifications screen when the badge toggle changes.
 */

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(async () => 'notif-id'),
  setBadgeCountAsync: jest.fn(async () => true),
  AndroidImportance: { HIGH: 4, MAX: 5 },
  AndroidNotificationPriority: { HIGH: 'high', MAX: 'max' },
}));
jest.mock('../../config', () => ({ SERVER_URL: 'https://example.test' }));
jest.mock('../../utils/secureStore', () => ({
  ss: { get: jest.fn(async () => null), set: jest.fn(async () => undefined), delete: jest.fn(async () => undefined) },
}));

const mockUnread: { unreadCounts: Record<string, number> } = { unreadCounts: {} };
jest.mock('../../store/messages', () => ({
  __esModule: true,
  useMessages: { getState: () => ({ unreadCounts: mockUnread.unreadCounts }) },
}));

import * as Notifications from 'expo-notifications';
import { syncAppBadge, totalUnreadFrom } from '../push';
import { usePreferences } from '../../store/preferences';

const badgeMock = Notifications.setBadgeCountAsync as jest.Mock;

beforeEach(() => {
  badgeMock.mockClear();
  mockUnread.unreadCounts = {};
  usePreferences.setState({ notifBadge: true });
});

describe('totalUnreadFrom', () => {
  it('sums chats and groups, ignores junk and negatives', () => {
    expect(totalUnreadFrom({ a: 2, grp: 3, zero: 0 })).toBe(5);
    expect(totalUnreadFrom({ a: -1, b: 'x' as unknown as number })).toBe(0);
    expect(totalUnreadFrom(undefined)).toBe(0);
  });
});

describe('syncAppBadge', () => {
  it('sets the badge to the unread total', async () => {
    mockUnread.unreadCounts = { peer: 2, group: 1 };
    await syncAppBadge();
    expect(badgeMock).toHaveBeenCalledWith(3);
  });

  it('clears it once everything is read', async () => {
    mockUnread.unreadCounts = { peer: 0, group: 0 };
    await syncAppBadge();
    expect(badgeMock).toHaveBeenCalledWith(0);
  });

  it('badge switched off → always 0, whatever is unread', async () => {
    usePreferences.setState({ notifBadge: false });
    mockUnread.unreadCounts = { peer: 7 };
    await syncAppBadge();
    expect(badgeMock).toHaveBeenCalledWith(0);
  });

  it('fail-soft when the platform rejects', async () => {
    badgeMock.mockRejectedValueOnce(new Error('no badge support'));
    mockUnread.unreadCounts = { peer: 1 };
    await expect(syncAppBadge()).resolves.toBeUndefined();
  });
});
