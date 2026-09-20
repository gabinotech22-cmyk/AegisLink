/**
 * useSyncRefresh — pull-to-refresh is "sync now".
 *
 *  - runs syncNow(identity) and the screen's own reload together, and keeps
 *    `refreshing` up until both settle;
 *  - never lets the spinner outlive SYNC_REFRESH_MAX_MS even if Tor never
 *    answers (the sync itself keeps running in the background);
 *  - is inert without an identity and ignores a second pull mid-flight.
 */
import { renderHook, act } from '@testing-library/react-native';

const mockSyncNow = jest.fn();
jest.mock('../../socket/client', () => ({
  syncNow: (...a: unknown[]) => mockSyncNow(...a),
}));

import { useSyncRefresh, SYNC_REFRESH_MAX_MS } from '../useSyncRefresh';
import type { Identity } from '../../crypto/identity';

const ID = { aegisId: 'me' } as unknown as Identity;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  jest.useFakeTimers();
  mockSyncNow.mockReset();
});
afterEach(() => jest.useRealTimers());

describe('useSyncRefresh', () => {
  it('spins while syncNow + extra run, stops when both settle', async () => {
    const sync = deferred<void>();
    const feed = deferred<void>();
    mockSyncNow.mockReturnValue(sync.promise);
    const extra = jest.fn().mockReturnValue(feed.promise);
    const { result } = renderHook(() => useSyncRefresh(ID, extra));

    expect(result.current.refreshing).toBe(false);
    act(() => result.current.onRefresh());
    expect(result.current.refreshing).toBe(true);
    expect(mockSyncNow).toHaveBeenCalledWith(ID);
    expect(extra).toHaveBeenCalledTimes(1);

    await act(async () => { sync.resolve(); await Promise.resolve(); });
    expect(result.current.refreshing).toBe(true); // feed still pending
    await act(async () => { feed.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.refreshing).toBe(false);
  });

  it('caps the spinner at SYNC_REFRESH_MAX_MS when the sync never answers', async () => {
    mockSyncNow.mockReturnValue(new Promise(() => {})); // Tor never replies
    const { result } = renderHook(() => useSyncRefresh(ID));
    act(() => result.current.onRefresh());
    expect(result.current.refreshing).toBe(true);
    await act(async () => { jest.advanceTimersByTime(SYNC_REFRESH_MAX_MS + 1); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.refreshing).toBe(false);
  });

  it('a failing extra does not break the gesture', async () => {
    mockSyncNow.mockResolvedValue(undefined);
    const extra = jest.fn().mockRejectedValue(new Error('feed_unreachable'));
    const { result } = renderHook(() => useSyncRefresh(ID, extra));
    await act(async () => { result.current.onRefresh(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); });
    expect(result.current.refreshing).toBe(false);
  });

  it('inert without an identity; second pull mid-flight is ignored', () => {
    const { result: noId } = renderHook(() => useSyncRefresh(null));
    act(() => noId.current.onRefresh());
    expect(mockSyncNow).not.toHaveBeenCalled();
    expect(noId.current.refreshing).toBe(false);

    mockSyncNow.mockReturnValue(new Promise(() => {}));
    const { result } = renderHook(() => useSyncRefresh(ID));
    act(() => { result.current.onRefresh(); result.current.onRefresh(); });
    expect(mockSyncNow).toHaveBeenCalledTimes(1);
  });
});
