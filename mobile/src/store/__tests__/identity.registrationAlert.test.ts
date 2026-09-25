/**
 * identity store — the registration-failure alert speaks to the user.
 *
 * It used to show the raw technical error as its message, e.g.
 * "[fetchPowChallenge] TypeError: Network request failed" (seen on the CI
 * emulator). Now: a translated sentence with a Retry button, or the
 * rate-limit wait; the raw error stays in publishError (Home banner, dev log).
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
import { themedAlert } from '../../components/AlertHost';

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


const mockAlert = themedAlert as jest.Mock;

describe('registration failure alert', () => {
  beforeEach(() => {
    for (const k of Object.keys(secureStoreBacking)) delete secureStoreBacking[k];
    for (const k of Object.keys(ssBacking)) delete ssBacking[k];
    mockEnsureRegistered.mockReset();
    mockAlert.mockReset();
    resetStore({ identity: makeIdentity('AEGIS-A'), publishStatus: 'failed', activeSlotId: 'self' });
  });

  it('shows a translated message and a Retry button, never the raw error', async () => {
    const raw = '[fetchPowChallenge] TypeError: Network request failed';
    mockEnsureRegistered.mockResolvedValue({ ok: false, error: raw });

    await useIdentity.getState().retryPublish();

    expect(mockAlert).toHaveBeenCalledTimes(1);
    const [title, message, buttons] = mockAlert.mock.calls[0] as [string, string, Array<{ text: string; onPress?: () => void }>];
    expect(title).toBe('Registration failed');
    expect(message).toBe('Registration failed. Check your connection and retry.');
    expect(`${title} ${message}`).not.toContain('TypeError');
    expect(buttons.map((b) => b.text)).toEqual(['Cancel', 'Retry']);
    // The technical detail is kept for the banner and the logs.
    expect(useIdentity.getState().publishError).toBe(raw);

    // Retry re-runs the registration.
    mockEnsureRegistered.mockResolvedValue({ ok: true });
    buttons[1].onPress?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(mockEnsureRegistered).toHaveBeenCalledTimes(2);
  });

  it('tells the user how long to wait when the relay rate-limits', async () => {
    mockEnsureRegistered.mockResolvedValue({ ok: false, error: 'HTTP 429', retryAfterMs: 5 * 60_000 });

    await useIdentity.getState().retryPublish();

    const [, message, buttons] = mockAlert.mock.calls[0] as [string, string, unknown];
    expect(message).toBe('Too many registration attempts. Automatic retry in 5 min');
    expect(buttons).toBeUndefined();
  });
});
