import { describe, it, expect } from 'vitest';
import { shouldConnectSocket } from '../socketGate';

describe('shouldConnectSocket (desktop parity with mobile src/utils/socketGate.ts)', () => {
  it('does NOT connect while publishStatus is publishing — the core race fix', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'publishing' }),
    ).toBe(false);
  });

  it('connects once publishStatus is published', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'published' }),
    ).toBe(true);
  });

  it('connects for a resolved failed publish (retry funnels through retryPublish, not the connect gate)', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'failed' }),
    ).toBe(true);
  });

  it('connects for the unknown (not-yet-started) state — preserves pre-fix behavior for existing users', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'ready', publishStatus: 'unknown' }),
    ).toBe(true);
  });

  it('never connects without an identity, regardless of publishStatus', () => {
    expect(
      shouldConnectSocket({ hasIdentity: false, identityStatus: 'ready', publishStatus: 'published' }),
    ).toBe(false);
  });

  it('never connects while identity status is not ready', () => {
    expect(
      shouldConnectSocket({ hasIdentity: true, identityStatus: 'generating', publishStatus: 'published' }),
    ).toBe(false);
  });
});
