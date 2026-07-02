/**
 * channelBackgroundSync — leak-free channel "push" via device-scheduled pull.
 *
 * Verifies the security-sensitive orchestration of runChannelBackgroundSync:
 *   1. DURESS: with the panic/decoy identity active it returns early and NEVER
 *      touches the network (no socket connect, no channel sync) — a duress
 *      connect would leak that panic mode is on.
 *   2. HAPPY PATH: hydrates identity, connects the socket, waits for it, then
 *      delta-pulls subscribed channels and returns the fresh-post count.
 *   3. NO IDENTITY: returns 0 without connecting.
 */

const mockPrefs = { duressActive: false, hydrate: jest.fn(async () => undefined) };
const mockIdentityState: { hydrated: boolean; identity: unknown; hydrate: jest.Mock } = {
  hydrated: true,
  identity: { aegisId: 'self' },
  hydrate: jest.fn(async () => undefined),
};
const mockConnect = jest.fn();
const mockIsConnected = jest.fn(() => true);
const mockSyncSubscribed = jest.fn(async () => 3);

jest.mock('../../store/preferences', () => ({
  usePreferences: { getState: () => mockPrefs },
}));
jest.mock('../../store/identity', () => ({
  useIdentity: { getState: () => mockIdentityState },
}));
jest.mock('../../socket/client', () => ({
  isConnected: () => mockIsConnected(),
  connect: (id: unknown) => mockConnect(id),
}));
jest.mock('../../store/channels', () => ({
  useChannels: { getState: () => ({ syncSubscribedForBackground: mockSyncSubscribed }) },
}));
// expo-task-manager / expo-background-fetch are absent in the jest env; the
// module's define-task IIFE swallows that. Nothing to mock for the unit under test.

import { runChannelBackgroundSync } from '../channelBackgroundSync';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrefs.duressActive = false;
  mockIdentityState.hydrated = true;
  mockIdentityState.identity = { aegisId: 'self' };
  mockIsConnected.mockReturnValue(true);
  mockSyncSubscribed.mockResolvedValue(3);
});

describe('runChannelBackgroundSync', () => {
  it('DURESS: returns 0 and never connects the socket', async () => {
    mockPrefs.duressActive = true;

    const fresh = await runChannelBackgroundSync();

    expect(fresh).toBe(0);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockSyncSubscribed).not.toHaveBeenCalled();
  });

  it('returns 0 and never connects when there is no identity', async () => {
    mockIdentityState.identity = null;

    const fresh = await runChannelBackgroundSync();

    expect(fresh).toBe(0);
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockSyncSubscribed).not.toHaveBeenCalled();
  });

  it('connects and delta-pulls subscribed channels, returning the fresh count', async () => {
    jest.useFakeTimers();
    try {
      mockIsConnected.mockReturnValueOnce(false); // force a connect on entry
      const p = runChannelBackgroundSync();
      // Flush the awaited hydrate microtasks + the post-sync HOLD_MS timer.
      await jest.advanceTimersByTimeAsync(11_000);
      const fresh = await p;

      expect(mockConnect).toHaveBeenCalledWith({ aegisId: 'self' });
      expect(mockSyncSubscribed).toHaveBeenCalledWith({ aegisId: 'self' });
      expect(fresh).toBe(3);
    } finally {
      jest.useRealTimers();
    }
  });
});
