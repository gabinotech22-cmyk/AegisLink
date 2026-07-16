/**
 * push.ts — remote call_wakeup banner sweep regression tests (iOS parity)
 *
 * Field bug (iPhone, 2026-07-16): when the app is killed/backgrounded, the
 * incoming-call banner the user sees is the REMOTE APNs push ("Llamada
 * entrante · E2EE", category aegislink-call with Contestar/Rechazar). Its
 * notification identifier is assigned by the OS, so the local-only dismiss in
 * dismissIncomingCallNotification could never retract it: after the call ended
 * the actionable banner lingered (no "Llamada perdida" replacement, unlike
 * Android) and competed with the in-app full-screen ring UI.
 *
 * The fix sweeps every PRESENTED notification whose data.kind === 'call_wakeup'
 * inside dismissIncomingCallNotification — the single choke point already
 * called on ring-UI mount, answer, decline, and finalizeCall.
 */

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn().mockResolvedValue(undefined),
  setNotificationCategoryAsync: jest.fn().mockResolvedValue(undefined),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn().mockResolvedValue(null),
  getPermissionsAsync: jest.fn().mockResolvedValue({ granted: false, canAskAgain: false }),
  scheduleNotificationAsync: jest.fn().mockResolvedValue('notif-id-1'),
  dismissNotificationAsync: jest.fn().mockResolvedValue(undefined),
  getPresentedNotificationsAsync: jest.fn().mockResolvedValue([]),
  AndroidImportance: { HIGH: 4, MAX: 5 },
  AndroidNotificationPriority: { MAX: 'max', DEFAULT: 'default' },
}));
jest.mock('../../config', () => ({ SERVER_URL: 'https://example.test' }));

import * as Notifications from 'expo-notifications';
import { dismissIncomingCallNotification } from '../push';

const mockDismiss = Notifications.dismissNotificationAsync as jest.Mock;
const mockPresented = Notifications.getPresentedNotificationsAsync as jest.Mock;

function presented(identifier: string, data: Record<string, unknown> | null) {
  return { request: { identifier, content: { data } } };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDismiss.mockResolvedValue(undefined);
  mockPresented.mockResolvedValue([]);
});

describe('dismissIncomingCallNotification — remote call_wakeup sweep', () => {
  it('dismisses the OS-identified remote call_wakeup banner alongside the local one', async () => {
    mockPresented.mockResolvedValue([
      presented('os-assigned-remote-1', { kind: 'call_wakeup' }),
      presented('some-message-notif', { kind: 'wakeup' }),
      presented('no-data-notif', null),
    ]);

    await dismissIncomingCallNotification('call-123');

    const dismissed = mockDismiss.mock.calls.map((c) => c[0] as string);
    expect(dismissed).toContain('incoming-call-call-123'); // local banner
    expect(dismissed).toContain('os-assigned-remote-1');   // remote APNs banner
    // Unrelated notifications (message wake, dataless) are left alone.
    expect(dismissed).not.toContain('some-message-notif');
    expect(dismissed).not.toContain('no-data-notif');
  });

  it('survives a notification-center failure without throwing', async () => {
    mockPresented.mockRejectedValue(new Error('center unavailable'));
    await expect(dismissIncomingCallNotification('call-456')).resolves.toBeUndefined();
    // The local dismiss still happened.
    expect(mockDismiss).toHaveBeenCalledWith('incoming-call-call-456');
  });
});
