/**
 * The ack is what deletes the message (audit 2026-08-08).
 *
 * The relay keeps a queued row until the recipient acks it, so `envelope:ack`
 * is the ONLY thing standing between a message and permanent deletion. Every
 * failure path in handleIncoming / handleIncomingV2 was a bare `return`, and
 * both socket handlers acked unconditionally right after — so an envelope we
 * could not open was acked exactly like one we had stored. Delivered, acked,
 * deleted, nothing on screen: a message lost with no error anywhere.
 *
 * Reported as "el mensaje se perdió, no llegó" with the relay queue confirming
 * the row had been handed out and then freed.
 *
 * Pinned here:
 *   - undecryptable  → NO ack (the relay re-offers it; the sender's contact
 *                      record or signing key may simply not have synced yet)
 *   - blocked sender → ack (deliberate discard; replaying it forever is
 *                      pointless and the decision is the user's)
 *
 * Not acking is only safe because the relay bounds re-delivery with
 * MAX_DELIVERY_ATTEMPTS (#421) — before that, a permanently undecryptable
 * envelope would have been replayed for its whole 30-day TTL.
 *
 * Everything is mocked: no network, no SecureStore, no SQLite.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async () => null),
  saveRatchetSession: jest.fn(async () => undefined),
  deleteContactRatchetSession: jest.fn(async () => undefined),
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
const mockAddByAegisId = jest.fn(async () => null);
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => ({
      ...mockContactsState,
      loading: false,
      addByAegisId: mockAddByAegisId,
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
jest.mock('../../store/messages', () => ({
  __esModule: true,
  useMessages: {
    getState: () => ({
      ephemeralTimer: 0,
      byChat: {},
      getEphemeralTimer: jest.fn(() => 0),
      append: jest.fn(async () => undefined),
      updateDelivery: jest.fn(async () => undefined),
      remoteDelete: jest.fn(async () => undefined),
    }),
  },
}));
jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({ identity: null, displayName: 'Tester', avatarColor: '#000', profileStatus: '', avatarImage: null }),
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
        if (event === 'prekeys:fetch' && typeof ack === 'function') ack({ ok: false, error: 'not_found' });
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

function bringOnline(): void {
  mockFakeSocket.handlers.get('connect')!();
  mockFakeSocket.handlers.get('auth:ok')!({ opkCount: 100 });
}

function ackedIds(): string[] {
  return mockFakeSocket.emit.mock.calls
    .filter((c) => c[0] === 'envelope:ack')
    .map((c) => (c[1] as { id: string }).id);
}

describe('envelope:ack is only sent for messages we actually have', () => {
  let connect: typeof import('../client').connect;

  beforeEach(() => {
    jest.resetModules();
    mockContactsState.contacts = [];
    mockAddByAegisId.mockClear();
    connect = (require('../client') as typeof import('../client')).connect;
  });

  afterEach(() => {
    (require('../client') as typeof import('../client')).disconnect();
  });

  it('does NOT ack a sealed v2 envelope it cannot open', async () => {
    const me = buildIdentity();
    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockFakeSocket.emit.mockClear();
    // Well-formed shape, garbage contents — exactly what an envelope from a
    // sender whose signing key has not synced yet looks like from here.
    await mockFakeSocket.handlers.get('envelope:v2')!({
      id: 'v2-unopenable',
      to: me.aegisId,
      ciphertext: encodeBase64(nacl.randomBytes(64)),
      nonce: encodeBase64(nacl.randomBytes(24)),
      epk: encodeBase64(nacl.randomBytes(32)),
      createdAt: Date.now(),
    });
    await new Promise((r) => setImmediate(r));

    expect(ackedIds()).not.toContain('v2-unopenable');
  });

  it('does NOT ack a v1 envelope from a sender nobody can decrypt', async () => {
    const me = buildIdentity();
    const stranger = buildIdentity();
    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope')!({
      id: 'v1-unopenable',
      to: me.aegisId,
      from: stranger.aegisId,
      ciphertext: encodeBase64(nacl.randomBytes(64)),
      nonce: encodeBase64(nacl.randomBytes(24)),
      createdAt: Date.now(),
    });
    await new Promise((r) => setImmediate(r));

    expect(ackedIds()).not.toContain('v1-unopenable');
  });

  it('DOES ack a message from a blocked contact — a deliberate discard is final', async () => {
    const me = buildIdentity();
    const blocked = buildIdentity();
    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockContactsState.contacts = [{
      aegisId: blocked.aegisId,
      publicKeyB64: blocked.publicKeyB64,
      signingPublicKeyB64: blocked.signingPublicKeyB64,
      blocked: true,
    }];

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope')!({
      id: 'v1-blocked',
      to: me.aegisId,
      from: blocked.aegisId,
      ciphertext: encodeBase64(nacl.randomBytes(64)),
      nonce: encodeBase64(nacl.randomBytes(24)),
      createdAt: Date.now(),
    });
    await new Promise((r) => setImmediate(r));

    // Blocked never reaches decryption, so without an ack the relay would
    // re-offer it on every connect until the attempt cap burned out.
    expect(ackedIds()).toContain('v1-blocked');
  });
});
