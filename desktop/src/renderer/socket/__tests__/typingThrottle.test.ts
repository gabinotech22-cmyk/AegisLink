import { describe, test, expect } from 'vitest';
/**
 * typingThrottle (desktop) — mirrors mobile/src/socket/__tests__/
 * typingThrottle.test.ts so both platforms throttle sealed typing identically.
 * A sealed typing signal is a full ratchet-encrypted mailbox message, so it must
 * not be emitted per keystroke.
 */
import { shouldSendSealedTyping, SEALED_TYPING_REFRESH_MS } from '../typingThrottle';

describe('shouldSendSealedTyping (desktop)', () => {
  test('sends the first "typing" (no prior signal)', () => {
    expect(shouldSendSealedTyping(undefined, true, 1000)).toBe(true);
  });

  test('never sends "stopped" without a prior "typing"', () => {
    expect(shouldSendSealedTyping(undefined, false, 1000)).toBe(false);
    expect(shouldSendSealedTyping({ isTyping: false, at: 500 }, false, 1000)).toBe(false);
  });

  test('throttles rapid "typing" refreshes within the window (anti-flood)', () => {
    const prev = { isTyping: true, at: 1000 };
    expect(shouldSendSealedTyping(prev, true, 1000 + SEALED_TYPING_REFRESH_MS - 1)).toBe(false);
  });

  test('re-sends "typing" once the refresh window elapses', () => {
    const prev = { isTyping: true, at: 1000 };
    expect(shouldSendSealedTyping(prev, true, 1000 + SEALED_TYPING_REFRESH_MS)).toBe(true);
    expect(shouldSendSealedTyping(prev, true, 1000 + SEALED_TYPING_REFRESH_MS + 5000)).toBe(true);
  });

  test('sends "stopped" when we had announced "typing"', () => {
    expect(shouldSendSealedTyping({ isTyping: true, at: 1000 }, false, 1200)).toBe(true);
  });

  test('sends "typing" again after a "stopped"', () => {
    expect(shouldSendSealedTyping({ isTyping: false, at: 1000 }, true, 1200)).toBe(true);
  });
});
