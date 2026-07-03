/**
 * Scheduled CHANNEL posts — store-level tests (processDue channel branch).
 *
 * Field bug: a channel post scheduled while the app was backgrounded/closed
 * never appeared. Root causes:
 *   1. The foreground runner in App.tsx only fired processDue() on a 10s
 *      setInterval tick — an overdue post waited up to 10s after the app
 *      reopened instead of firing immediately (fixed by an immediate
 *      catch-up call + an AppState 'active' listener in App.tsx).
 *   2. useChannels.subscribed is memory-only and may still be empty this
 *      early in a cold launch / background wake (a race with the app-level
 *      channels rehydrate effect). canScheduleChannelPost(undefined, true)
 *      returns false, which the fire-time check treated as a PERMANENT
 *      failure ("channel gone") even though the channel secrets were fine —
 *      just not hydrated into memory yet. processDue's channel branch now
 *      hydrates (if needed) before trusting an absence.
 *
 * This suite covers: an overdue channel post fires the instant processDue()
 * is invoked (no timer dependency baked into the store itself), and the
 * hydrate-before-permission-check fix.
 */

// ── db/local ─────────────────────────────────────────────────────────────────
const mockLoadPending = jest.fn().mockResolvedValue([]);
const mockMarkSent = jest.fn().mockResolvedValue(undefined);
const mockMarkFailed = jest.fn().mockResolvedValue(undefined);
const mockIncrementRetry = jest.fn().mockResolvedValue(undefined);

jest.mock('../../db/local', () => ({
  __esModule: true,
  saveScheduled: jest.fn().mockResolvedValue(undefined),
  loadPendingScheduled: (...a: unknown[]) => mockLoadPending(...a),
  loadAllScheduled: jest.fn().mockResolvedValue([]),
  markScheduledSent: (...a: unknown[]) => mockMarkSent(...a),
  markScheduledFailed: (...a: unknown[]) => mockMarkFailed(...a),
  incrementScheduledRetry: (...a: unknown[]) => mockIncrementRetry(...a),
  deleteScheduled: jest.fn().mockResolvedValue(undefined),
  encryptBody: jest.fn(async (s: string) => 'enc:' + s),
  decryptBody: jest.fn(async (s: string) => (s.startsWith('enc:') ? s.slice(4) : s)),
}));

// ── socket/client (only used for the online/offline gate check) ─────────────
let mockOnline = true;
jest.mock('../../socket/client', () => ({
  __esModule: true,
  getSocket: () => (mockOnline ? { emit: jest.fn() } : null),
  isConnected: () => mockOnline,
}));

// ── store/identity ───────────────────────────────────────────────────────────
let mockIdentity: { aegisId: string } | null = { aegisId: 'me-1' };
jest.mock('../identity', () => ({
  __esModule: true,
  useIdentity: { getState: () => ({ identity: mockIdentity }) },
}));

// ── store/channels ────────────────────────────────────────────────────────────
const mockSendPost = jest.fn().mockResolvedValue({ ok: true });
const mockHydrateSubscribed = jest.fn().mockResolvedValue(undefined);
let mockChannelsHydrated = true;
let mockSubscribed: Array<{ channelId: string; channelType?: string; owned?: boolean }> = [];
jest.mock('../channels', () => ({
  __esModule: true,
  useChannels: {
    getState: () => ({
      hydrated: mockChannelsHydrated,
      hydrateSubscribed: mockHydrateSubscribed,
      subscribed: mockSubscribed,
      sendPost: (...a: unknown[]) => mockSendPost(...a),
    }),
  },
}));

import { useScheduledMessages, canScheduleChannelPost } from '../scheduledMessages';
import type { StoredScheduledMessage } from '../../db/local';

const CHANNEL_ID = 'chan-1';

function pendingChannelPost(over: Partial<StoredScheduledMessage> = {}): StoredScheduledMessage {
  return {
    id: 'cpost-1',
    recipientAegisId: CHANNEL_ID,
    channelId: CHANNEL_ID,
    encryptedPayload: 'enc:Hola canal',
    postMeta: undefined,
    sendAt: Date.now() - 1000,
    createdAt: 0,
    status: 'pending',
    retryCount: 0,
    ...over,
  } as StoredScheduledMessage;
}

describe('canScheduleChannelPost', () => {
  it('allows any subscriber on open channels, only the owner otherwise, and denies null inputs', () => {
    expect(canScheduleChannelPost({ channelType: 'open', owned: false }, true)).toBe(true);
    expect(canScheduleChannelPost({ channelType: 'moderated', owned: true }, true)).toBe(true);
    expect(canScheduleChannelPost({ channelType: 'moderated', owned: false }, true)).toBe(false);
    expect(canScheduleChannelPost(undefined, true)).toBe(false);
    expect(canScheduleChannelPost({ channelType: 'open' }, false)).toBe(false);
  });
});

describe('scheduled channel posts — fire path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOnline = true;
    mockIdentity = { aegisId: 'me-1' };
    mockChannelsHydrated = true;
    mockSubscribed = [{ channelId: CHANNEL_ID, channelType: 'open', owned: false }];
    useScheduledMessages.setState({ scheduled: [] });
  });

  it('an overdue channel post fires IMMEDIATELY on processDue() — no timer dependency', async () => {
    mockLoadPending.mockResolvedValue([pendingChannelPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendPost).toHaveBeenCalledTimes(1);
    expect(mockSendPost).toHaveBeenCalledWith(CHANNEL_ID, 'Hola canal', mockIdentity, undefined, null);
    expect(mockMarkSent).toHaveBeenCalledWith('cpost-1');
  });

  it('channels not yet hydrated: hydrates before trusting an absent summary (no false permanent failure)', async () => {
    mockChannelsHydrated = false;
    mockSubscribed = []; // race: hydrateSubscribed hasn't populated this yet
    // Simulate hydrateSubscribed() populating `subscribed` once it resolves.
    mockHydrateSubscribed.mockImplementation(async () => {
      mockSubscribed = [{ channelId: CHANNEL_ID, channelType: 'open', owned: false }];
    });
    mockLoadPending.mockResolvedValue([pendingChannelPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockHydrateSubscribed).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockSendPost).toHaveBeenCalledTimes(1);
    expect(mockMarkSent).toHaveBeenCalledWith('cpost-1');
  });

  it('already hydrated with the channel genuinely gone: permanent failure, no hydrate re-attempt', async () => {
    mockChannelsHydrated = true;
    mockSubscribed = []; // genuinely unsubscribed, not a hydration race
    mockLoadPending.mockResolvedValue([pendingChannelPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockHydrateSubscribed).not.toHaveBeenCalled();
    expect(mockSendPost).not.toHaveBeenCalled();
    expect(mockMarkFailed).toHaveBeenCalledWith('cpost-1', 0);
  });

  it('identity locked → skip WITHOUT burning a retry (fires on next run)', async () => {
    mockIdentity = null;
    mockLoadPending.mockResolvedValue([pendingChannelPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockSendPost).not.toHaveBeenCalled();
    expect(mockMarkFailed).not.toHaveBeenCalled();
    expect(mockIncrementRetry).not.toHaveBeenCalled();
  });

  it('sendPost failure burns a retry', async () => {
    mockSendPost.mockResolvedValueOnce({ ok: false, error: 'not_subscribed' });
    mockLoadPending.mockResolvedValue([pendingChannelPost()]);

    await useScheduledMessages.getState().processDue();

    expect(mockIncrementRetry).toHaveBeenCalledWith('cpost-1', 1);
    expect(mockMarkSent).not.toHaveBeenCalled();
  });
});
