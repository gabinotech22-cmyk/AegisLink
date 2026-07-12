/**
 * mailboxPushSubscription — Slice 2b.2: device-side ntfy wake subscription.
 *
 *   1. subscribes over Tor to the ntfy /json stream for topic = current mailbox
 *      id (base64url), on the relay onion at virtual port 8090
 *   2. an ntfy `message` line triggers onWake (drain); `open`/`keepalive` do not
 *   3. stop() tears the subscription down
 *   4. no-op fail-closed when mailbox mode / Tor is unavailable
 */

let mockMailboxEnabled = true;
const mockUnsub = jest.fn();
const mockSubscribe = jest.fn(
  (_url: string, _onLine: (l: string) => void, _onError?: (r: string) => void): (() => void) => mockUnsub,
);
const mockIsTorAvailable = jest.fn(() => true);

jest.mock('../../config', () => ({
  get MAILBOX_ENABLED() { return mockMailboxEnabled; },
  ONION_URL: 'http://abcdef.onion',
}));
jest.mock('../../net/tor', () => ({
  isTorAvailable: () => mockIsTorAvailable(),
  subscribeNtfyOverTor: (url: string, onLine: (l: string) => void, onError?: (r: string) => void) =>
    mockSubscribe(url, onLine, onError),
}));
jest.mock('../../crypto/mailboxStore', () => ({
  getOwnCurrentMailbox: jest.fn(async () => ({ mailboxIdB64: 'a+b/c==' })),
}));

import {
  mailboxTopic,
  startMailboxPushSubscription,
  stopMailboxPushSubscription,
} from '../mailboxPushSubscription';

/** Flush the pending microtasks (resubscribe awaits getOwnCurrentMailbox). */
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  jest.clearAllMocks();
  mockMailboxEnabled = true;
  mockIsTorAvailable.mockReturnValue(true);
});
afterEach(() => {
  stopMailboxPushSubscription();
});

describe('mailboxTopic', () => {
  it('converts standard base64 to unpadded base64url', () => {
    expect(mailboxTopic('a+b/c==')).toBe('a-b_c');
    expect(mailboxTopic('AAAA')).toBe('AAAA');
  });
});

describe('startMailboxPushSubscription', () => {
  it('subscribes to the ntfy stream on the onion at port 8090 for the current topic', async () => {
    startMailboxPushSubscription(jest.fn());
    await flush();

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    const url = mockSubscribe.mock.calls[0]![0];
    expect(url).toBe('http://abcdef.onion:8090/a-b_c/json');
  });

  it('drains on a `message` line but ignores open/keepalive', async () => {
    const onWake = jest.fn();
    startMailboxPushSubscription(onWake);
    await flush();
    const onLine = mockSubscribe.mock.calls[0]![1];

    onLine(JSON.stringify({ event: 'open' }));
    onLine(JSON.stringify({ event: 'keepalive' }));
    expect(onWake).not.toHaveBeenCalled();

    onLine(JSON.stringify({ event: 'message', message: 'triggered' }));
    expect(onWake).toHaveBeenCalledTimes(1);

    onLine('not json');
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it('is a no-op when mailbox mode is disabled', async () => {
    mockMailboxEnabled = false;
    startMailboxPushSubscription(jest.fn());
    await flush();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });

  it('is a no-op when Tor is unavailable (fail-closed)', async () => {
    mockIsTorAvailable.mockReturnValue(false);
    startMailboxPushSubscription(jest.fn());
    await flush();
    expect(mockSubscribe).not.toHaveBeenCalled();
  });
});

describe('stopMailboxPushSubscription', () => {
  it('tears down the active subscription', async () => {
    startMailboxPushSubscription(jest.fn());
    await flush();
    expect(mockSubscribe).toHaveBeenCalledTimes(1);

    stopMailboxPushSubscription();
    expect(mockUnsub).toHaveBeenCalledTimes(1);
  });
});
