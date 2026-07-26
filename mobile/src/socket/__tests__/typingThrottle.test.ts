/**
 * Regression: sealed typing must NOT flood one ratchet-encrypted mailbox message
 * per keystroke. shouldSendSealedTyping throttles "typing" refreshes and de-dupes
 * "stopped" so the sealed path stays cheap while keeping the indicator alive.
 */
import { shouldSendSealedTyping, SEALED_TYPING_REFRESH_MS } from '../typingThrottle';

describe('shouldSendSealedTyping', () => {
  it('sends the first "typing" (no prior signal)', () => {
    expect(shouldSendSealedTyping(undefined, true, 1000)).toBe(true);
  });

  it('never sends "stopped" without a prior "typing"', () => {
    expect(shouldSendSealedTyping(undefined, false, 1000)).toBe(false);
    expect(shouldSendSealedTyping({ isTyping: false, at: 500 }, false, 1000)).toBe(false);
  });

  it('throttles rapid "typing" refreshes within the window (the anti-flood fix)', () => {
    const prev = { isTyping: true, at: 1000 };
    expect(shouldSendSealedTyping(prev, true, 1000 + SEALED_TYPING_REFRESH_MS - 1)).toBe(false);
  });

  it('re-sends "typing" once the refresh window elapses (keeps indicator alive)', () => {
    const prev = { isTyping: true, at: 1000 };
    // At exactly the window boundary it refreshes (>=), and well past it too.
    expect(shouldSendSealedTyping(prev, true, 1000 + SEALED_TYPING_REFRESH_MS)).toBe(true);
    expect(shouldSendSealedTyping(prev, true, 1000 + SEALED_TYPING_REFRESH_MS + 5000)).toBe(true);
  });

  it('sends "stopped" when we had announced "typing"', () => {
    expect(shouldSendSealedTyping({ isTyping: true, at: 1000 }, false, 1200)).toBe(true);
  });

  it('sends "typing" again after a "stopped"', () => {
    expect(shouldSendSealedTyping({ isTyping: false, at: 1000 }, true, 1200)).toBe(true);
  });
});
