/**
 * Root-cause regression test for the "messages don't arrive / X3DH no-spk" bug.
 *
 * The bug: SPK/OPK private prekeys were written ONLY to SecureStore (Android
 * Keystore). On some emulators a bulk Keystore write silently failed, yet the
 * PUBLIC SPK was published anyway → the recipient fetched a bundle whose secret
 * we could not read → permanent X3DH abort ("ABORT no-spk").
 *
 * The fix persists prekey secrets to the durable, encrypted-at-rest SQLite DB as
 * the PRIMARY store, reads the SPK secret back after writing, and refuses to emit
 * `prekeys:upload` if the SPK secret cannot be persisted. These tests verify both
 * halves of that invariant with an in-memory DB mock — no real SQLite, no real
 * SecureStore, no network. No private key material is asserted on in logs.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

// ── In-memory mock of the db/local prekey store ──────────────────────────────
// `mockDbSpk` maps keyId -> base64 secret; `mockDbOpk` maps keyId -> base64 secret.
// `mockFailSpkWrite` simulates a durable-store write failure (the conditions under
// which we MUST NOT publish the public SPK).
const mockDbSpk = new Map<number, string>();
const mockDbOpk = new Map<number, string>();
let mockDbSpkKeyId: number | null = null;
let mockFailSpkWrite = false;

const mockRatchetSessions = new Map<string, string>();

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async (aegisId: string) => mockRatchetSessions.get(aegisId) ?? null),
  saveRatchetSession: jest.fn(async (aegisId: string, json: string) => {
    mockRatchetSessions.set(aegisId, json);
  }),
  saveContact: jest.fn(async () => undefined),
  getActiveDbSlot: () => 'self',
  loadOutboxJobs: jest.fn(async () => []),
  enqueueOutboxJob: jest.fn(async () => undefined),
  deleteOutboxJob: jest.fn(async () => undefined),
  incrementOutboxAttempts: jest.fn(async () => undefined),
  // Prekey-secret durable store
  saveSpkSecret: jest.fn(async (keyId: number, b64: string) => {
    if (mockFailSpkWrite) return; // simulate silent durable-write failure
    mockDbSpk.set(keyId, b64);
  }),
  loadSpkSecret: jest.fn(async (keyId: number) => mockDbSpk.get(keyId) ?? null),
  loadLatestSpkSecret: jest.fn(async () => {
    if (mockDbSpk.size === 0) return null;
    const maxId = Math.max(...mockDbSpk.keys());
    return { keyId: maxId, b64: mockDbSpk.get(maxId)! };
  }),
  deleteSpkSecret: jest.fn(async (keyId: number) => { mockDbSpk.delete(keyId); }),
  saveOpkSecret: jest.fn(async (keyId: number, b64: string) => { mockDbOpk.set(keyId, b64); }),
  loadOpkSecret: jest.fn(async (keyId: number) => mockDbOpk.get(keyId) ?? null),
  deleteOpkSecret: jest.fn(async (keyId: number) => { mockDbOpk.delete(keyId); }),
  setSpkKeyId: jest.fn(async (n: number) => { mockDbSpkKeyId = n; }),
  getSpkKeyId: jest.fn(async () => mockDbSpkKeyId),
}));

jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: jest.fn(async () => ({ aegisId: '', publicKey: '', signingPublicKey: '', createdAt: 0 })),
  ApiError: class ApiError extends Error {},
}));

const mockContactsState = { contacts: [] as unknown[], loading: false };
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => mockContactsState,
    setState: () => undefined,
    subscribe: jest.fn(() => () => undefined),
  },
}));
jest.mock('../../store/connection', () => ({
  __esModule: true,
  useConnection: { getState: () => ({ setOnline: () => undefined }) },
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
    getState: () => ({ displayName: 'Tester', avatarColor: '#000', profileStatus: '', avatarImage: null }),
  },
}));
jest.mock('../../store/preferences', () => ({
  __esModule: true,
  usePreferences: { getState: () => ({ routeViaTor: false }) },
}));
jest.mock('../../runtime', () => ({ __esModule: true, IS_EXPO_GO: true }));

// SecureStore: writes succeed but do nothing; keyId reads return null so the DB
// counter is authoritative.
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
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'http://localhost', ONION_URL: '' }));

// ── Fake socket capturing prekeys:upload emits ───────────────────────────────
type AckCb = (ack: unknown) => void;
interface FakeSocket {
  handlers: Map<string, Function>;
  emit: jest.Mock;
  on: (event: string, cb: Function) => FakeSocket;
  off: () => FakeSocket;
  disconnect: jest.Mock;
  connect: jest.Mock;
  auth: Record<string, unknown>;
}
let mockFakeSocket: FakeSocket;
const emittedEvents: string[] = [];

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: (_url: string, opts: { auth: Record<string, unknown> }) => {
    mockFakeSocket = {
      handlers: new Map(),
      auth: opts.auth,
      on(event: string, cb: Function) { this.handlers.set(event, cb); return this; },
      off() { return this; },
      disconnect: jest.fn(),
      connect: jest.fn(),
      emit: jest.fn((event: string, _payload: unknown, ack?: AckCb) => {
        emittedEvents.push(event);
        if (event === 'prekeys:upload' && typeof ack === 'function') ack({ ok: true });
      }),
    };
    return mockFakeSocket;
  },
}));

import type { Identity } from '../../crypto/identity';

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

describe('uploadPreKeys — durable SPK secret persistence invariant', () => {
  beforeEach(() => {
    jest.resetModules();
    mockDbSpk.clear();
    mockDbOpk.clear();
    mockDbSpkKeyId = null;
    mockFailSpkWrite = false;
    emittedEvents.length = 0;
    mockContactsState.contacts = [];
  });

  it('persists the SPK secret in the DB readable by keyId, and emits prekeys:upload', async () => {
    const me = buildIdentity();
    const mod = require('../client') as typeof import('../client');
    mod.connect(me);

    // Drive auth:ok with a low opkCount so the refill branch runs uploadPreKeys.
    const onConnect = mockFakeSocket.handlers.get('connect')!;
    const onAuthOk = mockFakeSocket.handlers.get('auth:ok')!;
    onConnect();
    await onAuthOk({ opkCount: 0 });
    await new Promise((r) => setImmediate(r));

    // The SPK secret for the freshly generated keyId must be readable from the DB.
    expect(mockDbSpkKeyId).not.toBeNull();
    const keyId = mockDbSpkKeyId!;
    expect(mockDbSpk.has(keyId)).toBe(true);
    const { loadSpkSecret } = require('../../db/local');
    await expect(loadSpkSecret(keyId)).resolves.toBe(mockDbSpk.get(keyId));

    // The upload was emitted (invariant satisfied → publish allowed).
    expect(emittedEvents).toContain('prekeys:upload');
  });

  it('does NOT emit prekeys:upload when the SPK secret cannot be persisted/read back', async () => {
    mockFailSpkWrite = true; // simulate durable-store write failure
    const me = buildIdentity();
    const mod = require('../client') as typeof import('../client');
    mod.connect(me);

    const onConnect = mockFakeSocket.handlers.get('connect')!;
    const onAuthOk = mockFakeSocket.handlers.get('auth:ok')!;
    onConnect();
    // auth:ok swallows the uploadPreKeys error internally; just let it settle.
    await onAuthOk({ opkCount: 0 });
    await new Promise((r) => setImmediate(r));

    // INVARIANT: a SPK whose secret we cannot read back is never published.
    expect(emittedEvents).not.toContain('prekeys:upload');
    expect(mockDbSpk.size).toBe(0);
  });
});
