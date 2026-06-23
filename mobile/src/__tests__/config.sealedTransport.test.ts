/**
 * Regression — SEALED_TRANSPORT_VERSION defaults to 'v2' (A-6 Fases 1-3 enabled).
 *
 * Pins the default so a future edit can't silently revert sealed-sender transport
 * to v1, which would re-expose the sender's aegisId to the relay on online
 * delivery. Opt-out remains EXPO_PUBLIC_SEALED_VERSION=v1.
 */
describe('SEALED_TRANSPORT_VERSION default', () => {
  const ORIG = process.env.EXPO_PUBLIC_SEALED_VERSION;

  afterEach(() => {
    if (ORIG === undefined) delete process.env.EXPO_PUBLIC_SEALED_VERSION;
    else process.env.EXPO_PUBLIC_SEALED_VERSION = ORIG;
    jest.resetModules();
  });

  it('defaults to v2 when the env flag is unset', () => {
    delete process.env.EXPO_PUBLIC_SEALED_VERSION;
    jest.resetModules();
    const { SEALED_TRANSPORT_VERSION } = require('../config');
    expect(SEALED_TRANSPORT_VERSION).toBe('v2');
  });

  it('opts out to v1 when EXPO_PUBLIC_SEALED_VERSION=v1', () => {
    process.env.EXPO_PUBLIC_SEALED_VERSION = 'v1';
    jest.resetModules();
    const { SEALED_TRANSPORT_VERSION } = require('../config');
    expect(SEALED_TRANSPORT_VERSION).toBe('v1');
  });
});
