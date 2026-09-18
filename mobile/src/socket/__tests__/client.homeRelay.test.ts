/**
 * Federation F5 — the identity socket on a SELF-HOSTED home relay.
 *
 * A custom home is .onion-only, so `connect()` must build the identity socket
 * on the native Tor bridge (TorSioSocket with the full identity event list)
 * at `http://<onion>` — never socket.io-client at a clearnet URL, never the
 * official relay "instead" — and fail closed without Tor. With the official
 * home nothing changes (socket.io-client at SERVER_URL).
 */

jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => ({ contacts: [] }),
    setState: () => undefined,
    subscribe: jest.fn(() => () => undefined),
  },
}));

jest.mock('../../store/connection', () => ({
  __esModule: true,
  useConnection: { getState: () => ({ setOnline: mockSetOnline }) },
}));

jest.mock('../../store/messages', () => ({
  __esModule: true,
  useMessages: {
    getState: () => ({
      byChat: {},
      append: jest.fn(async () => undefined),
      updateDelivery: jest.fn(async () => undefined),
      remoteDelete: jest.fn(async () => undefined),
    }),
  },
}));

// mockIdentityState is mutable per-test (Babel hoisting allows "mock"-prefixed
// vars to be referenced inside jest.mock factories).
let mockIdentityState: {
  publishStatus: 'unknown' | 'publishing' | 'published' | 'failed';
  publishError: string | null;
};
const mockRetryPublish = jest.fn();

jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({
      displayName: 'Tester',
      avatarColor: '#000',
      profileStatus: '',
      avatarImage: null,
      get publishStatus() { return mockIdentityState.publishStatus; },
      get publishError() { return mockIdentityState.publishError; },
      retryPublish: mockRetryPublish,
    }),
  },
}));

jest.mock('../../store/preferences', () => ({
  __esModule: true,
  usePreferences: { getState: () => ({ routeViaTor: false }) },
}));

jest.mock('../../runtime', () => ({ __esModule: true, IS_EXPO_GO: true }));

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock('expo-crypto', () => ({
  __esModule: true,
  randomUUID: () => '00000000-0000-0000-0000-000000000000',
}));

jest.mock('../../config', () => ({
  __esModule: true,
  SERVER_URL: 'http://localhost',
  ONION_URL: null,
  FEDERATION: true,
}));

// ── Federation seams: the home-relay setting and the native Tor bridge ───────
const mockHome: { onion: string | null } = { onion: null };
jest.mock('../../net/homeRelay', () => {
  const real = jest.requireActual('../../net/homeRelay') as typeof import('../../net/homeRelay');
  return {
    __esModule: true,
    ...real,
    getHomeRelay: () => (mockHome.onion ? { onion: mockHome.onion } : null),
    isCustomHome: () => mockHome.onion !== null,
    homeRelayOnionUrl: () => (mockHome.onion ? `http://${mockHome.onion}` : null),
    homeRelayBaseUrl: () => (mockHome.onion ? `http://${mockHome.onion}` : 'http://localhost'),
  };
});
const mockTorSockets: Array<{ url: string; auth: Record<string, unknown>; events: readonly string[] }> = [];
const mockTor = { available: true };
jest.mock('../../net/tor', () => ({
  __esModule: true,
  isTorAvailable: () => mockTor.available,
  startTor: jest.fn(async () => ({ state: 'on' })),
  onTorStatus: () => () => undefined,
  torHttpRequest: jest.fn(async () => null),
  IDENTITY_FORWARD_EVENTS: ['auth:challenge', 'auth:ok', 'envelope', 'envelope:v2'],
  TorSioSocket: class {
    handlers = new Map<string, (...a: unknown[]) => void>();
    connected = false;
    auth: Record<string, unknown>;
    constructor(url: string, auth: Record<string, unknown>, events: readonly string[]) {
      this.auth = auth;
      mockTorSockets.push({ url, auth, events });
    }
    on(e: string, cb: (...a: unknown[]) => void) { this.handlers.set(e, cb); return this; }
    off() { return this; }
    emit() { return this; }
    timeout() { return { emit: () => undefined }; }
    connect() { return this; }
    disconnect() { return this; }
    removeAllListeners() { return this; }
  },
}));
jest.mock('../mailboxSocket', () => ({
  __esModule: true,
  connectMailboxSocket: jest.fn(),
  disconnectMailboxSocket: jest.fn(),
  sendViaMailbox: jest.fn(async () => null),
  isMailboxAuthed: () => false,
  mailboxAckConfirmsDelivery: () => false,
  drainMailboxStateless: jest.fn(async () => 0),
}));

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async () => null),
  saveRatchetSession: jest.fn(async () => undefined),
  enqueueOutboxJob: jest.fn(async () => undefined),
  loadOutboxJobs: jest.fn(async () => []),
  deleteOutboxJob: jest.fn(async () => undefined),
  incrementOutboxAttempts: jest.fn(async () => undefined),
  saveSpkSecret: jest.fn(async () => undefined),
  loadSpkSecret: jest.fn(async () => null),
  loadLatestSpkSecret: jest.fn(async () => null),
  deleteSpkSecret: jest.fn(async () => undefined),
  saveOpkSecret: jest.fn(async () => undefined),
  loadOpkSecret: jest.fn(async () => null),
  deleteOpkSecret: jest.fn(async () => undefined),
  setSpkKeyId: jest.fn(async () => undefined),
  getSpkKeyId: jest.fn(async () => null),
  getActiveDbSlot: () => 'self',
}));

jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: jest.fn(async () => ({
    aegisId: '',
    publicKey: '',
    signingPublicKey: '',
    createdAt: 0,
  })),
  ApiError: class ApiError extends Error {},
}));

jest.mock('../calls', () => ({
  __esModule: true,
  endCall: jest.fn(),
  startCall: jest.fn(),
  attachCallHandlers: jest.fn(),
  hangupActiveCall: jest.fn(),
}));

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Platform: { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default },
  NativeModules: {},
}));

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));

const mockSetOnline = jest.fn();

// ── Fake socket.io-client — captures registered handlers ─────────────────────
type AnyFn = (...args: unknown[]) => unknown;

interface FakeSocket {
  handlers: Map<string, AnyFn>;
  on(event: string, cb: AnyFn): FakeSocket;
  off(): FakeSocket;
  emit: jest.Mock;
  disconnect: jest.Mock;
  connect: jest.Mock;
  timeout: (ms: number) => { emit: (event: string, payload: unknown, cb: (err: Error | null, ack?: unknown) => void) => void };
  auth: Record<string, unknown>;
}

let mockFakeSocket: FakeSocket;

const mockIoCalls: string[] = [];
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: (url: string, opts: { auth: Record<string, unknown> }) => {
    mockIoCalls.push(url);
    mockFakeSocket = {
      handlers: new Map(),
      auth: opts.auth,
      on(event: string, cb: AnyFn) { this.handlers.set(event, cb); return this; },
      off() { return this; },
      emit: jest.fn(),
      disconnect: jest.fn(),
      connect: jest.fn(),
      timeout(ms: number) {
        void ms;
        return {
          emit: (event: string, payload: unknown, cb: (err: Error | null, ack?: unknown) => void) => {
            this.emit(event, payload, (ack: unknown) => cb(null, ack));
          },
        };
      },
    };
    return mockFakeSocket;
  },
}));


import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import type { Identity } from '../../crypto/identity';

const MINE = 'm'.repeat(56) + '.onion';

function buildIdentity(): Identity {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return {
    aegisId: 'AEGIS' + encodeBase64(box.publicKey).slice(0, 6),
    publicKey: box.publicKey,
    secretKey: box.secretKey,
    publicKeyB64: encodeBase64(box.publicKey),
    secretKeyB64: encodeBase64(box.secretKey),
    signingPublicKey: sign.publicKey,
    signingSecretKey: sign.secretKey,
    signingPublicKeyB64: encodeBase64(sign.publicKey),
    signingSecretKeyB64: encodeBase64(sign.secretKey),
    createdAt: Date.now(),
  } as Identity;
}

describe('federation F5 — identity socket on a self-hosted home', () => {
  let client: typeof import('../client');
  beforeEach(() => {
    jest.resetModules();
    mockIdentityState = { publishStatus: 'published', publishError: null };
    mockHome.onion = null;
    mockTor.available = true;
    mockTorSockets.length = 0;
    mockIoCalls.length = 0;
    client = require('../client') as typeof import('../client');
  });
  afterEach(() => { client.disconnect(); });

  it('official home: socket.io-client at SERVER_URL, no Tor bridge (as before F5)', () => {
    client.connect(buildIdentity());
    expect(mockIoCalls).toEqual(['http://localhost']);
    expect(mockTorSockets).toHaveLength(0);
  });

  it('self-hosted home: the Tor bridge at http://<onion> with the identity event list and the same auth; socket.io-client never', () => {
    mockHome.onion = MINE;
    const me = buildIdentity();
    const sock = client.connect(me);
    expect(mockIoCalls).toEqual([]);
    expect(mockTorSockets).toHaveLength(1);
    expect(mockTorSockets[0].url).toBe(`http://${MINE}`);
    expect(mockTorSockets[0].auth).toEqual({ aegisId: me.aegisId, platform: 'mobile', ackDelivery: true });
    expect(mockTorSockets[0].events).toEqual(expect.arrayContaining(['auth:challenge', 'auth:ok', 'envelope', 'envelope:v2']));
    // The relay handlers were wired on the bridge like on any socket.
    const handlers = (sock as unknown as { handlers: Map<string, unknown> }).handlers;
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(['connect', 'auth:challenge', 'auth:ok', 'envelope', 'envelope:v2', 'disconnect']));
    expect(client.getSocket()).toBe(sock);
  });

  it('self-hosted home without the embedded Tor fails closed — no socket at all', () => {
    mockHome.onion = MINE;
    mockTor.available = false;
    expect(() => client.connect(buildIdentity())).toThrow(/Tor/);
    expect(mockIoCalls).toEqual([]);
    expect(mockTorSockets).toHaveLength(0);
  });
});
