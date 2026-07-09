/**
 * pickingGuard.test.ts — post-picker settle delay (iOS modal-presentation race).
 *
 * Regression for: selecting a photo from the gallery and tapping the OS
 * picker's confirm button froze the app on iOS. Root cause: the app opened
 * another native Modal (the in-app avatar cropper) in the same tick the
 * picker's promise resolved, racing iOS's own dismissal animation — a UIKit
 * "present while dismissing" deadlock. Fix: withPickingGuard now holds its
 * resolution for a short beat after the wrapped function resolves.
 */
import { withPickingGuard, isPicking } from '../pickingGuard';

describe('withPickingGuard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('does not resolve in the same tick the wrapped picker call resolves', async () => {
    let resolved = false;
    const promise = withPickingGuard(async () => 'picked-uri').then((v) => {
      resolved = true;
      return v;
    });

    // Let the wrapped fn's microtask resolve, but not the settle delay.
    await Promise.resolve();
    await Promise.resolve();
    expect(resolved).toBe(false);

    jest.advanceTimersByTime(350);
    const result = await promise;
    expect(resolved).toBe(true);
    expect(result).toBe('picked-uri');
  });

  it('sets isPicking() true immediately when the wrapped call starts', () => {
    void withPickingGuard(async () => 'x');
    expect(isPicking()).toBe(true);
    jest.advanceTimersByTime(4250); // let clearWhenActive()'s fallback settle, cleaning up timers
  });

  it('propagates the wrapped function error without resolving early', async () => {
    const promise = withPickingGuard(async () => {
      throw new Error('picker failed');
    });
    await expect(promise).rejects.toThrow('picker failed');
  });
});
