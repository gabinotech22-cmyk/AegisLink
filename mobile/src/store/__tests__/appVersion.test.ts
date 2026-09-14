/**
 * The relay advertises latest/min; the client compares LOCALLY. These tests
 * pin the three outcomes and the once-per-version background notification.
 * APP_VERSION is mocked to 1.0.6 so the cases read as real release numbers.
 */
const mockSchedule = jest.fn().mockResolvedValue('id');
let mockAppState = 'background';
const mockSs: Record<string, string> = {};

jest.mock('../../runtime', () => ({ APP_VERSION: '1.0.6' }));
jest.mock('expo-notifications', () => ({
  scheduleNotificationAsync: (...a: unknown[]) => mockSchedule(...a),
}));
jest.mock('../../i18n', () => ({
  tAsync: async (k: string, o?: Record<string, string>) => `${k}:${o?.version ?? ''}`,
}));
jest.mock('../../utils/secureStore', () => ({
  ss: {
    get: jest.fn(async (k: string) => mockSs[k] ?? null),
    set: jest.fn(async (k: string, v: string) => { mockSs[k] = v; }),
    delete: jest.fn(async (k: string) => { delete mockSs[k]; }),
  },
}));
jest.mock('react-native', () => ({
  Platform: { OS: 'ios', select: (o: Record<string, unknown>) => o.ios ?? o.default },
  get AppState() { return { currentState: mockAppState }; },
}));

import { useAppVersion, isUpdateAvailable, isUpdateRequired } from '../appVersion';

const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  mockSchedule.mockClear();
  for (const k of Object.keys(mockSs)) delete mockSs[k];
  mockAppState = 'background';
  useAppVersion.setState({
    latestVersion: null, minVersion: null, dismissedFor: null, notifiedFor: null, hydrated: false,
  });
});

describe('appVersion store — local comparison against the relay advertisement', () => {
  it('no advertisement → nothing to show (default is no gate)', () => {
    useAppVersion.getState().applyAdvertisement(undefined);
    const s = useAppVersion.getState();
    expect(isUpdateAvailable(s)).toBe(false);
    expect(isUpdateRequired(s)).toBe(false);
  });

  it('up to date → no banner, no block', () => {
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.6', minVersion: '1.0.6' });
    const s = useAppVersion.getState();
    expect(isUpdateAvailable(s)).toBe(false);
    expect(isUpdateRequired(s)).toBe(false);
  });

  it('older than latest but not below min → banner only', () => {
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.7', minVersion: '1.0.6' });
    const s = useAppVersion.getState();
    expect(isUpdateAvailable(s)).toBe(true);
    expect(isUpdateRequired(s)).toBe(false);
  });

  it('below min → blocking screen (the emergency brake)', () => {
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.8', minVersion: '1.0.7' });
    expect(isUpdateRequired(useAppVersion.getState())).toBe(true);
  });

  it('dismissing the banner is per version: silent for this one, back for the next', () => {
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.7' });
    useAppVersion.getState().dismissBanner();
    expect(isUpdateAvailable(useAppVersion.getState())).toBe(false);
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.8' });
    expect(isUpdateAvailable(useAppVersion.getState())).toBe(true);
  });

  it('a newer-than-latest install (TestFlight) is never nagged', () => {
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.5', minVersion: '1.0.5' });
    expect(isUpdateAvailable(useAppVersion.getState())).toBe(false);
  });
});

describe('appVersion store — once-per-version background notification', () => {
  it('posts one local notification when outdated in the background, then persists the dedupe flag', async () => {
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.7' });
    await flush(); await flush();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    const content = (mockSchedule.mock.calls[0][0] as { content: { body: string; data: unknown } }).content;
    expect(content.body).toBe('appVersion.notifBody:1.0.7');
    expect(content.data).toEqual({ appUpdate: true });
    expect(useAppVersion.getState().notifiedFor).toBe('1.0.7');
    expect(JSON.parse(mockSs['aegis.appversion.v1'])).toEqual({ notifiedFor: '1.0.7' });
  });

  it('does not repeat for the same version, even across a cold start (hydrates from storage)', async () => {
    mockSs['aegis.appversion.v1'] = JSON.stringify({ notifiedFor: '1.0.7' });
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.7' });
    await flush(); await flush();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('announces again when a NEWER version appears', async () => {
    mockSs['aegis.appversion.v1'] = JSON.stringify({ notifiedFor: '1.0.7' });
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.8' });
    await flush(); await flush();
    expect(mockSchedule).toHaveBeenCalledTimes(1);
    expect(useAppVersion.getState().notifiedFor).toBe('1.0.8');
  });

  it('stays silent in the foreground (the banner is on screen) and leaves the flag unset for a later background wake', async () => {
    mockAppState = 'active';
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.7' });
    await flush(); await flush();
    expect(mockSchedule).not.toHaveBeenCalled();
    expect(useAppVersion.getState().notifiedFor).toBeNull();
  });

  it('never notifies when up to date', async () => {
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.6' });
    await flush(); await flush();
    expect(mockSchedule).not.toHaveBeenCalled();
  });

  it('persists only the version string — no timestamps (zero metadata at rest)', async () => {
    useAppVersion.getState().applyAdvertisement({ latestVersion: '1.0.7' });
    await flush(); await flush();
    expect(Object.keys(JSON.parse(mockSs['aegis.appversion.v1']))).toEqual(['notifiedFor']);
  });
});
