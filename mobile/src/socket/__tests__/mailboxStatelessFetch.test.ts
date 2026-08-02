/**
 * mailboxStatelessFetch.test.ts — stateless mailbox drain over Tor
 * (mailboxSocket.fetchMailboxOverTor).
 *
 * This is the reliability FLOOR for async delivery: it drains the queue with a
 * single request/response over Tor, so a message arrives even when the persistent
 * mailbox socket never comes up (iOS background / cold-start race). Verifies the
 * challenge→sign→fetch→persist→ack flow, the at-least-once ack-on-NEXT-fetch, and
 * fail-soft on every error (never throws, returns 0).
 */

const mockTorHttp = jest.fn() as jest.Mock;
const mockIsTorAvailable = jest.fn(() => true);
const mockStartTor = jest.fn(async () => ({ state: 'on', socksPort: 9050 }));
jest.mock('../../net/tor', () => ({
  __esModule: true,
  isTorAvailable: mockIsTorAvailable,
  startTor: mockStartTor,
  onTorStatus: () => () => {},
  torHttpRequest: mockTorHttp,
  TorSioSocket: class {},
}));

jest.mock('../../config', () => ({
  __esModule: true,
  ONION_URL: 'http://relay.onion',
  MAILBOX_ENABLED: true,
  MAILBOX_IOS_WAKE: false,
}));

const mockOwnMailbox = {
  mailboxIdB64: 'bWFpbGJveC1pZC0wMDAwMDA=',
  signPublicKey: new Uint8Array(32).fill(7),
  signSecretKey: new Uint8Array(64).fill(9),
};
jest.mock('../../crypto/mailboxStore', () => ({
  __esModule: true,
  getOwnCurrentMailbox: jest.fn(async () => mockOwnMailbox),
  getOwnMailboxesForEpochs: jest.fn(async () => []),
  getLastMailboxConnectEpoch: jest.fn(async () => null),
  setLastMailboxConnectEpoch: jest.fn(async () => {}),
}));

jest.mock('../../crypto/mailbox', () => ({
  __esModule: true,
  mailboxAuthProof: jest.fn(() => new Uint8Array(64).fill(3)),
  epochFor: () => 0,
  MAILBOX_EPOCH_MS: 86_400_000,
}));

jest.mock('react-native', () => ({
  __esModule: true,
  AppState: { addEventListener: () => ({ remove: () => {} }), currentState: 'active' },
  Platform: { OS: 'ios' },
}));

// Durable pending-ack store, standing in for the mailbox_pending_acks SQLite
// table. It lives at TEST-FILE scope (not inside the mock factory), so it
// survives jest.isolateModules re-requiring the SUT — i.e. it persists across a
// simulated process restart the way the on-disk table does, while the SUT's
// in-memory Map is wiped. Cleared per test in beforeEach.
const mockAckStore = new Map<string, string[]>();
jest.mock('../../db/mailboxAcks', () => ({
  __esModule: true,
  loadMailboxPendingAcks: jest.fn(async (mailboxId: string) => mockAckStore.get(mailboxId) ?? []),
  saveMailboxPendingAcks: jest.fn(async (mailboxId: string, ackIds: string[]) => {
    if (ackIds.length) mockAckStore.set(mailboxId, [...ackIds]);
    else mockAckStore.delete(mailboxId);
  }),
  deleteMailboxPendingAcks: jest.fn(async (mailboxId: string) => { mockAckStore.delete(mailboxId); }),
}));

import naclUtil from 'tweetnacl-util';
const { encodeBase64 } = naclUtil;

const NONCE_B64 = encodeBase64(new Uint8Array(32).fill(1));

/** Re-require the SUT fresh so its module-level pending-ack map resets per test. */
function loadSut(): typeof import('../mailboxSocket') {
  let mod!: typeof import('../mailboxSocket');
  jest.isolateModules(() => {
    mod = require('../mailboxSocket') as typeof import('../mailboxSocket');
  });
  return mod;
}

/** Default happy-path transport: challenge → nonce, fetch → the given envelopes. */
function wireTransport(envelopes: unknown[]) {
  mockTorHttp.mockImplementation(async (url: string) => {
    if (url.endsWith('/mailbox/challenge')) return { status: 200, body: JSON.stringify({ nonce: NONCE_B64 }) };
    if (url.endsWith('/mailbox/fetch')) return { status: 200, body: JSON.stringify({ envelopes }) };
    return null;
  });
}

