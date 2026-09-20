/**
 * Federation F5b — `profile_update.mailboxRelay`: how contacts learn where our
 * mailbox lives after a relay migration (docs/FEDERATION-DESIGN.md D4).
 *   - receive: a valid v3 onion (or explicit null = official) updates the
 *     contact's relay; a malformed value never does; the field is authenticated
 *     by the sealed sender + MAC like every other profile field;
 *   - send: every profile payload carries `mailboxRelay` (our home, null =
 *     official), and a forced broadcast reaches a foreign contact through THEIR
 *     relay and a local one on the home socket.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { encryptMessage } from '../../crypto/messaging';
import { initRatchet, type RatchetState } from '../../crypto/signal/ratchet';
import { deriveAegisId } from '../../crypto/aegisId';

// ── db/local mock with an in-memory ratchet session store ────────────────────
const mockRatchetSessions = new Map<string, string>();
const mockSpkSecrets = new Map<number, string>();
const mockSaveContact = jest.fn(async (..._a: unknown[]) => undefined);
const mockEnqueueOutboxJob = jest.fn(async (..._a: unknown[]) => undefined);

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async (aegisId: string) => mockRatchetSessions.get(aegisId) ?? null),
  saveRatchetSession: jest.fn(async (aegisId: string, json: string) => {
    mockRatchetSessions.set(aegisId, json);
  }),
  deleteContactRatchetSession: jest.fn(async (aegisId: string) => {
    mockRatchetSessions.delete(aegisId);
  }),
  saveContact: (...a: unknown[]) => mockSaveContact(...a),
  getActiveDbSlot: () => 'self',
  getGroup: jest.fn(async () => null),
  saveGroup: jest.fn(async () => undefined),
  loadOutboxJobs: jest.fn(async () => []),
  loadDueOutboxJobs: jest.fn(async () => []),
  nextOutboxDueAt: jest.fn(async () => null),
  countOutboxJobsForBubble: jest.fn(async () => 0),
  enqueueOutboxJob: (...a: unknown[]) => mockEnqueueOutboxJob(...a),
  deleteOutboxJob: jest.fn(async () => undefined),
  incrementOutboxAttempts: jest.fn(async () => undefined),
  markOutboxAttemptFailed: jest.fn(async () => undefined),
  // X3DH prekey secrets (receiver side of the bootstrap)
  saveSpkSecret: jest.fn(async () => undefined),
  loadSpkSecret: jest.fn(async (keyId: number) => mockSpkSecrets.get(keyId) ?? null),
  loadLatestSpkSecret: jest.fn(async () => null),
  deleteSpkSecret: jest.fn(async () => undefined),
  saveOpkSecret: jest.fn(async () => undefined),
  loadOpkSecret: jest.fn(async () => null),
  deleteOpkSecret: jest.fn(async () => undefined),
  setSpkKeyId: jest.fn(async () => undefined),
  getSpkKeyId: jest.fn(async () => null),
  setSpkCreatedAt: jest.fn(async () => undefined),
  getSpkCreatedAt: jest.fn(async () => null),
  savePqSpkSecret: jest.fn(async () => undefined),
  loadPqSpkSecret: jest.fn(async () => null),
  setPqSpkKeyId: jest.fn(async () => undefined),
  getPqSpkKeyId: jest.fn(async () => null),
}));

jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: jest.fn(async (id: string) => ({ aegisId: id, publicKey: '', signingPublicKey: '', createdAt: 0 })),
  ApiError: class ApiError extends Error {},
}));

const mockUpdateContactRelay = jest.fn(async (..._a: unknown[]) => undefined);
const mockUpdateContactCaps = jest.fn(async (..._a: unknown[]) => undefined);
type MockContact = {
  aegisId: string; publicKeyB64: string; signingPublicKeyB64: string; blocked?: boolean;
  relayOnion?: string | null; pending?: boolean; name?: string; verified?: boolean;
};
const mockContactsState: { contacts: MockContact[] } = { contacts: [] };
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => ({
      ...mockContactsState,
      loading: false,
      addByAegisId: jest.fn(async () => null),
      updateContactProfile: jest.fn(async () => undefined),
      updateContactRelay: (...a: unknown[]) => mockUpdateContactRelay(...a),
      updateContactCaps: (...a: unknown[]) => mockUpdateContactCaps(...a),
    }),
    setState: (updater: unknown) => {
      const next = typeof updater === 'function'
        ? (updater as (mockState: typeof mockContactsState) => Partial<typeof mockContactsState>)(mockContactsState)
        : (updater as Partial<typeof mockContactsState>);
      if (next.contacts) mockContactsState.contacts = next.contacts;
    },
    subscribe: () => () => undefined,
  },
}));

jest.mock('../../store/connection', () => ({
  __esModule: true,
  useConnection: { getState: () => ({ setOnline: () => undefined }) },
}));

const mockAppend = jest.fn(async (..._a: unknown[]) => undefined);
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
      remoteDelete: jest.fn(async () => undefined),
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
// FEDERATION on: the receiver accepts a first-contact bootstrap from a stranger.
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'http://localhost', SEALED_TRANSPORT_VERSION: 'v2', MAILBOX_ENABLED: false, ONION_URL: null, FEDERATION: true }));
jest.mock('../../crypto/deliveryToken', () => ({
  __esModule: true,
  getContactDeliveryToken: jest.fn(async () => null), // no token yet: a stranger
  getOwnDeliveryToken: jest.fn(async () => 'bXktdG9rZW4='),
  hashDeliveryToken: jest.fn(() => 'aGFzaA=='),
  setContactDeliveryToken: jest.fn(async () => undefined),
}));

// ── Federation seams ─────────────────────────────────────────────────────────
const ONION = 'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd.onion';
const MY_ROOT = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const mockSendViaForeignRelay = jest.fn(async (..._a: unknown[]) => ({ ok: true, queued: true }));
const mockForeignRelayHttp = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../net/relayPool', () => ({
  __esModule: true,
  sendViaForeignRelay: (...a: unknown[]) => mockSendViaForeignRelay(...a),
  foreignRelayHttp: (...a: unknown[]) => mockForeignRelayHttp(...a),
  closeForeignRelays: jest.fn(),
}));
const mockSetContactMailboxRoot = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../../crypto/mailboxStore', () => ({
  __esModule: true,
  getOwnMailboxRootB64: jest.fn(async () => MY_ROOT),
  setContactMailboxRoot: (...a: unknown[]) => mockSetContactMailboxRoot(...a),
  getContactCurrentMailboxId: jest.fn(async () => 'their-mailbox-id'),
}));
jest.mock('../../crypto/channelKeyStore', () => ({
  __esModule: true,
  saveSenderKey: jest.fn(async () => undefined),
  loadSenderKey: jest.fn(async () => null),
}));
jest.mock('../../net/tor', () => ({
  __esModule: true,
  isTorAvailable: () => false,
  startTor: jest.fn(),
  onTorStatus: () => () => undefined,
  torHttpRequest: jest.fn(async () => null),
  TorSioSocket: function () { /* unused */ },
}));

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
        if ((event === 'envelope' || event === 'envelope:v2') && typeof ack === 'function') ack({ ok: true });
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
    aegisId: deriveAegisId(box.publicKey),
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

