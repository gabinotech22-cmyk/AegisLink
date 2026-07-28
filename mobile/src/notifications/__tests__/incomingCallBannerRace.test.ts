/**
 * push.ts — incoming-call banner vs in-app ring screen race (single surface).
 *
 * Field bug (2026-07-28): with the app OPEN, the OS "Contestar / Rechazar"
 * banner and the full-screen in-app IncomingCallScreen showed at the same time
 * for one call and competed. Root cause: showIncomingCallNotification() is fired
 * async and unawaited from processIncomingInvite (it awaits i18n + scheduling),
 * so the banner could land AFTER the screen mounted and dismissed it — leaving a
 * duplicate actionable banner. The gate `AppState !== 'active'` was only checked
 * at the call site, in a transient wake window, never when the banner actually
 * scheduled.
 *
 * The fix makes the in-app screen the single authoritative surface:
 *   1. showIncomingCallNotification re-checks AppState === 'active' right before
 *      scheduling and skips (the screen already owns the call).
 *   2. dismissIncomingCallNotification (called on ring-UI mount) synchronously
 *      marks the callId suppressed, so a still-in-flight banner post no-ops.
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
jest.mock('../../i18n', () => ({ tAsync: jest.fn().mockResolvedValue('Llamada entrante') }));

// AppState is mutated per-test to model foreground vs background.
const rnMock = {
  AppState: { currentState: 'background' as string },
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
};
jest.mock('react-native', () => rnMock);

import * as Notifications from 'expo-notifications';
import { showIncomingCallNotification, dismissIncomingCallNotification } from '../push';

const mockSchedule = Notifications.scheduleNotificationAsync as jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  rnMock.AppState.currentState = 'background';
});

describe('showIncomingCallNotification — single authoritative surface', () => {
  it('posts the banner when the app is backgrounded (the screen is not visible)', async () => {
    rnMock.AppState.currentState = 'background';
    await showIncomingCallNotification('peer-A', 'Peer One', false, 'call-bg');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });

  it('does NOT post when the app is foreground — the in-app ring screen owns it', async () => {
    rnMock.AppState.currentState = 'active';
    await showIncomingCallNotification('peer-A', 'Peer One', false, 'call-fg');
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('does NOT post once the call was claimed by the ring screen (dismiss ran first)', async () => {
    // The screen mounted and dismissed before the (still in-flight) banner post.
    await dismissIncomingCallNotification('call-race');
    await showIncomingCallNotification('peer-A', 'Peer One', false, 'call-race');
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('suppression is per-call — a different call still rings', async () => {
    await dismissIncomingCallNotification('call-race');
    await showIncomingCallNotification('peer-A', 'Peer One', false, 'call-other');
    expect(mockSchedule).toHaveBeenCalledTimes(1);
  });
});
