import { shouldConnectSocket, shouldArmNetErrorTimer } from '../socketGate';

describe('shouldConnectSocket', () => {
  it('does NOT connect while publishStatus is publishing — the core race fix', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'publishing', duressActive: false }),
    ).toBe(false);
  });

  it('connects once publishStatus is published', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'published', duressActive: false }),
    ).toBe(true);
  });

  it('connects for a resolved failed publish (retry funnels through retryPublish, not the connect gate)', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'failed', duressActive: false }),
    ).toBe(true);
  });

  it('connects for the unknown (not-yet-started) state — preserves pre-fix behavior for existing users', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'unknown', duressActive: false }),
    ).toBe(true);
  });

  it('never connects without an identity, regardless of publishStatus', () => {
    expect(
      shouldConnectSocket({ hasIdentity: false, identityStatus: 'ready', publishStatus: 'published', duressActive: false }),
    ).toBe(false);
  });

  it('never connects while identity status is not ready', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'generating', publishStatus: 'published', duressActive: false }),
    ).toBe(false);
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'loading', publishStatus: 'published', duressActive: false }),
    ).toBe(false);
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'idle', publishStatus: 'published', duressActive: false }),
    ).toBe(false);
  });

  // CodeRabbit PR #301 FIX 4 (CRITICAL security): never connect with the
  // decoy identity — doing so would leak that panic/duress mode is active to
  // the relay.
  describe('duressActive (decoy identity must never reach the relay)', () => {
    it('never connects while duressActive, even with a fully "ready"+"published" identity', () => {
      expect(
        shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'published', duressActive: true }),
      ).toBe(false);
    });

    it('duressActive overrides every other favorable condition (failed/unknown too)', () => {
      expect(
        shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'failed', duressActive: true }),
      ).toBe(false);
      expect(
        shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'unknown', duressActive: true }),
      ).toBe(false);
    });

    it('duressActive=false with everything else favorable still connects (no regression)', () => {
      expect(
        shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'published', duressActive: false }),
      ).toBe(true);
    });
  });
});

describe('shouldArmNetErrorTimer', () => {
  it('does not arm while a registration attempt is publishing', () => {
    expect(shouldArmNetErrorTimer({ showOnboarding: false, publishStatus: 'publishing' })).toBe(false);
  });

  it('does not arm while publishStatus is unknown (not yet resolved)', () => {
    expect(shouldArmNetErrorTimer({ showOnboarding: false, publishStatus: 'unknown' })).toBe(false);
  });

  it('does not arm while onboarding is on screen, even if publishStatus resolved', () => {
    expect(shouldArmNetErrorTimer({ showOnboarding: true, publishStatus: 'published' })).toBe(false);
    expect(shouldArmNetErrorTimer({ showOnboarding: true, publishStatus: 'failed' })).toBe(false);
  });

  it('arms once a registration has genuinely failed — REGISTRATION FAILED banner must still surface', () => {
    expect(shouldArmNetErrorTimer({ showOnboarding: false, publishStatus: 'failed' })).toBe(true);
  });

  it('arms for a normal published identity that is simply offline', () => {
    expect(shouldArmNetErrorTimer({ showOnboarding: false, publishStatus: 'published' })).toBe(true);
  });
});
