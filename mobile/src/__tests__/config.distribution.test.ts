/**
 * DISTRIBUTION / REMOTE_PUSH_ENABLED — the build-time switch that separates the
 * Play build from the F-Droid / Obtainium one.
 *
 * Two directions matter and both are pinned here:
 *
 *  - a foss build must NEVER reach a proprietary push service. If this flag
 *    regressed to true, the F-Droid artifact would try to get an FCM token on a
 *    device with no Play Services, and the build would stop qualifying for
 *    inclusion in the first place.
 *  - an unrecognised value must fall back to 'play'. A typo in a build profile
 *    silently disabling push wake-ups for every Play user is a far worse failure
 *    than a typo that leaves them on.
 */
describe('DISTRIBUTION / REMOTE_PUSH_ENABLED', () => {
  const ORIG = process.env.EXPO_PUBLIC_DISTRIBUTION;

  afterEach(() => {
    if (ORIG === undefined) delete process.env.EXPO_PUBLIC_DISTRIBUTION;
    else process.env.EXPO_PUBLIC_DISTRIBUTION = ORIG;
    jest.resetModules();
  });

  it('defaults to the play build with remote push enabled', () => {
    delete process.env.EXPO_PUBLIC_DISTRIBUTION;
    jest.resetModules();
    const { DISTRIBUTION, REMOTE_PUSH_ENABLED } = require('../config');
    expect(DISTRIBUTION).toBe('play');
    expect(REMOTE_PUSH_ENABLED).toBe(true);
  });

  it('switches to foss and disables remote push when asked', () => {
    process.env.EXPO_PUBLIC_DISTRIBUTION = 'foss';
    jest.resetModules();
    const { DISTRIBUTION, REMOTE_PUSH_ENABLED } = require('../config');
    expect(DISTRIBUTION).toBe('foss');
    expect(REMOTE_PUSH_ENABLED).toBe(false);
  });

  it('falls back to play on an unrecognised value, keeping push alive', () => {
    process.env.EXPO_PUBLIC_DISTRIBUTION = 'FOSS_typo';
    jest.resetModules();
    const { DISTRIBUTION, REMOTE_PUSH_ENABLED } = require('../config');
    expect(DISTRIBUTION).toBe('play');
    expect(REMOTE_PUSH_ENABLED).toBe(true);
  });
});
