/**
 * error_msg handler — peer_offline discrimination by `e.for`
 *
 * Guards the fix for the double bug in the error_msg handler:
 *
 *   1. peer_offline with for='call:invite': the relay could not deliver our
 *      invite (no WebSocket AND no push tokens). Must endCall + Alert.
 *
 *   2. peer_offline with for='call:ice': an ICE candidate the relay couldn't
 *      forward. Non-fatal — WebRTC continues ICE with other candidates. Must
 *      NOT endCall or show an alert.
 *
 * We drive client.ts by calling connect() and then manually firing the
 * 'error_msg' handler registered on the fake socket (same technique used in
 * client.prekeyPersist.test.ts).
 *
 * NOTE: we do NOT call jest.resetModules() here. Doing so after jest.mock()
 * declarations clears the module cache but the mock for '../calls' would be
 * re-instantiated on the next require, creating a new endCall jest.fn() that
 * differs from the one we imported at top-level. Instead we keep one module
 * instance for the whole suite and only clearAllMocks() between tests.
 */

// ── All the heavy modules client.ts touches — minimal stubs ──────────────────

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
  useConnection: { getState: () => ({ setOnline: jest.fn() }) },
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

jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({
      displayName: 'Tester',
      avatarColor: '#000',
      profileStatus: '',
      avatarImage: null,
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
  ONION_URL: '',
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

// ── endCall spy — mock the lazy-required calls module ─────────────────────────
// client.ts does `require('./calls')` inside the handler (lazy require).
// We mock the module and import endCall at the top level so we always hold the
// same jest.fn() reference that the handler will invoke.
jest.mock('../calls', () => ({
  __esModule: true,
  endCall: jest.fn(),
  startCall: jest.fn(),
  attachCallHandlers: jest.fn(),
  hangupActiveCall: jest.fn(),
}));

// ── react-native Alert ────────────────────────────────────────────────────────
jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  AppState: { currentState: 'active', addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Platform: { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default },
  NativeModules: {},
}));

// client.ts imports themedAlert from AlertHost; mock it so the theme/StyleSheet
// chain (AlertHost.tsx runs StyleSheet.create at load) is not pulled in here.
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));

// ── Fake socket.io-client — captures registered handlers ─────────────────────
type AnyFn = (...args: unknown[]) => unknown;

interface FakeSocket {
  handlers: Map<string, AnyFn>;
  on(event: string, cb: AnyFn): FakeSocket;
  off(): FakeSocket;
  emit: jest.Mock;
  disconnect: jest.Mock;
  connect: jest.Mock;
  auth: Record<string, unknown>;
}

let mockFakeSocket: FakeSocket;

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: (_url: string, opts: { auth: Record<string, unknown> }) => {
    mockFakeSocket = {
      handlers: new Map(),
      auth: opts.auth,
      on(event: string, cb: AnyFn) { this.handlers.set(event, cb); return this; },
      off() { return this; },
      emit: jest.fn(),
      disconnect: jest.fn(),
      connect: jest.fn(),
    };
    return mockFakeSocket;
  },
}));

// ── top-level imports (executed AFTER all jest.mock() hoisting) ───────────────
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { themedAlert } from '../../components/AlertHost';
import type { Identity } from '../../crypto/identity';
import { endCall } from '../calls';
import { connect } from '../client';

const mockEndCall = endCall as jest.Mock;
const mockAlert = themedAlert as jest.Mock;

// ── helpers ───────────────────────────────────────────────────────────────────

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
  };
}

/** Connect the socket and return the registered error_msg handler. */
function getErrorMsgHandler(): (e: { code?: string; for?: string }) => Promise<void> {
  connect(buildIdentity());
  const handler = mockFakeSocket.handlers.get('error_msg');
  if (!handler) throw new Error('error_msg handler not registered — check socket mock');
  return handler as (e: { code?: string; for?: string }) => Promise<void>;
}

// ── tests ─────────────────────────────────────────────────────────────────────

describe("error_msg handler — peer_offline discrimination by 'for' field", () => {
  // Get the handler once for the whole suite; it's registered on connect()
  // which we call in beforeAll so we don't spin up a new socket per test.
  let onErrorMsg: (e: { code?: string; for?: string }) => Promise<void>;

  beforeAll(() => {
    onErrorMsg = getErrorMsgHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("peer_offline with for='call:invite' → endCall called + Alert shown", async () => {
    await onErrorMsg({ code: 'peer_offline', for: 'call:invite' });
    await new Promise<void>((r) => setImmediate(r));

    expect(mockEndCall).toHaveBeenCalledTimes(1);
    expect(mockEndCall).toHaveBeenCalledWith('peer_offline');
    expect(mockAlert).toHaveBeenCalledTimes(1);
  });

  it("peer_offline with for='call:ice' → endCall NOT called, no Alert", async () => {
    await onErrorMsg({ code: 'peer_offline', for: 'call:ice' });
    await new Promise<void>((r) => setImmediate(r));

    expect(mockEndCall).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it("peer_offline with for='call:answer' → endCall NOT called, no Alert", async () => {
    await onErrorMsg({ code: 'peer_offline', for: 'call:answer' });
    await new Promise<void>((r) => setImmediate(r));

    expect(mockEndCall).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it("peer_offline with for='call:hangup' → endCall NOT called, no Alert", async () => {
    await onErrorMsg({ code: 'peer_offline', for: 'call:hangup' });
    await new Promise<void>((r) => setImmediate(r));

    expect(mockEndCall).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });

  it('peer_offline with no for field → endCall NOT called, no Alert', async () => {
    await onErrorMsg({ code: 'peer_offline' });
    await new Promise<void>((r) => setImmediate(r));

    expect(mockEndCall).not.toHaveBeenCalled();
    expect(mockAlert).not.toHaveBeenCalled();
  });
});
