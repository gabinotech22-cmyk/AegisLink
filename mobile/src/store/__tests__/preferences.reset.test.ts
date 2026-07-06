/**
 * store/preferences — reset() must clear duressActive (lockout regression).
 *
 * duressActive lives OUTSIDE the persisted Preferences interface (extra
 * Zustand state seeded separately in the store creator). Because Zustand's
 * setState does a partial merge, `reset()` spreading only `{ ...DEFAULTS }`
 * silently preserved whatever duressActive value was already in memory.
 * Real-world impact: a user unlocks under coercion with the duress PIN
 * (duressActive: true) and a panic wipe later fires — wipeDatabase() calls
 * usePreferences.getState().reset(), but duressActive survives as true,
 * trapping the freshly regenerated identity in decoy mode until the process
 * restarts. reset() must always force duressActive back to false.
 */

jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined),
  },
}));

import { usePreferences } from '../preferences';

describe('preferences store — reset() clears duressActive', () => {
  it('resets duressActive to false even when it was true before reset()', async () => {
    usePreferences.setState({ duressActive: true, appLockEnabled: true });
    expect(usePreferences.getState().duressActive).toBe(true); // sanity: this test's own setup

    await usePreferences.getState().reset();

    expect(usePreferences.getState().duressActive).toBe(false);
    expect(usePreferences.getState().appLockEnabled).toBe(false);
  });
});
