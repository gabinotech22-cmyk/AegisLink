/**
 * Federation F4 — call signaling to/from a contact on ANOTHER relay
 * (docs/FEDERATION-DESIGN.md D3, socket/callSignalRouter.ts).
 *
 * The sealed 1:1 / group call events are routed by `to: aegisId` on OUR relay,
 * which a foreign contact does not have. So:
 *   - outgoing: the same sealed event rides as a `call_signal` E2EE message
 *     through THEIR relay (relay pool), transient (no outbox), invites with
 *     `wakeHint: 'call'` on the outer mailbox wire; local peers unchanged;
 *   - per-recipient fan-outs (`items`) split: local items in one emit, one
 *     sealed copy per foreign member;
 *   - incoming: a `call_signal` from an authenticated sealed-sender reaches the
 *     handler registered for that event, with `from` pinned; never a chat row;
 *   - unknown events / malformed payloads are dropped.
 *
 * Harness mirrors client.firstContact.test.ts.
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
import { identityFromRaw } from '../../crypto/__tests__/helpers/rawIdentity';
import { vault } from '../../crypto/sodium/vault';

function buildIdentity(): Identity {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return identityFromRaw(box, sign);
}

/** Serve `peer`'s prekey bundle from THEIR relay (foreignRelayHttp seam). Returns the SPK pair. */
function foreignPeerBundleVia(peer: Identity) {
  const spk = nacl.box.keyPair();
  const sig = vault.sign(peer.signingSecretKey, spk.publicKey);
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
    DHs: { publicKey: Array.from(state.DHs.publicKey), secretKey: Array.from(state.DHs.secretKey as Uint8Array) },
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

/** Outgoing: `me` already holds an established session with `peer`. */
function establishOutgoingSession(peer: Identity): void {
  const spk = nacl.box.keyPair();
  const sender = initRatchet(nacl.randomBytes(32), spk.publicKey, true);
  delete sender.x3dhInit;
  sender.createdAtMs = Date.now() - 120_000;
  persistSession(peer.aegisId, sender);
}

type OnSocket = { on: (e: string, cb: (...a: unknown[]) => void) => unknown };

describe('federation F4 — call signaling across relays', () => {
  let client: typeof import('../client');
  let router: typeof import('../callSignalRouter');

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockSpkSecrets.clear();
    mockContactsState.contacts = [];
    mockIdentityState.identity = null;
    mockAppend.mockClear();
    mockSaveContact.mockClear();
    mockEnqueueOutboxJob.mockClear();
    mockSendViaForeignRelay.mockClear();
    mockForeignRelayHttp.mockReset();
    client = require('../client') as typeof import('../client');
    router = require('../callSignalRouter') as typeof import('../callSignalRouter');
  });

  afterEach(() => { router.clearCallSignalHandlers(); client.disconnect(); });

  it('outgoing: a local peer keeps the socket event; a foreign peer gets a transient sealed call_signal through THEIR relay, invites with wakeHint=call', async () => {
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
    establishOutgoingSession(foreign);
    mockFakeSocket.emit.mockClear();

    expect(router.routeCallSignal(mockFakeSocket, 'call:invite:v2', local.aegisId, { callId: 'c1', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' })).toBe(true);
    expect(mockFakeSocket.emit).toHaveBeenCalledWith('call:invite:v2', { callId: 'c1', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z', to: local.aegisId });
    expect(mockSendViaForeignRelay).not.toHaveBeenCalled();

    mockFakeSocket.emit.mockClear();
    expect(router.routeCallSignal(mockFakeSocket, 'call:invite:v2', foreign.aegisId, { callId: 'call-id-must-stay-sealed', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' })).toBe(true);
    await settle();
    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events.filter((e) => e.startsWith('call:'))).toEqual([]); // never the home socket
    expect(events).not.toContain('envelope');
    expect(events).not.toContain('envelope:v2');
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
    const [relay, env] = mockSendViaForeignRelay.mock.calls[0] as unknown as [{ onion: string }, Record<string, unknown>];
    expect(relay.onion).toBe(ONION);
    expect(env.to).toBe('their-mailbox-id');
    expect(env.wakeHint).toBe('call');
    expect(env.ephemeralTtl).toBeGreaterThan(0); // bounded relay life
    expect(JSON.stringify(env)).not.toContain(me.aegisId);
    expect(JSON.stringify(env)).not.toContain('call-id-must-stay-sealed'); // callId sealed too
    expect(mockEnqueueOutboxJob).not.toHaveBeenCalled(); // transient: never persisted
    expect(mockAppend).not.toHaveBeenCalled();

    // Non-invite signals carry no wake hint.
    mockSendViaForeignRelay.mockClear();
    router.routeCallSignal(mockFakeSocket, 'call:ice:v2', foreign.aegisId, { callId: 'call-id-must-stay-sealed', ciphertext: 'x', nonce: 'y' });
    await settle();
    expect((mockSendViaForeignRelay.mock.calls[0] as unknown as [unknown, Record<string, unknown>])[1].wakeHint).toBeUndefined();
  });

  it('outgoing: a per-recipient fan-out splits — local items in one emit, one sealed copy per foreign member', async () => {
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
    establishOutgoingSession(foreign);
    mockFakeSocket.emit.mockClear();

    router.routeCallSignalItems(mockFakeSocket, 'group_call:channel', { callId: 'g1', groupId: 'grp', media: 'audio' }, [
      { to: local.aegisId, ciphertext: 'L', nonce: 'l' },
      { to: foreign.aegisId, ciphertext: 'F', nonce: 'f' },
    ]);
    await settle();
    const channel = mockFakeSocket.emit.mock.calls.filter((c) => c[0] === 'group_call:channel');
    expect(channel).toHaveLength(1);
    expect(channel[0][1]).toEqual({ callId: 'g1', groupId: 'grp', media: 'audio', items: [{ to: local.aegisId, ciphertext: 'L', nonce: 'l' }] });
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
  });

  it('incoming: a call_signal from an authenticated sealed-sender reaches the registered handler with `from` pinned, and is never appended', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, relayOnion: ONION }];
    const senderState = establishSyncedSession(peer);
    const handler = jest.fn();
    router.onCallSignal(mockFakeSocket as unknown as OnSocket, 'call:hangup:v2', handler);

    const payload = JSON.stringify({ type: 'call_signal', text: JSON.stringify({ event: 'call:hangup:v2', msg: { callId: 'c9', reason: 'busy' } }) });
    const { envelope } = encryptMessage(payload, peer.aegisId, me.publicKey, peer.secretKey, senderState);
    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope')!({ id: 'env-cs-1', from: peer.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 });
    await settle();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith({ callId: 'c9', reason: 'busy' }, peer.aegisId);
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockFakeSocket.emit).toHaveBeenCalledWith('envelope:ack', { id: 'env-cs-1' });
  });

  it('incoming: unknown events and malformed payloads are dropped; the socket path never carries a `from`', async () => {
    const me = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    const handler = jest.fn();
    router.onCallSignal(mockFakeSocket as unknown as OnSocket, 'call:ice:v2', handler);
    await router.dispatchSealedCallSignal('PEER', JSON.stringify({ event: 'envelope', msg: { x: 1 } }));       // not a call event
    await router.dispatchSealedCallSignal('PEER', JSON.stringify({ event: 'call:ice:v2', msg: 'nope' }));     // msg not an object
    await router.dispatchSealedCallSignal('PEER', 'not json');
    await router.dispatchSealedCallSignal('PEER', JSON.stringify({ event: 'call:invite:v2', msg: {} }));      // no handler registered
    expect(handler).not.toHaveBeenCalled();
    await router.dispatchSealedCallSignal('PEER', JSON.stringify({ event: 'call:ice:v2', msg: { callId: 'c' } }));
    expect(handler).toHaveBeenCalledWith({ callId: 'c' }, 'PEER');
    // Socket delivery: same handler, no `from` (the relay never stamps one).
    handler.mockClear();
    mockFakeSocket.handlers.get('call:ice:v2')!({ callId: 'c', ciphertext: 'a', nonce: 'b' });
    expect(handler).toHaveBeenCalledWith({ callId: 'c', ciphertext: 'a', nonce: 'b' });
  });
});