const env = (id: string) => ({ id, to: mockOwnMailbox.mailboxIdB64, ciphertext: 'ct', nonce: 'n', epk: 'epk', createdAt: 1 });

beforeEach(() => {
  jest.clearAllMocks();
  mockAckStore.clear();
  mockIsTorAvailable.mockReturnValue(true);
  mockStartTor.mockResolvedValue({ state: 'on', socksPort: 9050 });
});

describe('fetchMailboxOverTor', () => {
  it('drains queued envelopes: challenge → sign → fetch → persist each', async () => {
    const { fetchMailboxOverTor } = loadSut();
    wireTransport([env('m1'), env('m2')]);
    const onEnvelope = jest.fn(async () => {});

    const n = await fetchMailboxOverTor(onEnvelope);

    expect(n).toBe(2);
    expect(onEnvelope).toHaveBeenCalledTimes(2);
    expect((onEnvelope.mock.calls as unknown[][]).map((c) => (c[0] as { id: string }).id)).toEqual(['m1', 'm2']);
    // Two requests: challenge then fetch.
    const urls = mockTorHttp.mock.calls.map((c) => c[0] as string);
    expect(urls).toEqual(['http://relay.onion/mailbox/challenge', 'http://relay.onion/mailbox/fetch']);
    // First fetch carries no ackIds (nothing persisted yet).
    const firstFetchBody = JSON.parse(mockTorHttp.mock.calls[1][2] as string);
    expect(firstFetchBody.ackIds).toBeUndefined();
    expect(firstFetchBody.mailboxId).toBe(mockOwnMailbox.mailboxIdB64);
  });

  it('at-least-once: acks the previously-persisted ids on the NEXT fetch', async () => {
    const { fetchMailboxOverTor } = loadSut();
    wireTransport([env('m1'), env('m2')]);
    const onEnvelope = jest.fn(async () => {});

    await fetchMailboxOverTor(onEnvelope); // persists m1, m2
    await fetchMailboxOverTor(onEnvelope); // should ack m1, m2

    const fetchBodies = mockTorHttp.mock.calls
      .filter((c) => (c[0] as string).endsWith('/mailbox/fetch'))
      .map((c) => JSON.parse(c[2] as string));
    expect(fetchBodies[0].ackIds).toBeUndefined();
    expect(fetchBodies[1].ackIds).toEqual(['m1', 'm2']);
  });

  it('does NOT ack an envelope whose handler threw — it re-drains next time', async () => {
    const { fetchMailboxOverTor } = loadSut();
    wireTransport([env('good'), env('bad')]);
    const onEnvelope = jest.fn(async (e: { id: string }) => {
      if (e.id === 'bad') throw new Error('persist failed');
    });

    const n = await fetchMailboxOverTor(onEnvelope); // only 'good' persists
    expect(n).toBe(1);

    // Next fetch acks only the good one.
    wireTransport([env('bad')]);
    await fetchMailboxOverTor(jest.fn(async () => {}));
    const fetchBodies = mockTorHttp.mock.calls
      .filter((c) => (c[0] as string).endsWith('/mailbox/fetch'))
      .map((c) => JSON.parse(c[2] as string));
    expect(fetchBodies[1].ackIds).toEqual(['good']);
  });

  it('refuses to sign a nonce that is not 32 bytes (no signing oracle)', async () => {
    const { fetchMailboxOverTor } = loadSut();
    const shortNonce = encodeBase64(new Uint8Array(16).fill(2)); // relay-chosen, wrong size
    mockTorHttp.mockImplementation(async (url: string) => {
      if (url.endsWith('/mailbox/challenge')) return { status: 200, body: JSON.stringify({ nonce: shortNonce }) };
      if (url.endsWith('/mailbox/fetch')) return { status: 200, body: '{"envelopes":[]}' };
      return null;
    });
    const { mailboxAuthProof } = require('../../crypto/mailbox') as { mailboxAuthProof: jest.Mock };
    const onEnvelope = jest.fn();

    const n = await fetchMailboxOverTor(onEnvelope);

    expect(n).toBe(0);
    // The mailbox signing key never signed relay-chosen bytes …
    expect(mailboxAuthProof).not.toHaveBeenCalled();
    // … and we never reached the fetch step.
    expect(mockTorHttp.mock.calls.some((c) => (c[0] as string).endsWith('/mailbox/fetch'))).toBe(false);
  });

  it('single-flight: overlapping calls coalesce onto one in-flight drain', async () => {
    const { fetchMailboxOverTor } = loadSut();
    // Hold the challenge response open so the first drain is still in flight
    // when the second call arrives.
    let releaseChallenge!: (v: { status: number; body: string }) => void;
    const challengeGate = new Promise<{ status: number; body: string }>((resolve) => {
      releaseChallenge = resolve;
    });
    mockTorHttp.mockImplementation(async (url: string) => {
      if (url.endsWith('/mailbox/challenge')) return challengeGate;
      if (url.endsWith('/mailbox/fetch')) return { status: 200, body: JSON.stringify({ envelopes: [env('m1')] }) };
      return null;
    });
    const onEnvelope = jest.fn(async () => {});

    const p1 = fetchMailboxOverTor(onEnvelope);
    const p2 = fetchMailboxOverTor(onEnvelope); // must join p1, not start a second drain
    releaseChallenge({ status: 200, body: JSON.stringify({ nonce: NONCE_B64 }) });
    const [n1, n2] = await Promise.all([p1, p2]);

    expect(n1).toBe(1);
    expect(n2).toBe(1);
    // Exactly one challenge and one fetch happened for the two overlapping calls.
    const urls = mockTorHttp.mock.calls.map((c) => c[0] as string);
    expect(urls.filter((u) => u.endsWith('/mailbox/challenge'))).toHaveLength(1);
    expect(urls.filter((u) => u.endsWith('/mailbox/fetch'))).toHaveLength(1);
    // The envelope was persisted only once.
    expect(onEnvelope).toHaveBeenCalledTimes(1);
  });

  it('returns 0 without touching the network when Tor is unavailable', async () => {
    mockIsTorAvailable.mockReturnValue(false);
    const { fetchMailboxOverTor } = loadSut();
    const onEnvelope = jest.fn();
    const n = await fetchMailboxOverTor(onEnvelope);
    expect(n).toBe(0);
    expect(mockTorHttp).not.toHaveBeenCalled();
    expect(onEnvelope).not.toHaveBeenCalled();
  });

  it('fails soft (0, no persist) when the challenge request errors', async () => {
    const { fetchMailboxOverTor } = loadSut();
    mockTorHttp.mockImplementation(async (url: string) =>
      url.endsWith('/mailbox/challenge') ? { status: 503, body: '' } : { status: 200, body: '{"envelopes":[]}' },
    );
    const onEnvelope = jest.fn();
    const n = await fetchMailboxOverTor(onEnvelope);
    expect(n).toBe(0);
    expect(onEnvelope).not.toHaveBeenCalled();
    // Never reached the fetch step.
    expect(mockTorHttp.mock.calls.some((c) => (c[0] as string).endsWith('/mailbox/fetch'))).toBe(false);
  });

  it('durably carries acks across a process restart (iOS app-kill between persist and next fetch)', async () => {
    // Round 1 — the app drains and persists m1, m2. The at-least-once ack is
    // deferred to the NEXT fetch, so those ids now live ONLY in the pending-ack
    // store (durable) — the in-memory Map goes down with the process.
    {
      const { fetchMailboxOverTor } = loadSut();
      wireTransport([env('m1'), env('m2')]);
      const n = await fetchMailboxOverTor(jest.fn(async () => {}));
      expect(n).toBe(2);
    }

    // iOS kills the backgrounded app: reload the SUT so its module-level
    // statelessPendingAcks Map is wiped, exactly as after process death. The
    // durable mockAckStore (standing in for the SQLite table) survives.
    {
      const { fetchMailboxOverTor } = loadSut();
      wireTransport([]); // nothing new queued this wake
      await fetchMailboxOverTor(jest.fn(async () => {}));
    }

    // The post-restart fetch STILL carries the acks persisted before the kill —
    // so the relay finally deletes those rows instead of redelivering forever.
    const fetchBodies = mockTorHttp.mock.calls
      .filter((c) => (c[0] as string).endsWith('/mailbox/fetch'))
      .map((c) => JSON.parse(c[2] as string));
    expect(fetchBodies[0].ackIds).toBeUndefined();          // round 1: nothing to ack yet
    expect(fetchBodies[fetchBodies.length - 1].ackIds).toEqual(['m1', 'm2']); // post-restart
    // And once honored (200), the durable entry is cleared — no perpetual re-ack.
    expect(mockAckStore.has(mockOwnMailbox.mailboxIdB64)).toBe(false);
  });
});
