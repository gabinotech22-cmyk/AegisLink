/**
 * Regression tests for getOrCreateSession (mobile/src/socket/client.ts).
 *
 * Background: a contact row could be persisted with an empty signingPublicKeyB64
 * (legacy registrations, malformed relay bundles). Previously this empty
 * string flowed straight into performX3DH(), which surfaced the cryptic
 * internal error "X3DH: Missing recipient signing public key — cannot
 * verify SPK". The fix introduces a nonEmpty() helper plus a fail-fast
 * branch that throws an actionable error referencing the recipient
 * aegisId BEFORE X3DH is ever called.
 *
 * These tests cover both branches: the actionable failure and the happy
 * path with a valid Ed25519 signing key. No real network, no SecureStore
 * writes, no SQLite — every collaborator of client.ts is mocked. No
 * private key material is exposed in any mock.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

// Mocks must be declared before importing client.ts

const mockRatchetSessions = new Map<string, string>();

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async (aegisId: string) => mockRatchetSessions.get(aegisId) ?? null),
  saveRatchetSession: jest.fn(async (aegisId: string, json: string) => {
    mockRatchetSessions.set(aegisId, json);
  }),
  saveContact: jest.fn(async () => undefined),
  getActiveDbSlot: () => 'self',
  // Outbox persistence — flushOutbox() runs on auth:ok and drains these.
  loadOutboxJobs: jest.fn(async () => []),
  enqueueOutboxJob: jest.fn(async () => undefined),
  deleteOutboxJob: jest.fn(async () => undefined),
  incrementOutboxAttempts: jest.fn(async () => undefined),
}));

const mockLookupIdentity = jest.fn(async (aegisId: string) => ({
  aegisId,
  publicKey: '',
  signingPublicKey: '',
  createdAt: 0,
}));
jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: (id: string) => mockLookupIdentity(id),
  ApiError: class ApiError extends Error {},
}));

const mockContactsState: {
  contacts: Array<{ aegisId: string; publicKeyB64: string; signingPublicKeyB64: string }>;
} = { contacts: [] };
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => mockContactsState,
    setState: (updater: (s: typeof mockContactsState) => Partial<typeof mockContactsState>) => {
      const patch = updater(mockContactsState);
      Object.assign(mockContactsState, patch);
    },
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
    getState: () => ({
      displayName: 'Tester',
      avatarColor: '#000',
      profileStatus: '',
      avatarImage: null,
    }),
  },
}));

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-crypto', () => ({
  __esModule: true,
  randomUUID: () => '00000000-0000-0000-0000-000000000000',
}));
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'http://localhost' }));

// Fake socket.io client

type AckCb = (ack: unknown) => void;
interface FakeSocket {
  handlers: Map<string, Function>;
  emit: jest.Mock;
  on: (event: string, cb: Function) => FakeSocket;
  off: () => FakeSocket;
  disconnect: jest.Mock;
  auth: { aegisId: string };
  pendingPrekeyAck?: AckCb;
}

let mockFakeSocket: FakeSocket;

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: (_url: string, opts: { auth: { aegisId: string } }) => {
    mockFakeSocket = {
      handlers: new Map(),
      auth: opts.auth,
      on(event: string, cb: Function) {
        this.handlers.set(event, cb);
        return this;
      },
      off() {
        return this;
      },
      disconnect: jest.fn(),
      emit: jest.fn((event: string, _payload: unknown, ack?: AckCb) => {
        if (event === 'prekeys:fetch' && typeof ack === 'function') {
          const bundle = (mockFakeSocket as unknown as { nextBundle?: unknown }).nextBundle;
          if (bundle) {
            ack({ ok: true, bundle });
          } else {
            mockFakeSocket.pendingPrekeyAck = ack;
          }
        }
        if (event === 'envelope' && typeof ack === 'function') {
          ack({ ok: true });
        }
      }),
    };
    return mockFakeSocket;
  },
}));

// Helpers

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

function buildBundle(
  contactBoxPub: Uint8Array,
  contactSignSec: Uint8Array,
  contactSignPubB64: string,
) {
  const spk = nacl.box.keyPair();
  const signature = nacl.sign.detached(spk.publicKey, contactSignSec);
  const opk = nacl.box.keyPair();
  return {
    identityKeyB64: encodeBase64(contactBoxPub),
    signingPublicKeyB64: contactSignPubB64,
    signedPreKey: {
      keyId: 1,
      publicKeyB64: encodeBase64(spk.publicKey),
      signatureB64: encodeBase64(signature),
    },
    oneTimePreKey: { keyId: 7, publicKeyB64: encodeBase64(opk.publicKey) },
  };
}

function bringSocketOnline() {
  const onConnect = mockFakeSocket.handlers.get('connect');
  const onAuthOk = mockFakeSocket.handlers.get('auth:ok');
  if (!onConnect || !onAuthOk) throw new Error('socket handlers not registered');
  onConnect();
  // opkCount >= 20 skips the refill branch which would hit SecureStore
  onAuthOk({ opkCount: 100 });
}

// Tests

describe('getOrCreateSession — empty signingPublicKey regression', () => {
  let connect: typeof import('../client').connect;
  let sendMessage: typeof import('../client').sendMessage;

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockContactsState.contacts = [];
    mockLookupIdentity.mockClear();
    const mod = require('../client') as typeof import('../client');
    connect = mod.connect;
    sendMessage = mod.sendMessage;
  });

  it('throws an actionable error referencing the recipient when relay, contact and directory all return an empty signingPublicKey (does NOT surface the internal X3DH error)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();

    // Bring socket online with NO contacts so broadcastProfileUpdate is a no-op
    connect(me);
    bringSocketOnline();
    await new Promise((r) => setImmediate(r));

    // Now add the contact (legacy empty signing key) and queue the bundle
    mockContactsState.contacts = [
      {
        aegisId: peer.aegisId,
        publicKeyB64: peer.publicKeyB64,
        signingPublicKeyB64: '',
      },
    ];
    // Relay bundle also carries an empty signingPublicKeyB64. Signature is
    // valid against the real signing key so the ONLY reason the handshake
    // must fail is the missing signing public key.
    (mockFakeSocket as unknown as { nextBundle: unknown }).nextBundle =
      buildBundle(peer.publicKey, peer.signingSecretKey, '');

    const sendPromise = sendMessage({
      identity: me,
      recipientAegisId: peer.aegisId,
      recipientPublicKey: peer.publicKey,
      plaintext: 'hola',
      skipLocalAppend: true,
    });

    await expect(sendPromise).rejects.toThrow(
      'Cannot start secure session with ' + peer.aegisId,
    );
    // Critically: the cryptic internal X3DH error must NOT surface.
    await expect(sendPromise).rejects.not.toThrow(/Missing recipient signing public key/);
    expect(mockLookupIdentity).toHaveBeenCalledWith(peer.aegisId);
  });

  it('creates a Double Ratchet session without error when signingPublicKeyB64 is a valid 32-byte Ed25519 key', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();

    connect(me);
    bringSocketOnline();
    await new Promise((r) => setImmediate(r));

    mockContactsState.contacts = [
      {
        aegisId: peer.aegisId,
        publicKeyB64: peer.publicKeyB64,
        signingPublicKeyB64: peer.signingPublicKeyB64,
      },
    ];
    (mockFakeSocket as unknown as { nextBundle: unknown }).nextBundle =
      buildBundle(peer.publicKey, peer.signingSecretKey, peer.signingPublicKeyB64);

    const sendPromise = sendMessage({
      identity: me,
      recipientAegisId: peer.aegisId,
      recipientPublicKey: peer.publicKey,
      plaintext: 'hola',
      skipLocalAppend: true,
    });

    await expect(sendPromise).resolves.toBeUndefined();
    // Session persisted under the peer's id proves X3DH + ratchet init ran
    expect(mockRatchetSessions.has(peer.aegisId)).toBe(true);
    // Valid pinned key means the directory fallback must NOT be triggered
    expect(mockLookupIdentity).not.toHaveBeenCalled();
  });
});
