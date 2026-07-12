import { describe, it, expect } from 'vitest';
import { shouldConnectSocket } from '../socketGate';

describe('shouldConnectSocket (desktop parity with mobile src/utils/socketGate.ts)', () => {
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
  });

  // CodeRabbit PR #301 FIX 4 (CRITICAL security): desktop's App.tsx was
  // MISSING the duress guard entirely (present on mobile at every
  // connectSocket call site) — the decoy identity (AEGIS-MOCK) could reach
  // the relay under coercion, leaking that panic mode is active.
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
