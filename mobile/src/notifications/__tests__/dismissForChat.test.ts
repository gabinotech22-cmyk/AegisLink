/**
 * Reading a chat in-app clears its tray notifications (until 1.0.7 only a TAP
 * on the notification dismissed it — opening the chat from the list left them).
 */
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  scheduleNotificationAsync: jest.fn(async () => 'id'),
  getPresentedNotificationsAsync: jest.fn(async () => []),
  dismissNotificationAsync: jest.fn(async () => undefined),
  AndroidImportance: { HIGH: 4, MAX: 5 },
  AndroidNotificationPriority: { HIGH: 'high', MAX: 'max' },
}));
jest.mock('../../config', () => ({ SERVER_URL: 'https://example.test' }));
jest.mock('../../utils/secureStore', () => ({
  ss: { get: jest.fn(async () => null), set: jest.fn(async () => undefined), delete: jest.fn(async () => undefined) },
}));

import * as Notifications from 'expo-notifications';
import { dismissNotificationsForChat } from '../push';

const presented = Notifications.getPresentedNotificationsAsync as jest.Mock;
const dismiss = Notifications.dismissNotificationAsync as jest.Mock;
const n = (id: string, data: Record<string, unknown>) => ({ request: { identifier: id, content: { data } } });

beforeEach(() => { presented.mockReset(); dismiss.mockClear(); });

it('dismisses only the notifications of that contact or group', async () => {
  presented.mockResolvedValue([
    n('n1', { fromAegisId: 'ALICE', isGroup: false }),
    n('n2', { fromAegisId: 'BOB', isGroup: false }),
    n('n3', { fromAegisId: 'ALICE', isGroup: true, groupId: 'GRP' }),
    n('n4', { kind: 'call_wakeup' }),
  ]);
  await dismissNotificationsForChat('ALICE');
  expect(dismiss.mock.calls.map((c) => c[0])).toEqual(['n1']);
  dismiss.mockClear();
  await dismissNotificationsForChat('GRP');
  expect(dismiss.mock.calls.map((c) => c[0])).toEqual(['n3']);
});

it('fail-soft when the notification center is unavailable', async () => {
  presented.mockRejectedValue(new Error('no center'));
  await expect(dismissNotificationsForChat('ALICE')).resolves.toBeUndefined();
});
