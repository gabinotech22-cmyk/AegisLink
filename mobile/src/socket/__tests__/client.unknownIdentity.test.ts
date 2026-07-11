/**
 * error_msg 'unknown_identity' handler — de-duplicated re-registration
 *
 * Guards the fix for the 2026-07 iPhone registration race: this handler used
 * to call `ensureRegistered(identity)` directly, in parallel with any publish
 * already in flight from store/identity.ts's generate()/hydrate() (`void
 * runPublish(...)`). That meant TWO concurrent PoW/registration attempts —
 * doubling PoW mining work and doubling hits against the relay's per-IP
 * registration rate limit.
 *
 * The fix: the handler now goes through useIdentity.getState().retryPublish()
 * exclusively, which no-ops when a publish is already 'publishing' (or
 * already 'published'). This test drives client.ts by connecting and firing
 * the registered 'error_msg' handler, asserting retryPublish() is called
 * exactly once and that a direct ensureRegistered() is never reachable from
 * this path (module is not even mocked/imported by client.ts anymore for
 * this handler).
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
import { connect } from '../client';

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

function getErrorMsgHandler(): (e: { code?: string; for?: string }) => Promise<void> {
  connect(buildIdentity());
  const handler = mockFakeSocket.handlers.get('error_msg');
  if (!handler) throw new Error('error_msg handler not registered — check socket mock');
  return handler as (e: { code?: string; for?: string }) => Promise<void>;
}

describe("error_msg handler — 'unknown_identity' de-duplicated re-registration", () => {
  let onErrorMsg: (e: { code?: string; for?: string }) => Promise<void>;

  beforeAll(() => {
    onErrorMsg = getErrorMsgHandler();
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockIdentityState = { publishStatus: 'failed', publishError: null };
  });

  it('a resolved (non-in-flight) publishStatus calls retryPublish(true) exactly once, then reconnects on success', async () => {
    mockRetryPublish.mockImplementationOnce(async () => {
      mockIdentityState = { publishStatus: 'published', publishError: null };
    });

    await onErrorMsg({ code: 'unknown_identity' });

    expect(mockRetryPublish).toHaveBeenCalledTimes(1);
    expect(mockRetryPublish).toHaveBeenCalledWith(true);
    expect(mockFakeSocket.connect).toHaveBeenCalledTimes(1);
    expect(mockSetOnline).not.toHaveBeenCalled();
  });

  it('does NOT bypass retryPublish with a second concurrent registration attempt when a publish is already in flight', async () => {
    // Simulate: a publish is ALREADY 'publishing' (e.g. generate()/hydrate()
    // fired one moments ago). retryPublish() itself no-ops in that case (its
    // own internal 'publishing' guard is ALWAYS active — force never bypasses
    // it, see store/identity.ts), but the important regression assertion
    // here is that this handler calls retryPublish() and ONLY retryPublish()
    // — never a second, independent registration path — regardless of the
    // in-flight state.
    mockIdentityState = { publishStatus: 'publishing', publishError: null };
    mockRetryPublish.mockImplementationOnce(async () => {
      // retryPublish's own guard means publishStatus stays 'publishing' —
      // the in-flight attempt elsewhere owns the transition.
    });

    await onErrorMsg({ code: 'unknown_identity' });

    expect(mockRetryPublish).toHaveBeenCalledTimes(1);
    expect(mockRetryPublish).toHaveBeenCalledWith(true);
    // No reconnect attempt yet — the in-flight publish will resolve this,
    // and App.tsx's shouldConnectSocket-gated effect reconnects once it does.
    expect(mockFakeSocket.connect).not.toHaveBeenCalled();
    expect(mockSetOnline).not.toHaveBeenCalled();
  });

  it('forces a republish when publishStatus is a STALE "published" marker (relay forgot us) — retryPublish(true) actually republishes instead of no-op\'ing, then reconnects exactly once', async () => {
    // Reproduces the exact infinite-loop bug this fix closes: hydrate()
    // restored publishStatus: 'published' from the persisted
    // `aegis.published.<slot>` flag, but the relay has genuinely forgotten
    // us (unknown_identity). Without `force`, retryPublish()'s own
    // `publishStatus === 'published'` early-return would no-op here, the
    // handler would reconnect anyway below, and the relay would reject again
    // — unknown_identity <-> reconnect forever.
    mockIdentityState = { publishStatus: 'published', publishError: null };
    mockRetryPublish.mockImplementationOnce(async (force?: boolean) => {
      // The regression assertion: the handler MUST pass force=true, or a
      // real (non-mocked) retryPublish would no-op on the stale 'published'
      // status instead of actually republishing.
      expect(force).toBe(true);
      mockIdentityState = { publishStatus: 'published', publishError: null };
    });

    await onErrorMsg({ code: 'unknown_identity' });

    expect(mockRetryPublish).toHaveBeenCalledTimes(1);
    expect(mockRetryPublish).toHaveBeenCalledWith(true);
    expect(mockFakeSocket.connect).toHaveBeenCalledTimes(1);
    expect(mockSetOnline).not.toHaveBeenCalled();
  });

  it('a genuine registration failure marks offline without retrying a second time', async () => {
    mockRetryPublish.mockImplementationOnce(async () => {
      mockIdentityState = { publishStatus: 'failed', publishError: 'boom' };
    });

    await onErrorMsg({ code: 'unknown_identity' });

    expect(mockRetryPublish).toHaveBeenCalledTimes(1);
    expect(mockRetryPublish).toHaveBeenCalledWith(true);
    expect(mockSetOnline).toHaveBeenCalledWith(false);
    expect(mockFakeSocket.connect).not.toHaveBeenCalled();
  });
});
