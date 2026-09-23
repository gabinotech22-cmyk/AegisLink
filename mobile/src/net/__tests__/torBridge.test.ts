/**
 * torBridge — the native socket.io-over-Tor bridge every relay socket rides
 * (Tor always-on: the identity socket to the official onion, the mailbox, a
 * self-hosted home).
 *
 *   - Cold start: while Tor is still bootstrapping, native `sioConnect` rejects
 *     (E_TOR_NOT_READY). The bridge must keep retrying until it succeeds —
 *     before 2026-09-23 a socket created too early stayed dead for the session.
 *   - `disconnect()` retires the bridge: no retry after it.
 *   - Every server → client event the app listens to on the identity socket is
 *     in IDENTITY_FORWARD_EVENTS; native forwards only what is listed (the
 *     public-channel events were missing, so live channel posts never arrived
 *     over the bridge).
 */
import fs from 'fs';
import path from 'path';

const mockNative = {
  start: jest.fn(async () => ({ state: 'on', socksPort: 9050 })),
  getStatus: jest.fn(async () => ({ state: 'on', socksPort: 9050 })),
  stop: jest.fn(async () => true),
  sioConnect: jest.fn(async (..._a: unknown[]) => true),
  sioEmit: jest.fn(async () => true),
  sioDisconnect: jest.fn(async () => true),
  addListener: jest.fn(),
  removeListeners: jest.fn(),
};

jest.mock('react-native', () => ({
  NativeModules: { AegisTor: mockNative },
  NativeEventEmitter: class {
    addListener() { return { remove: () => undefined }; }
  },
}));

// require (not import): must run after mockNative exists — imports are hoisted.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { TorSioSocket, IDENTITY_FORWARD_EVENTS } = require('../tor') as typeof import('../tor');

const ONION = `http://${'o'.repeat(56)}.onion`;

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('TorSioSocket — cold-start dial', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockNative.sioConnect.mockReset();
    mockNative.start.mockClear();
  });
  afterEach(() => { jest.useRealTimers(); });

  it('retries sioConnect with backoff until Tor is ready', async () => {
    mockNative.sioConnect
      .mockRejectedValueOnce(new Error('E_TOR_NOT_READY'))
      .mockRejectedValueOnce(new Error('E_TOR_NOT_READY'))
      .mockResolvedValue(true);
    const sock = new TorSioSocket(ONION, { aegisId: 'X' }, IDENTITY_FORWARD_EVENTS);
    await flush();
    expect(mockNative.sioConnect).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(2_000);
    await flush();
    expect(mockNative.sioConnect).toHaveBeenCalledTimes(2);
    jest.advanceTimersByTime(4_000);
    await flush();
    expect(mockNative.sioConnect).toHaveBeenCalledTimes(3);
    // Succeeded: no further attempts.
    jest.advanceTimersByTime(120_000);
    await flush();
    expect(mockNative.sioConnect).toHaveBeenCalledTimes(3);
    // Waited for Tor before each attempt.
    expect(mockNative.start).toHaveBeenCalled();
    sock.disconnect();
  });

  it('disconnect() stops the retry loop', async () => {
    mockNative.sioConnect.mockRejectedValue(new Error('E_TOR_NOT_READY'));
    const sock = new TorSioSocket(ONION, { aegisId: 'X' }, IDENTITY_FORWARD_EVENTS);
    await flush();
    expect(mockNative.sioConnect).toHaveBeenCalledTimes(1);
    sock.disconnect();
    jest.advanceTimersByTime(300_000);
    await flush();
    expect(mockNative.sioConnect).toHaveBeenCalledTimes(1);
  });

  it('passes the identity event list and string-only auth to native', async () => {
    mockNative.sioConnect.mockResolvedValue(true);
    const sock = new TorSioSocket(ONION, { aegisId: 'X', ackDelivery: true }, IDENTITY_FORWARD_EVENTS);
    await flush();
    const [, url, authJson, eventsJson] = mockNative.sioConnect.mock.calls[0] as [string, string, string, string];
    expect(url).toBe(ONION);
    expect(JSON.parse(authJson)).toEqual({ aegisId: 'X', ackDelivery: 'true' });
    expect(JSON.parse(eventsJson)).toEqual([...IDENTITY_FORWARD_EVENTS]);
    sock.disconnect();
  });
});

describe('IDENTITY_FORWARD_EVENTS covers every event the identity socket listens to', () => {
  const SRC = path.resolve(__dirname, '../..');
  // The mailbox socket and the relay pool have their own event lists.
  const EXCLUDE = [/__tests__/, /net[\\/]tor\.ts$/, /mailboxSocket\.ts$/, /relayPool(Core)?\.ts$/];
  const BUILTIN = new Set(['connect', 'disconnect', 'connect_error']);
  const PATTERNS = [
    /\b(?:socket|sock|s)\??!?\.(?:on|once)\(\s*'([^']+)'/g,
    /\bonCallSignal\(\s*\w+\s*,\s*'([^']+)'/g,
    /\bsubscribe(?:<[^>]*>)?\(\s*'([^']+)'/g,
  ];

  function listened(): Map<string, string> {
    const found = new Map<string, string>();
    const walk = (dir: string): void => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.tsx?$/.test(e.name) || EXCLUDE.some((re) => re.test(p))) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const re of PATTERNS) {
          for (const m of src.matchAll(re)) if (!BUILTIN.has(m[1])) found.set(m[1], path.relative(SRC, p));
        }
      }
    };
    walk(SRC);
    return found;
  }

  it('no listened event is missing from the forward list', () => {
    const fwd = new Set<string>(IDENTITY_FORWARD_EVENTS);
    const missing = [...listened()].filter(([ev]) => !fwd.has(ev)).map(([ev, file]) => `${ev} (${file})`);
    expect(missing).toEqual([]);
  });

  it('includes the public-channel live events', () => {
    expect(IDENTITY_FORWARD_EVENTS).toEqual(
      expect.arrayContaining(['pubchannel:msg', 'pubchannel:ban', 'pubchannel:delete', 'pubchannel:tombstone']),
    );
  });
});
