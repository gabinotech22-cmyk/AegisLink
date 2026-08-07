/**
 * callWakePayload.test.ts
 *
 * Regression for the iOS CALL wake-up throttling bug (audit 2026-08-07).
 *
 * #378 removed `_contentAvailable` from the MESSAGE wake-up (notifyRecipient)
 * because on iOS that flag turns a visible-alert push into a BACKGROUND
 * notification, subject to the background-refresh budget — once the budget is
 * spent the OS drops the alert with it and a force-quit iPhone shows nothing.
 * The call paths were left untouched on the assumption that calls are rare
 * enough never to exhaust the budget; they are not, and a missed call is a
 * worse failure than a missed message. Both call wake-ups now follow the same
 * per-platform split as the message one.
 *
 * Android KEEPS the flag: its headless background-reconnect task relies on the
 * background wake, and FCM high-priority data messages are not throttled.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import { jest } from '@jest/globals';
import { Expo } from 'expo-server-sdk';
import { initDb, pushRepo } from '../db/client.js';
import { sendCallWakeUp, sendGroupCallWakeUp } from '../push/expo.js';

beforeAll(async () => {
  await initDb();
});

afterEach(() => {
  // Restore AFTER assertions — mockRestore clears spy.mock.calls.
  jest.restoreAllMocks();
});

/** Register one iOS + one Android Expo token for `aegisId`. */
async function registerBothPlatforms(aegisId: string, tag: string): Promise<void> {
  await pushRepo.upsert({
    aegis_id: aegisId,
    expo_token: `ExponentPushToken[ios-${tag}]`,
    platform: 'ios',
    updated_at: Date.now(),
  });
  await pushRepo.upsert({
    aegis_id: aegisId,
    expo_token: `ExponentPushToken[and-${tag}]`,
    platform: 'android',
    updated_at: Date.now(),
  });
  expect((await pushRepo.forRecipient(aegisId)).length).toBe(2);
}

describe('call wake-up push payload (iOS throttle fix 2026-08-07)', () => {
  test('sendCallWakeUp: iOS omits content-available, Android keeps it', async () => {
    const aegisId = 'CW1-0000-0001';
    await registerBothPlatforms(aegisId, 'cw1');

    const spy = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);

    // APNs is unconfigured under test, so sendVoipWakeUp is a no-op and the iOS
    // Expo push is never suppressed — exactly the path a real device takes today.
    const pushed = await sendCallWakeUp(aegisId, 'CALLER-0000-0001', 'audio', 'call-uuid-cw1');
    expect(pushed).toBe(true);

    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0]![0];
    const ios = sent.find((m) => m.to === `ExponentPushToken[ios-cw1]`);
    const android = sent.find((m) => m.to === `ExponentPushToken[and-cw1]`);
    expect(ios).toBeDefined();
    expect(android).toBeDefined();

    // CORE of the fix.
    expect(ios!._contentAvailable).toBeUndefined();
    expect(android!._contentAvailable).toBe(true);

    // Still a zero-metadata ringing heads-up on both platforms: no caller, no
    // media hint, no callId — those stay sealed inside call:invite.
    for (const m of [ios!, android!]) {
      expect(m.title).toBe('AegisLink');
      expect(m.body).toContain('E2EE');
      expect(m.priority).toBe('high');
      expect(m.ttl).toBe(30);
      expect(m.data).toEqual({ kind: 'call_wakeup' });
      expect(JSON.stringify(m)).not.toContain('CALLER-0000-0001');
      expect(JSON.stringify(m)).not.toContain('call-uuid-cw1');
    }
  });

  test('sendGroupCallWakeUp: iOS omits content-available, Android keeps it', async () => {
    const aegisId = 'CW2-0000-0002';
    await registerBothPlatforms(aegisId, 'cw2');

    const spy = jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);

    const pushed = await sendGroupCallWakeUp(aegisId);
    expect(pushed).toBe(true);

    const sent = spy.mock.calls[0]![0];
    const ios = sent.find((m) => m.to === `ExponentPushToken[ios-cw2]`);
    const android = sent.find((m) => m.to === `ExponentPushToken[and-cw2]`);

    expect(ios!._contentAvailable).toBeUndefined();
    expect(android!._contentAvailable).toBe(true);
    expect(ios!.data).toEqual({ kind: 'call_wakeup' });
  });
});
