/**
 * Scheduled Channel Posts — store-level tests.
 *
 * Verifies: scheduleChannelPost persists; processDue fires when permission OK
 * and calls sendPost; processDue does NOT fire when permission lost.
 */

// ─── Mocks (must come before imports) ────────────────────────────────────────

jest.mock('../components/AlertHost', () => ({ themedAlert: jest.fn() }));

const mockSaveScheduled = jest.fn().mockResolvedValue(undefined);
const mockLoadAllScheduled = jest.fn().mockResolvedValue([]);
const mockLoadPendingScheduled = jest.fn().mockResolvedValue([]);
const mockMarkScheduledSent = jest.fn().mockResolvedValue(undefined);
const mockMarkScheduledFailed = jest.fn().mockResolvedValue(undefined);
const mockIncrementScheduledRetry = jest.fn().mockResolvedValue(undefined);
const mockDeleteScheduled = jest.fn().mockResolvedValue(undefined);
const mockEncryptBody = jest.fn((text: string) => `enc:${text}`);
const mockDecryptBody = jest.fn((text: string) => text.replace(/^enc:/, ''));

jest.mock('../db/local', () => ({
  saveScheduled: (a: unknown) => mockSaveScheduled(a),
  loadAllScheduled: () => mockLoadAllScheduled(),
  loadPendingScheduled: () => mockLoadPendingScheduled(),
  markScheduledSent: (a: unknown) => mockMarkScheduledSent(a),
  markScheduledFailed: (a: unknown, b: unknown) => mockMarkScheduledFailed(a, b),
  incrementScheduledRetry: (a: unknown, b: unknown) => mockIncrementScheduledRetry(a, b),
  deleteScheduled: (a: unknown) => mockDeleteScheduled(a),
  encryptBody: (a: unknown) => mockEncryptBody(a as string),
  decryptBody: (a: unknown) => mockDecryptBody(a as string),
}));

jest.mock('expo-crypto', () => ({
  randomUUID: () => 'test-uuid-1234',
}));

const mockSendPost = jest.fn().mockResolvedValue({ ok: true });

jest.mock('../store/channels', () => ({
  useChannels: {
    getState: () => ({
      hydrated: true,
      hydrateSubscribed: jest.fn().mockResolvedValue(undefined),
      subscribed: [
        { channelId: 'ch-1', channelType: 'open', owned: false },
        { channelId: 'ch-owned', channelType: 'readonly', owned: true },
      ],
      sendPost: mockSendPost,
    }),
  },
}));

jest.mock('../store/identity', () => ({
  useIdentity: {
    getState: () => ({
      identity: { aegisId: 'me-123', signingPublicKey: new Uint8Array(32), signingSecretKey: new Uint8Array(64) },
    }),
  },
}));

jest.mock('../socket/client', () => ({
  getSocket: () => null,
  isConnected: () => false,
}));

jest.mock('../store/contacts', () => ({
  useContacts: {
    getState: () => ({ contacts: [] }),
  },
}));

// ─── Tests ───────────────────────────────────────────────────────────────────

import { act } from '@testing-library/react-native';
import {
  useScheduledMessages,
  canScheduleChannelPost,
} from '../store/scheduledMessages';

beforeEach(() => {
  jest.clearAllMocks();
  act(() => {
    useScheduledMessages.setState({ scheduled: [] });
  });
});

describe('canScheduleChannelPost', () => {
  it('returns true for open channels with identity', () => {
    expect(canScheduleChannelPost({ channelType: 'open', owned: false }, true)).toBe(true);
  });

  it('returns true for owned readonly channels', () => {
    expect(canScheduleChannelPost({ channelType: 'readonly', owned: true }, true)).toBe(true);
  });

  it('returns false for non-owned readonly channels', () => {
    expect(canScheduleChannelPost({ channelType: 'readonly', owned: false }, true)).toBe(false);
  });

  it('returns false without identity', () => {
    expect(canScheduleChannelPost({ channelType: 'open', owned: false }, false)).toBe(false);
  });

  it('returns false for null summary', () => {
    expect(canScheduleChannelPost(null, true)).toBe(false);
  });
});

describe('scheduleChannelPost', () => {
  it('persists a channel post via saveScheduled with channelId', async () => {
    await act(async () => {
      await useScheduledMessages.getState().scheduleChannelPost({
        channelId: 'ch-1',
        body: 'Hello channel',
        sendAt: Date.now() + 60000,
      });
    });

    expect(mockSaveScheduled).toHaveBeenCalledTimes(1);
    const saved = mockSaveScheduled.mock.calls[0][0];
    expect(saved.channelId).toBe('ch-1');
    expect(saved.recipientAegisId).toBe('ch-1');
    expect(saved.encryptedPayload).toBe('enc:Hello channel');
    expect(saved.status).toBe('pending');

    // Also in Zustand state
    const state = useScheduledMessages.getState();
    expect(state.scheduled).toHaveLength(1);
    expect(state.scheduled[0].channelId).toBe('ch-1');
  });
});

describe('processDue — channel post', () => {
  it('fires sendPost when permission OK and time elapsed', async () => {
    const pastTime = Date.now() - 5000;
    mockLoadPendingScheduled.mockResolvedValueOnce([{
      id: 'sched-1',
      recipientAegisId: 'ch-1',
      channelId: 'ch-1',
      encryptedPayload: 'enc:Scheduled text',
      sendAt: pastTime,
      createdAt: pastTime - 60000,
      status: 'pending',
      retryCount: 0,
    }]);

    await act(async () => {
      await useScheduledMessages.getState().processDue();
    });

    expect(mockDecryptBody).toHaveBeenCalledWith('enc:Scheduled text');
    // senderName is undefined and media null for a plain text-only scheduled post.
    expect(mockSendPost).toHaveBeenCalledWith('ch-1', 'Scheduled text', expect.objectContaining({ aegisId: 'me-123' }), undefined, null);
    expect(mockMarkScheduledSent).toHaveBeenCalledWith('sched-1');
  });

  it('does NOT fire when channel is no longer subscribed', async () => {
    const pastTime = Date.now() - 5000;
    // channelId 'ch-gone' is not in the subscribed list
    mockLoadPendingScheduled.mockResolvedValueOnce([{
      id: 'sched-2',
      recipientAegisId: 'ch-gone',
      channelId: 'ch-gone',
      encryptedPayload: 'enc:Lost post',
      sendAt: pastTime,
      createdAt: pastTime - 60000,
      status: 'pending',
      retryCount: 0,
    }]);

    await act(async () => {
      await useScheduledMessages.getState().processDue();
    });

    expect(mockSendPost).not.toHaveBeenCalled();
    expect(mockMarkScheduledFailed).toHaveBeenCalledWith('sched-2', 0);
  });
});
