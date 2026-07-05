/**
 * Delete-for-everyone rides the E2EE channel (mobile/src/socket/client.ts).
 *
 * Field bug: "delete for everyone" only deleted locally — the peer kept the
 * message intact. The old implementation emitted a PLAINTEXT `msg:delete`
 * event, fire-and-forget: the relay dropped it whenever the recipient had no
 * live socket (mailbox-mode peers almost never do), and it leaked the
 * sender↔recipient pair to the relay (golden rule: sealed-sender in ALL
 * signals).
 *
 * The fix: the retraction is a `{type:'msg_delete', text:<msgId>}` JSON
 * control payload sent through sendMessage() — Double Ratchet encrypted,
 * outbox-durable, mailbox-deliverable. On receive it is applied silently
 * (remoteDelete), never appended as a chat row.
 *
 * Harness mirrors client.desyncRecovery.test.ts: everything mocked, we drive
 * the registered `envelope` handler with genuinely encrypted wires.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { encryptMessage } from '../../crypto/messaging';
import { initRatchet, type RatchetState } from '../../crypto/signal/ratchet';

// ── db/local mock with an in-memory ratchet session store ────────────────────
const mockRatchetSessions = new Map<string, string>();

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async (aegisId: string) => mockRatchetSessions.get(aegisId) ?? null),
  saveRatchetSession: jest.fn(async (aegisId: string, json: string) => {
    mockRatchetSessions.set(aegisId, json);
  }),
  deleteContactRatchetSession: jest.fn(async (aegisId: string) => {
    mockRatchetSessions.delete(aegisId);
  }),
  saveContact: jest.fn(async () => undefined),
  getActiveDbSlot: () => 'self',
  getGroup: jest.fn(async () => null),
  saveGroup: jest.fn(async () => undefined),
  loadOutboxJobs: jest.fn(async () => []),
  enqueueOutboxJob: jest.fn(async () => undefined),
  deleteOutboxJob: jest.fn(async () => undefined),
  incrementOutboxAttempts: jest.fn(async () => undefined),
}));

jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: jest.fn(async (id: string) => ({ aegisId: id, publicKey: '', signingPublicKey: '', createdAt: 0 })),
  ApiError: class ApiError extends Error {},
}));

const mockContactsState: {
  contacts: Array<{ aegisId: string; publicKeyB64: string; signingPublicKeyB64: string; blocked?: boolean }>;
} = { contacts: [] };
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => ({
      ...mockContactsState,
      loading: false,
      addByAegisId: jest.fn(async () => null),
      updateContactProfile: jest.fn(async () => undefined),
    }),
    setState: () => undefined,
    subscribe: () => () => undefined,
  },
}));

jest.mock('../../store/connection', () => ({
  __esModule: true,
  useConnection: { getState: () => ({ setOnline: () => undefined }) },
}));

// STABLE spies (not fresh per getState()) so production code and the test
// observe the same mocks.
const mockRemoteDelete = jest.fn(async () => undefined);
const mockAppend = jest.fn(async () => undefined);
const mockUpdateDelivery = jest.fn(async () => undefined);
jest.mock('../../store/messages', () => ({
  __esModule: true,
  useMessages: {
    getState: () => ({
      ephemeralTimer: 0,
      byChat: {},
      getEphemeralTimer: jest.fn(() => 0),
      append: mockAppend,
      updateDelivery: mockUpdateDelivery,
      remoteDelete: mockRemoteDelete,
    }),
  },
}));

const mockIdentityState: { identity: unknown } = { identity: null };
jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({
      identity: mockIdentityState.identity,
      displayName: 'Tester',
      avatarColor: '#000',
      profileStatus: '',
      avatarImage: null,
    }),
  },
}));
jest.mock('../../store/groups', () => ({ __esModule: true, useGroups: { getState: () => ({ hydrate: jest.fn() }) } }));
jest.mock('../../notifications/push', () => ({ __esModule: true, showIncomingNotification: jest.fn(async () => undefined) }));

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-crypto', () => ({ __esModule: true, randomUUID: () => '00000000-0000-0000-0000-000000000000' }));
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'http://localhost' }));

// ── Fake socket ──────────────────────────────────────────────────────────────
interface FakeSocket {
  handlers: Map<string, Function>;
  emit: jest.Mock;
  on: (event: string, cb: Function) => FakeSocket;
  off: () => FakeSocket;
  disconnect: jest.Mock;
  timeout: (ms: number) => { emit: (event: string, payload: unknown, cb: (err: Error | null, ack?: unknown) => void) => void };
  auth: { aegisId: string };
}
let mockFakeSocket: FakeSocket;
jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: (_url: string, opts: { auth: { aegisId: string } }) => {
    mockFakeSocket = {
      handlers: new Map(),
      auth: opts.auth,
      on(event: string, cb: Function) { this.handlers.set(event, cb); return this; },
      off() { return this; },
      disconnect: jest.fn(),
      timeout(ms: number) {
        void ms;
        return {
          emit: (event: string, payload: unknown, cb: (err: Error | null, ack?: unknown) => void) => {
            this.emit(event, payload, (ack: unknown) => cb(null, ack));
          },
        };
      },
      emit: jest.fn((event: string, _payload: unknown, ack?: (a: unknown) => void) => {
        if (event === 'envelope' && typeof ack === 'function') ack({ ok: true });
        if (event === 'prekeys:fetch' && typeof ack === 'function') {
          const bundle = (mockFakeSocket as unknown as { nextBundle?: unknown }).nextBundle;
          ack(bundle ? { ok: true, bundle } : { ok: false, error: 'not_found' });
        }
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
  } as Identity;
}

/** Serialize a ratchet state into the persisted-session JSON shape. */
function persistSession(aegisId: string, state: RatchetState): void {
  const serial = {
    RK: Array.from(state.RK),
    DHs: { publicKey: Array.from(state.DHs.publicKey), secretKey: Array.from(state.DHs.secretKey) },
    DHr: state.DHr ? Array.from(state.DHr) : null,
    CKs: state.CKs ? Array.from(state.CKs) : null,
    CKr: state.CKr ? Array.from(state.CKr) : null,
    Ns: state.Ns, Nr: state.Nr, PN: state.PN,
    MKSKIPPED: [],
    createdAtMs: state.createdAtMs,
  };
  mockRatchetSessions.set(aegisId, JSON.stringify(serial));
}

