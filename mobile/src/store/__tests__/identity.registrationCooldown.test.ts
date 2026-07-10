/**
 * identity store — registration retry-storm cooldown tests
 *
 * Covers the fix for the "registration retry storm": when the relay
 * rate-limits us (429 with retryAfterMs), the client must:
 *   1. Persist an ABSOLUTE cooldown deadline (not a relative duration) so a
 *      restart doesn't forget it and re-mine PoW.
 *   2. Never call fetchPowChallenge/solvePoW (via ensureRegistered) while
 *      that cooldown is still active.
 *   3. Rehydrate the deadline from persistence on cold start, clearing it if
 *      already expired.
 *   4. Surface a rate-limit-specific state (distinguishable from a generic
 *      network failure) so the UI can show an honest banner.
 */

const secureStoreBacking: Record<string, string> = {};

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn((key: string) => Promise.resolve(secureStoreBacking[key] ?? null)),
  setItemAsync: jest.fn((key: string, value: string) => {
    secureStoreBacking[key] = value;
    return Promise.resolve(undefined);
  }),
  deleteItemAsync: jest.fn((key: string) => {
    delete secureStoreBacking[key];
    return Promise.resolve(undefined);
  }),
  AFTER_FIRST_UNLOCK: 'AFTER_FIRST_UNLOCK',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY',
}));

// In-memory backing for the `ss` wrapper (utils/secureStore) — this is the
// slot the cooldown deadline is persisted under (aegis.reg.cooldown.v1).
const ssBacking: Record<string, string> = {};
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn((key: string) => Promise.resolve(ssBacking[key] ?? null)),
    set: jest.fn((key: string, value: string) => { ssBacking[key] = value; return Promise.resolve(undefined); }),
    delete: jest.fn((key: string) => { delete ssBacking[key]; return Promise.resolve(undefined); }),
  },
}));

const mockStoredIdentity = {
  aegisId: 'REAL-AAAA-BBBB',
  publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
  secretKeyB64: Buffer.alloc(32, 2).toString('base64'),
  signingPublicKeyB64: Buffer.alloc(32, 3).toString('base64'),
  signingSecretKeyB64: Buffer.alloc(64, 4).toString('base64'),
  createdAt: 1000,
};

jest.mock('../../db/local', () => ({
  loadIdentity: jest.fn().mockResolvedValue({
    aegisId: 'REAL-AAAA-BBBB',
    publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
    secretKeyB64: Buffer.alloc(32, 2).toString('base64'),
    signingPublicKeyB64: Buffer.alloc(32, 3).toString('base64'),
    signingSecretKeyB64: Buffer.alloc(64, 4).toString('base64'),
    createdAt: 1000,
  }),
  saveIdentity: jest.fn().mockResolvedValue(undefined),
  setActiveDbSlot: jest.fn(),
  deleteIdentitySlot: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../crypto/ensureRegistered', () => ({
  ensureRegistered: jest.fn(),
}));

jest.mock('../../crypto/media', () => ({
  purgeCachedDecryptedMedia: jest.fn().mockResolvedValue(undefined),
}));

import { useIdentity } from '../identity';
import { usePreferences } from '../preferences';
import { ensureRegistered } from '../../crypto/ensureRegistered';

const mockEnsureRegistered = ensureRegistered as jest.Mock;

function resetStore(): void {
  useIdentity.setState({
    identity: null,
    status: 'idle',
    hydrated: false,
    displayName: 'you',
    avatarColor: '#05b875',
    avatarImage: null,
    profileStatus: '',
    publishStatus: 'unknown',
    publishError: null,
    publishRetryAfterMs: null,
    publishCooldownUntilMs: null,
    activeSlotId: 'self',
    slotsList: ['self'],
  });
  usePreferences.setState({ duressActive: false });
}

