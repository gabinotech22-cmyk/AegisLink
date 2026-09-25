/**
 * Cold-start app lock decision (src/renderer/lock/coldLock.ts, applied in App.tsx; twin of mobile).
 *
 * Pins both halves of the fix: the app still locks on every cold start with
 * the lock enabled, even when the preferences load after the identity; and
 * turning the lock on in settings no longer locks the app on the spot.
 */
import { describe, it, expect } from 'vitest';
import { coldLockAction } from '../coldLock';

type Params = Parameters<typeof coldLockAction>[0];

/** Replays a sequence of states the way App.tsx's effect sees them. */
function run(states: Array<Omit<Params, 'alreadyDecided'>>): string[] {
  let decided = false;
  const out: string[] = [];
  for (const s of states) {
    const a = coldLockAction({ ...s, alreadyDecided: decided });
    if (a === 'reset') decided = false;
    else if (a === 'lock' || a === 'keep') decided = true;
    out.push(a);
  }
  return out;
}

const ready = { hasIdentity: true, identityReady: true };

describe('cold-start lock', () => {
  it('locks a cold start with the lock enabled', () => {
    expect(run([{ ...ready, prefsHydrated: true, appLockEnabled: true }])).toEqual(['lock']);
  });

  it('waits for the persisted preferences instead of deciding on the store default', () => {
    // Identity ready first, preferences (lock ON) a tick later: must still lock.
    expect(
      run([
        { ...ready, prefsHydrated: false, appLockEnabled: false },
        { ...ready, prefsHydrated: true, appLockEnabled: true },
      ]),
    ).toEqual(['wait', 'lock']);
  });

  it('waits while the identity is still loading', () => {
    expect(coldLockAction({ hasIdentity: true, identityReady: false, prefsHydrated: true, appLockEnabled: true, alreadyDecided: false })).toBe('wait');
  });

  it('does not lock the app when the lock is turned on after start-up', () => {
    expect(
      run([
        { ...ready, prefsHydrated: true, appLockEnabled: false },
        { ...ready, prefsHydrated: true, appLockEnabled: true }, // toggled in settings
      ]),
    ).toEqual(['keep', 'keep']);
  });

  it('decides again for a new identity (panic wipe, onboarding, profile switch)', () => {
    expect(
      run([
        { ...ready, prefsHydrated: true, appLockEnabled: false },
        { hasIdentity: false, identityReady: false, prefsHydrated: true, appLockEnabled: true },
        { ...ready, prefsHydrated: true, appLockEnabled: true },
      ]),
    ).toEqual(['keep', 'reset', 'lock']);
  });
});
