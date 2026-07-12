/**
 * backgroundReconnect — Slice 2b regression: a background wake-up must also
 * drain the mailbox socket, not just the aegisId relay socket.
 *
 *   1. WAKEUP: connects the mailbox socket alongside the relay socket.
 *   2. DURESS: never connects ANY socket (relay or mailbox) — a duress connect
 *      would leak that panic/decoy mode is active to the relay.
 */

const mockPrefs = { duressActive: false, hydrate: jest.fn(async () => undefined) };
const mockIdentityState: { hydrated: boolean; identity: unknown; hydrate: jest.Mock } = {
  hydrated: true,
  identity: { aegisId: 'self' },
  hydrate: jest.fn(async () => undefined),
};
const mockConnect = jest.fn();
const mockIsConnected = jest.fn(() => false);
const mockConnectMailboxForIdentity = jest.fn();

jest.mock('../../store/preferences', () => ({
  usePreferences: { getState: () => mockPrefs },
}));
jest.mock('../../store/identity', () => ({
  useIdentity: { getState: () => mockIdentityState },
}));
jest.mock('../../socket/client', () => ({
  isConnected: () => mockIsConnected(),
  connect: (id: unknown) => mockConnect(id),
  connectMailboxForIdentity: (id: unknown) => mockConnectMailboxForIdentity(id),
}));
jest.mock('../../runtime', () => ({ WEBRTC_AVAILABLE: false }));
// expo-task-manager is absent in the jest env; the module's define-task IIFE
// swallows that. Nothing to mock for the unit under test.

import { wakeAndReconnect } from '../backgroundReconnect';

beforeEach(() => {
  jest.clearAllMocks();
  mockPrefs.duressActive = false;
  mockIdentityState.hydrated = true;
  mockIdentityState.identity = { aegisId: 'self' };
  mockIsConnected.mockReturnValue(false);
});

describe('wakeAndReconnect', () => {
  it('WAKEUP: connects the relay socket AND drains the mailbox socket', async () => {
    jest.useFakeTimers();
    try {
      const p = wakeAndReconnect();
      await jest.advanceTimersByTimeAsync(12_000);
      await p;

      expect(mockConnect).toHaveBeenCalledWith({ aegisId: 'self' });
      expect(mockConnectMailboxForIdentity).toHaveBeenCalledWith({ aegisId: 'self' });
    } finally {
      jest.useRealTimers();
    }
  });

  it('DURESS: never connects the relay socket nor the mailbox socket', async () => {
    mockPrefs.duressActive = true;

    await wakeAndReconnect();

    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockConnectMailboxForIdentity).not.toHaveBeenCalled();
  });
});
