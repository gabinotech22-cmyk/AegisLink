/**
 * identity store — retryPublish(force) + cross-slot publish correctness
 * (CodeRabbit PR #301 review findings)
 *
 * FIX 1 (reconnection loop, CRITICAL): retryPublish() used to early-return
 * whenever publishStatus === 'published', even when that status was a STALE
 * marker restored by hydrate() from `aegis.published.<slot>`. A relay
 * `unknown_identity` is proof the relay has forgotten us — without a way to
 * force past the 'published' early-return, socket/client.ts's handler would
 * reconnect without republishing, get unknown_identity again, forever.
 * `retryPublish(true)` bypasses ONLY the 'published' guard; the 'publishing'
 * in-flight guard must stay active even when forced (never duplicate a
 * registration already underway).
 *
 * FIX 3 (cross-slot corruption): runPublish() used to write the GLOBAL
 * publishStatus/publishError fields unconditionally after its await,
 * regardless of whether the identity/slot it was publishing for was still
 * the active one. createSlot() backgrounds a publish for a brand-new,
 * NON-active slot (`void runPublish(identity, newSlotId)`) — its completion
 * must never clobber the publishStatus of whatever identity is actually
 * active by the time it resolves.
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

const ssBacking: Record<string, string> = {};
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn((key: string) => Promise.resolve(ssBacking[key] ?? null)),
    set: jest.fn((key: string, value: string) => { ssBacking[key] = value; return Promise.resolve(undefined); }),
    delete: jest.fn((key: string) => { delete ssBacking[key]; return Promise.resolve(undefined); }),
  },
}));

jest.mock('../../db/local', () => ({
  loadIdentity: jest.fn().mockResolvedValue(null),
  saveIdentity: jest.fn().mockResolvedValue(undefined),
  setActiveDbSlot: jest.fn(),
  resetDbConnection: jest.fn(),
  deleteIdentitySlot: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../crypto/ensureRegistered', () => ({
  ensureRegistered: jest.fn(),
}));

jest.mock('../../crypto/media', () => ({
  purgeCachedDecryptedMedia: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));

import { useIdentity } from '../identity';
import { usePreferences } from '../preferences';
import { ensureRegistered } from '../../crypto/ensureRegistered';
import type { Identity } from '../../crypto/identity';

const mockEnsureRegistered = ensureRegistered as jest.Mock;

function makeIdentity(aegisId: string): Identity {
  return {
    aegisId,
    publicKeyB64: Buffer.alloc(32, 1).toString('base64'),
    secretKeyB64: Buffer.alloc(32, 2).toString('base64'),
    signingPublicKeyB64: Buffer.alloc(32, 3).toString('base64'),
    signingSecretKeyB64: Buffer.alloc(64, 4).toString('base64'),
    createdAt: 1000,
  } as unknown as Identity;
}

function resetStore(overrides: Partial<ReturnType<typeof useIdentity.getState>> = {}): void {
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
    ...overrides,
  });
  usePreferences.setState({ duressActive: false });
}

describe('identity store — retryPublish(force) bypasses only the "published" guard', () => {
  beforeEach(() => {
    for (const k of Object.keys(secureStoreBacking)) delete secureStoreBacking[k];
    for (const k of Object.keys(ssBacking)) delete ssBacking[k];
    mockEnsureRegistered.mockReset();
    resetStore();
  });

  it('without force: does NOT call ensureRegistered when publishStatus is a (possibly stale) "published"', async () => {
    resetStore({ identity: makeIdentity('AEGIS-A'), publishStatus: 'published', activeSlotId: 'self' });

    await useIdentity.getState().retryPublish();

    expect(mockEnsureRegistered).not.toHaveBeenCalled();
    expect(useIdentity.getState().publishStatus).toBe('published');
  });

  it('with force=true: DOES call ensureRegistered even when publishStatus is "published" (stale marker)', async () => {
    resetStore({ identity: makeIdentity('AEGIS-A'), publishStatus: 'published', activeSlotId: 'self' });
    mockEnsureRegistered.mockResolvedValueOnce({ ok: true });

    await useIdentity.getState().retryPublish(true);

    expect(mockEnsureRegistered).toHaveBeenCalledTimes(1);
    expect(useIdentity.getState().publishStatus).toBe('published');
  });

  it('force=true still does NOT bypass the "publishing" in-flight guard', async () => {
    resetStore({ identity: makeIdentity('AEGIS-A'), publishStatus: 'publishing', activeSlotId: 'self' });

    await useIdentity.getState().retryPublish(true);

    expect(mockEnsureRegistered).not.toHaveBeenCalled();
    expect(useIdentity.getState().publishStatus).toBe('publishing');
  });
});

describe('identity store — runPublish ignores stale completions for a no-longer-active identity/slot', () => {
  beforeEach(() => {
    for (const k of Object.keys(secureStoreBacking)) delete secureStoreBacking[k];
    for (const k of Object.keys(ssBacking)) delete ssBacking[k];
    mockEnsureRegistered.mockReset();
    resetStore();
  });

  it("createSlot's background publish for a NON-active slot never clobbers the active identity's publishStatus", async () => {
    // Active identity is slot A, already published — this is what the user
    // is currently looking at (e.g. the Home banner should stay silent).
    // createSlot() creates a brand-new identity for a NEW slot ('slot_1')
    // and backgrounds a publish for it via `void runPublish(identity,
    // newSlotId)` WITHOUT ever changing the store's `activeSlotId` field
    // (only the DB pointer is temporarily swapped, restored before
    // createSlot() returns) — so runPublish's isCurrentTarget() guard must
    // see "slot_1 !== activeSlotId ('self')" and skip every publishStatus
    // write for the whole duration of the background publish.
    const identityA = makeIdentity('AEGIS-ACTIVE-A');
    resetStore({ identity: identityA, publishStatus: 'published', activeSlotId: 'self' });

    // createSlot() fires `void runPublish(identity, newSlotId)` — fire and
    // forget — so createSlot() itself resolves without waiting on it. The
    // background publish for the new slot resolves 'ok' shortly after.
    mockEnsureRegistered.mockResolvedValueOnce({ ok: true });

    const newSlotId = await useIdentity.getState().createSlot();
    expect(newSlotId).toBe('slot_1');

    // Flush the background `void runPublish(...)` microtask chain.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The new (non-active) slot's publish completion must NOT have touched
    // A's publishStatus/identity — isCurrentTarget() inside runPublish must
    // have seen 'slot_1' !== activeSlotId ('self') and skipped every write.
    expect(mockEnsureRegistered).toHaveBeenCalledTimes(1);
    expect(useIdentity.getState().publishStatus).toBe('published');
    expect(useIdentity.getState().identity?.aegisId).toBe('AEGIS-ACTIVE-A');
    expect(useIdentity.getState().activeSlotId).toBe('self');
  });
});