describe('identity store — registration retry-storm cooldown', () => {
  beforeEach(() => {
    for (const k of Object.keys(secureStoreBacking)) delete secureStoreBacking[k];
    for (const k of Object.keys(ssBacking)) delete ssBacking[k];
    mockEnsureRegistered.mockReset();
    resetStore();
  });

  it('(a) does NOT call ensureRegistered while a cooldown is active', async () => {
    const futureDeadline = Date.now() + 10 * 60 * 1000; // 10 min from now
    useIdentity.setState({
      identity: {
        aegisId: mockStoredIdentity.aegisId,
        publicKeyB64: mockStoredIdentity.publicKeyB64,
        secretKeyB64: mockStoredIdentity.secretKeyB64,
        signingPublicKeyB64: mockStoredIdentity.signingPublicKeyB64,
        signingSecretKeyB64: mockStoredIdentity.signingSecretKeyB64,
        createdAt: mockStoredIdentity.createdAt,
      } as never,
      publishStatus: 'failed',
      publishCooldownUntilMs: futureDeadline,
    });

    await useIdentity.getState().retryPublish();

    expect(mockEnsureRegistered).not.toHaveBeenCalled();
    // Still surfaces a rate-limit-distinguishable state with time remaining.
    expect(useIdentity.getState().publishStatus).toBe('failed');
    expect(useIdentity.getState().publishError).toBe('rate_limited');
    expect(useIdentity.getState().publishRetryAfterMs).toBeGreaterThan(0);
  });

  it('(b) persists the cooldown deadline on a 429 and (c) rehydrates it on next hydrate()', async () => {
    mockEnsureRegistered.mockResolvedValueOnce({ ok: false, error: 'HTTP 429', retryAfterMs: 15 * 60 * 1000 });

    // Not yet published — hydrate() triggers a visible (non-silent) publish.
    await useIdentity.getState().hydrate();
    // Flush the background void runPublish() microtask queue.
    await new Promise((r) => setTimeout(r, 0));

    expect(useIdentity.getState().publishCooldownUntilMs).not.toBeNull();
    expect(ssBacking['aegis.reg.cooldown.v1']).toBeTruthy();

    // Cold start: fresh hydrate() call must rehydrate the same deadline and
    // must NOT call ensureRegistered again (still within the cooldown window).
    mockEnsureRegistered.mockClear();
    resetStore();
    await useIdentity.getState().hydrate();
    await new Promise((r) => setTimeout(r, 0));

    expect(useIdentity.getState().publishCooldownUntilMs).not.toBeNull();
    expect(mockEnsureRegistered).not.toHaveBeenCalled();
  });

  it('(c) clears an expired cooldown on hydrate() and allows a fresh attempt', async () => {
    ssBacking['aegis.reg.cooldown.v1'] = String(Date.now() - 1000); // already expired
    mockEnsureRegistered.mockResolvedValueOnce({ ok: true });

    await useIdentity.getState().hydrate();
    await new Promise((r) => setTimeout(r, 0));

    expect(useIdentity.getState().publishCooldownUntilMs).toBeNull();
    expect(ssBacking['aegis.reg.cooldown.v1']).toBeUndefined();
    expect(mockEnsureRegistered).toHaveBeenCalledTimes(1);
  });

  it('(d) a 429 produces a rate-limit state distinguishable from a generic network error', async () => {
    mockEnsureRegistered.mockResolvedValueOnce({ ok: false, error: 'HTTP 429', retryAfterMs: 5000 });
    await useIdentity.getState().hydrate();
    await new Promise((r) => setTimeout(r, 0));
    expect(useIdentity.getState().publishRetryAfterMs).toBe(5000);

    for (const k of Object.keys(ssBacking)) delete ssBacking[k];
    resetStore();
    mockEnsureRegistered.mockResolvedValueOnce({ ok: false, error: 'Network request failed' });
    await useIdentity.getState().hydrate();
    await new Promise((r) => setTimeout(r, 0));
    expect(useIdentity.getState().publishRetryAfterMs).toBeNull();
    expect(useIdentity.getState().publishError).toBe('Network request failed');
  });
});