/**
 * Build a HEALTHY synced pair: peer holds the sender (Alice) state, `me`
 * persists the matching receiver (Bob) state. Returns the peer's sender state
 * so the test can encrypt real wires that `me` can ratchet-decrypt.
 */
function establishSyncedSession(me: Identity, peer: Identity): RatchetState {
  const spk = nacl.box.keyPair();
  const root = nacl.randomBytes(32);
  const sender = initRatchet(root, spk.publicKey, true);
  delete sender.x3dhInit;
  const receiver = initRatchet(root, sender.DHs.publicKey, false, spk);
  delete receiver.x3dhInit;
  receiver.createdAtMs = Date.now() - 120_000;
  persistSession(peer.aegisId, receiver);
  return sender;
}

function setPeerBundle(peer: Identity) {
  const spk = nacl.box.keyPair();
  const sig = nacl.sign.detached(spk.publicKey, peer.signingSecretKey);
  (mockFakeSocket as unknown as { nextBundle: unknown }).nextBundle = {
    identityKeyB64: peer.publicKeyB64,
    signingPublicKeyB64: peer.signingPublicKeyB64,
    signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(sig) },
    oneTimePreKey: null,
  };
}

function bringOnline() {
  mockFakeSocket.handlers.get('connect')!();
  mockFakeSocket.handlers.get('auth:ok')!({ opkCount: 100 });
}

const flush = () => new Promise((r) => setImmediate(r));

describe('delete-for-everyone over the E2EE channel', () => {
  let client: typeof import('../client');

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockContactsState.contacts = [];
    mockIdentityState.identity = null;
    mockRemoteDelete.mockClear();
    mockAppend.mockClear();
    mockUpdateDelivery.mockClear();
    client = require('../client') as typeof import('../client');
  });

  afterEach(() => {
    client.disconnect();
  });

  it('an incoming {type:"msg_delete"} payload applies remoteDelete silently (no chat row)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();

    client.connect(me);
    bringOnline();
    await flush();

    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    const senderState = establishSyncedSession(me, peer);

    const payload = JSON.stringify({ type: 'msg_delete', text: 'msg-to-retract' });
    const { envelope } = encryptMessage(payload, peer.aegisId, me.publicKey, peer.secretKey, senderState);

    await mockFakeSocket.handlers.get('envelope')!({
      id: 'env-del-1',
      from: peer.aegisId,
      to: me.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
    await flush();

    expect(mockRemoteDelete).toHaveBeenCalledWith(peer.aegisId, 'msg-to-retract', peer.aegisId);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('sendDeleteForEveryone emits an encrypted envelope — never the plaintext msg:delete event', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();

    client.connect(me);
    bringOnline();
    await flush();

    mockIdentityState.identity = me;
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    setPeerBundle(peer); // fresh X3DH session for the outgoing control message

    mockFakeSocket.emit.mockClear();
    client.sendDeleteForEveryone(peer.aegisId, 'msg-to-retract');
    // sendMessage is async fire-and-forget inside — drain it.
    for (let i = 0; i < 10; i++) await flush();

    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events).not.toContain('msg:delete'); // zero-metadata: nothing plaintext
    const env = mockFakeSocket.emit.mock.calls.find((c) => c[0] === 'envelope');
    expect(env).toBeDefined();
    const wire = env![1] as Record<string, unknown>;
    expect(wire.to).toBe(peer.aegisId);
    expect(typeof wire.ciphertext).toBe('string');
    // The retracted msgId must not be readable on the wire.
    expect(JSON.stringify(wire)).not.toContain('msg-to-retract');
  });

  it('an incoming {type:"read_receipt"} payload marks messages read via the sealed channel (no chat row)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();

    client.connect(me);
    bringOnline();
    await flush();

    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    const senderState = establishSyncedSession(me, peer);

    const payload = JSON.stringify({ type: 'read_receipt', text: JSON.stringify(['m-1', 'm-2']) });
    const { envelope } = encryptMessage(payload, peer.aegisId, me.publicKey, peer.secretKey, senderState);

    await mockFakeSocket.handlers.get('envelope')!({
      id: 'env-read-1',
      from: peer.aegisId,
      to: me.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
    await flush();

    // Sealed read receipt updates delivery status for each id, no chat row.
    expect(mockUpdateDelivery).toHaveBeenCalledWith(peer.aegisId, 'm-1', 'read');
    expect(mockUpdateDelivery).toHaveBeenCalledWith(peer.aegisId, 'm-2', 'read');
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('does NOT register the legacy plaintext msg:delete listener (unauthenticated remote delete)', () => {
    // Regression: the old plaintext `msg:delete` relay event let anyone able to
    // emit it (a malicious relay) erase arbitrary messages by supplying
    // {from, msgId}, with zero proof-of-key-possession. Delete-for-everyone now
    // rides the sealed E2EE channel only; the plaintext listener must be gone.
    const me = buildIdentity();
    client.connect(me);
    bringOnline();

    expect(mockFakeSocket.handlers.has('msg:delete')).toBe(false);
  });
});
