/**
 * notifyRecipientPayload.test.ts
 *
 * Regression for the iOS message-notification throttling bug (audit 2026-07-26).
 * The message wake-up push carried `_contentAvailable: true` on EVERY platform.
 * On iOS that flag makes the OS treat a visible-alert push as a BACKGROUND
 * notification subject to the background-refresh budget; under normal message
 * volume iOS silently throttles it and the alert never shows on a force-quit app.
 * Reproduced on-device: the identical payload WITHOUT the flag always displays,
 * and calls (same Expo path) stayed reliable only because they are rare and never
 * exhaust the budget.
 *
 * The fix drops `_contentAvailable` for iOS tokens (a plain high-priority alert is
 * never throttled) while KEEPING it for Android (its headless background-reconnect
 * task needs the wake). This proves the per-platform split, and that both still
 * carry the zero-metadata visible alert + wake marker.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import { jest } from '@jest/globals';
import { Expo } from 'expo-server-sdk';
import { initDb, pushRepo } from '../db/client.js';
import { notifyRecipient } from '../push/expo.js';

beforeAll(async () => {
  await initDb();
});

afterEach(() => {
  // Restore AFTER assertions (mockRestore clears spy.mock.calls, so never call it
  // before reading the recorded payload).
  jest.restoreAllMocks();
});

describe('notifyRecipient push payload (iOS throttle fix 2026-07-26)', () => {
  test('iOS omits content-available, Android keeps it, both keep the visible alert', async () => {
    const aegisId = 'NR1-0000-0001';
    await pushRepo.upsert({
      aegis_id: aegisId,
      expo_token: 'ExponentPushToken[ios-nr1]',
      platform: 'ios',
      updated_at: Date.now(),
    });
    await pushRepo.upsert({
      aegis_id: aegisId,
      expo_token: 'ExponentPushToken[and-nr1]',
      platform: 'android',
      updated_at: Date.now(),
    });

    // Sanity: the two tokens must actually be persisted for this identity.
    expect((await pushRepo.forRecipient(aegisId)).length).toBe(2);

    const spy = jest
      .spyOn(Expo.prototype, 'sendPushNotificationsAsync')
      .mockResolvedValue([]);

    await notifyRecipient(aegisId);

    expect(spy).toHaveBeenCalledTimes(1);
    const sent = spy.mock.calls[0]![0];
    const ios = sent.find((m) => m.to === 'ExponentPushToken[ios-nr1]');
    const android = sent.find((m) => m.to === 'ExponentPushToken[and-nr1]');
    expect(ios).toBeDefined();
    expect(android).toBeDefined();

    // CORE of the fix: the background flag is gone on iOS (else iOS throttles the
    // alert away on a force-quit app) and kept on Android (bg-reconnect wake).
    expect(ios!._contentAvailable).toBeUndefined();
    expect(android!._contentAvailable).toBe(true);

    // Both platforms still carry the zero-metadata visible alert + wake marker.
    for (const m of [ios!, android!]) {
      expect(m.title).toBe('AegisLink');
      expect(m.body).toContain('E2EE');
      expect(m.priority).toBe('high');
      expect(m.data).toEqual({ kind: 'wakeup' });
    }
  });
});