/** Serve `peer`'s prekey bundle from THEIR relay (foreignRelayHttp seam). Returns the SPK pair. */
function foreignPeerBundleVia(peer: Identity) {
  const spk = nacl.box.keyPair();
  const sig = nacl.sign.detached(spk.publicKey, peer.signingSecretKey);
  const bundle = {
    identityKeyB64: peer.publicKeyB64,
    signingPublicKeyB64: peer.signingPublicKeyB64,
    signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(sig) },
    oneTimePreKey: null,
  };
  mockForeignRelayHttp.mockImplementation(async (_relay: unknown, path: unknown) => {
    if (String(path).startsWith('/prekeys/bundle/')) return { status: 200, body: JSON.stringify({ bundle }) };
    return { status: 404, body: '' };
  });
  return { spk, bundle };
}

function bringOnline() {
  mockFakeSocket.handlers.get('connect')!();
  mockFakeSocket.handlers.get('auth:ok')!({ opkCount: 100 });
}

const flush = () => new Promise((r) => setImmediate(r));
const settle = async () => { for (let i = 0; i < 30; i++) await flush(); };


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

/** Healthy synced pair: returns the peer's sender state; `me` holds the receiver state. */
function establishSyncedSession(peer: Identity): RatchetState {
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

function establishOutgoingSession(peer: Identity): void {
  const spk = nacl.box.keyPair();
  const sender = initRatchet(nacl.randomBytes(32), spk.publicKey, true);
  delete sender.x3dhInit;
  sender.createdAtMs = Date.now() - 120_000;
  persistSession(peer.aegisId, sender);
}

const MINE = 'm'.repeat(56) + '.onion';

describe('federation F5b — profile_update.mailboxRelay', () => {
  let client: typeof import('../client');

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockContactsState.contacts = [];
    mockIdentityState.identity = null;
    mockAppend.mockClear();
    mockUpdateContactRelay.mockClear();
    mockUpdateContactCaps.mockClear();
    mockSendViaForeignRelay.mockClear();
    mockForeignRelayHttp.mockReset();
    client = require('../client') as typeof import('../client');
  });

  afterEach(() => { client.disconnect(); });

  async function receiveProfile(me: Identity, peer: Identity, senderState: RatchetState, extra: Record<string, unknown>, id: string) {
    const payload = JSON.stringify({ type: 'profile_update', senderName: 'Peer', senderColor: '#000', senderStatus: '', senderImage: null, ...extra });
    const { envelope, newState } = encryptMessage(payload, peer.aegisId, me.publicKey, peer.secretKey, senderState);
    await mockFakeSocket.handlers.get('envelope')!({ id, from: peer.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 });
    await settle();
    return newState;
  }

  it('receive: a valid onion moves the contact, null brings it back to official, garbage is ignored', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    let st = establishSyncedSession(peer);

    st = await receiveProfile(me, peer, st, { mailboxRelay: MINE.toUpperCase() }, 'p1');
    expect(mockUpdateContactRelay).toHaveBeenLastCalledWith(peer.aegisId, MINE); // normalised

    st = await receiveProfile(me, peer, st, { mailboxRelay: 'evil.example.com' }, 'p2');
    expect(mockUpdateContactRelay).toHaveBeenCalledTimes(1); // ignored

    st = await receiveProfile(me, peer, st, { mailboxRelay: null }, 'p3');
    expect(mockUpdateContactRelay).toHaveBeenLastCalledWith(peer.aegisId, null);

    await receiveProfile(me, peer, st, {}, 'p4'); // no field → untouched
    expect(mockUpdateContactRelay).toHaveBeenCalledTimes(2);
    expect(mockAppend).not.toHaveBeenCalled(); // profile updates are never chat rows
  });

  it('receive: `caps` is sanitized and pinned; garbage or a missing field leaves it alone', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    let st = establishSyncedSession(peer);

    st = await receiveProfile(me, peer, st, { caps: ['sealed-calls', 'Sealed-Calls', 42, 'x'.repeat(40), 'future-cap', 'sealed-calls'] }, 'c1');
    expect(mockUpdateContactCaps).toHaveBeenLastCalledWith(peer.aegisId, ['sealed-calls', 'future-cap']);

    st = await receiveProfile(me, peer, st, { caps: 'sealed-calls' }, 'c2'); // not an array
    expect(mockUpdateContactCaps).toHaveBeenCalledTimes(1);

    await receiveProfile(me, peer, st, {}, 'c3'); // pre-caps peer
    expect(mockUpdateContactCaps).toHaveBeenCalledTimes(1);
  });

  it('send: a forced broadcast carries mailboxRelay to every contact — local on the home socket, foreign through THEIR relay', async () => {
    const me = buildIdentity();
    const local = buildIdentity();
    const foreign = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    mockContactsState.contacts = [
      { aegisId: local.aegisId, publicKeyB64: local.publicKeyB64, signingPublicKeyB64: local.signingPublicKeyB64 },
      { aegisId: foreign.aegisId, publicKeyB64: foreign.publicKeyB64, signingPublicKeyB64: foreign.signingPublicKeyB64, relayOnion: ONION },
    ];
    establishOutgoingSession(local);
    establishOutgoingSession(foreign);
    mockFakeSocket.emit.mockClear();

    await client.broadcastProfileUpdate(me, { force: true });
    await settle();

    const envelopes = mockFakeSocket.emit.mock.calls.filter((c) => c[0] === 'envelope');
    expect(envelopes).toHaveLength(1);
    expect((envelopes[0][1] as { to: string }).to).toBe(local.aegisId);
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
    expect((mockSendViaForeignRelay.mock.calls[0] as unknown as [{ onion: string }, { to: string }])[0].onion).toBe(ONION);
    expect((mockSendViaForeignRelay.mock.calls[0] as unknown as [{ onion: string }, { to: string }])[1].to).toBe('their-mailbox-id');
    // A profile update renders nothing: silent on BOTH transports (phantom push fix).
    expect((envelopes[0][1] as { wakeHint?: string }).wakeHint).toBe('silent');
    expect((mockSendViaForeignRelay.mock.calls[0] as unknown as [unknown, { wakeHint?: string }])[1].wakeHint).toBe('silent');
    // Nothing about the foreign contact leaves on the home socket.
    expect(JSON.stringify(mockFakeSocket.emit.mock.calls)).not.toContain(foreign.aegisId);
  });
});
