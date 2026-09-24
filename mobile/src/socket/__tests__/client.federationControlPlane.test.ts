/**
 * Federation F3 — control plane and group re-key for contacts on ANOTHER relay
 * (docs/FEDERATION-DESIGN.md D3). A foreign contact has no relay-local events
 * (`group:rekey` is a queue keyed by aegisId on OUR relay), so:
 *   - typing / read receipts ride the sealed E2EE channel and leave through the
 *     relay pool (their relay), never as a plaintext event on our socket. Since
 *     audit 2026-09-24 R-1 that holds for LOCAL contacts too, even with the
 *     mailbox off (this file mocks MAILBOX_ENABLED: false): the plaintext
 *     `typing` / `msg:read` relay events no longer exist in either direction;
 *   - a group SenderKey distribution to a foreign member travels as a
 *     `sender_key_dist` sealed message; local members keep `group:rekey`;
 *   - an incoming `sender_key_dist` is opened against the authenticated sender
 *     only, saved, and never appended as a chat row.
 *
 * Harness mirrors client.deleteForEveryone.test.ts (fully mocked socket +
 * stores, genuine Double Ratchet wires).
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { encryptMessage } from '../../crypto/messaging';
import { generateSenderKey, sealSenderKeyForRecipients } from '../../crypto/channelKey';
import { initRatchet, type RatchetState } from '../../crypto/signal/ratchet';
import { deriveAegisId } from '../../crypto/aegisId';

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
  contacts: Array<{ aegisId: string; publicKeyB64: string; signingPublicKeyB64: string; blocked?: boolean; relayOnion?: string | null }>;
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
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'http://localhost', SEALED_TRANSPORT_VERSION: 'v2', MAILBOX_ENABLED: false, ONION_URL: null }));
jest.mock('../../crypto/deliveryToken', () => ({
  __esModule: true,
  getContactDeliveryToken: jest.fn(async () => 'dGhlaXItZGVsaXZlcnktdG9rZW4='),
  getOwnDeliveryToken: jest.fn(async () => 'bXktdG9rZW4='),
  hashDeliveryToken: jest.fn(() => 'aGFzaA=='),
  setContactDeliveryToken: jest.fn(async () => undefined),
}));


// ── Federation seams ─────────────────────────────────────────────────────────
const ONION = 'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd.onion';
const mockSendViaForeignRelay = jest.fn(async (..._a: unknown[]) => ({ ok: true, queued: true }));
const mockForeignRelayHttp = jest.fn<Promise<unknown>, unknown[]>();
jest.mock('../../net/relayPool', () => ({
  __esModule: true,
  sendViaForeignRelay: (...a: unknown[]) => mockSendViaForeignRelay(...a),
  foreignRelayHttp: (...a: unknown[]) => mockForeignRelayHttp(...a),
  closeForeignRelays: jest.fn(),
}));
jest.mock('../../crypto/mailboxStore', () => ({
  __esModule: true,
  getOwnMailboxRootB64: jest.fn(async () => 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='),
  setContactMailboxRoot: jest.fn(async () => undefined),
  getContactCurrentMailboxId: jest.fn(async () => 'their-mailbox-id'),
}));
const mockSaveSenderKey = jest.fn(async (..._a: unknown[]) => undefined);
jest.mock('../../crypto/channelKeyStore', () => ({
  __esModule: true,
  saveSenderKey: (...a: unknown[]) => mockSaveSenderKey(...a),
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
    aegisId: deriveAegisId(box.publicKey), // real format: URL-safe, ID<->key bound
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


function foreignPeerBundleVia(peer: Identity) {
  const spk = nacl.box.keyPair();
  const sig = nacl.sign.detached(spk.publicKey, peer.signingSecretKey);
  mockForeignRelayHttp.mockImplementation(async (_relay: unknown, path: unknown) => {
    if (String(path).startsWith('/prekeys/bundle/')) {
      return { status: 200, body: JSON.stringify({ bundle: {
        identityKeyB64: peer.publicKeyB64,
        signingPublicKeyB64: peer.signingPublicKeyB64,
        signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(sig) },
        oneTimePreKey: null,
      } }) };
    }
    return { status: 404, body: '' };
  });
}

/**
 * Outgoing direction: `me` already holds an established (post-X3DH) session
 * with `peer`, so the sealed v2 wire is selectable. Cross-relay FIRST contact
 * (x3dhInit over the mailbox) is slice F3b — see docs/FEDERATION-DESIGN.md.
 */
function establishOutgoingSession(me: Identity, peer: Identity): void {
  const spk = nacl.box.keyPair();
  const root = nacl.randomBytes(32);
  const sender = initRatchet(root, spk.publicKey, true);
  delete sender.x3dhInit;
  sender.createdAtMs = Date.now() - 120_000;
  persistSession(peer.aegisId, sender);
  void me;
}

describe('federation F3 — foreign contacts: sealed control plane + group re-key', () => {
  let client: typeof import('../client');

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockContactsState.contacts = [];
    mockIdentityState.identity = null;
    mockAppend.mockClear();
    mockUpdateDelivery.mockClear();
    mockSaveSenderKey.mockClear();
    mockSendViaForeignRelay.mockClear();
    mockForeignRelayHttp.mockReset();
    client = require('../client') as typeof import('../client');
  });

  afterEach(() => { client.disconnect(); });

  it('typing to a foreign contact never emits the plaintext event; it goes sealed through their relay', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, relayOnion: ONION }];
    establishOutgoingSession(me, peer);

    mockFakeSocket.emit.mockClear();
    client.emitTyping(peer.aegisId, true);
    for (let i = 0; i < 20; i++) await flush();

    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events).not.toContain('typing');
    expect(events).not.toContain('envelope');
    expect(events).not.toContain('envelope:v2');
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
    const [relay, env] = mockSendViaForeignRelay.mock.calls[0] as unknown as [{ onion: string }, { to: string; ciphertext: string }];
    expect(relay.onion).toBe(ONION);
    expect(env.to).toBe('their-mailbox-id');
    expect(JSON.stringify(env)).not.toContain(peer.aegisId); // no identity on the foreign wire
    expect(events).not.toContain('prekeys:fetch');
  });

  it('a first X3DH for a foreign contact fetches the bundle from THEIR relay, never our control socket', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, relayOnion: ONION }];
    foreignPeerBundleVia(peer);

    mockFakeSocket.emit.mockClear();
    client.emitTyping(peer.aegisId, true);
    for (let i = 0; i < 20; i++) await flush();

    expect(mockForeignRelayHttp).toHaveBeenCalledWith(expect.objectContaining({ onion: ONION }), `/prekeys/bundle/${peer.aegisId}`);
    expect(mockFakeSocket.emit.mock.calls.map((c) => c[0])).not.toContain('prekeys:fetch');
    // The very first wire after X3DH bootstraps INSIDE the sealed v2 through
    // their relay (F3b — see client.firstContact.test.ts); nothing leaves on the
    // aegisId socket.
    expect(mockFakeSocket.emit.mock.calls.map((c) => c[0])).not.toContain('envelope');
    expect(mockFakeSocket.emit.mock.calls.map((c) => c[0])).not.toContain('envelope:v2');
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
  });

  it('read receipts to a foreign contact ride the same sealed path (no msg:read)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, relayOnion: ONION }];
    establishOutgoingSession(me, peer);

    mockFakeSocket.emit.mockClear();
    client.sendReadReceipts(peer.aegisId, ['m1', 'm2']);
    for (let i = 0; i < 20; i++) await flush();

    expect(mockFakeSocket.emit.mock.calls.map((c) => c[0])).not.toContain('msg:read');
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
  });

  it('typing and read receipts to a LOCAL contact go sealed too, even with the mailbox off (R-1)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    establishOutgoingSession(me, peer);

    mockFakeSocket.emit.mockClear();
    client.emitTyping(peer.aegisId, true);
    client.sendReadReceipts(peer.aegisId, ['m1', 'm2']);
    for (let i = 0; i < 20; i++) await flush();

    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events).not.toContain('typing');
    expect(events).not.toContain('msg:read');
    // Both left as ratchet-encrypted envelopes on our own relay.
    expect(events.filter((e) => e === 'envelope' || e === 'envelope:v2').length).toBe(2);
    expect(mockSendViaForeignRelay).not.toHaveBeenCalled();
  });

  it('never listens for relay-stamped plaintext typing / msg:read (a relay could forge them)', async () => {
    client.connect(buildIdentity());
    bringOnline();
    await flush();
    expect(mockFakeSocket.handlers.has('typing')).toBe(false);
    expect(mockFakeSocket.handlers.has('msg:read')).toBe(false);
    expect(mockFakeSocket.handlers.has('msg:delete')).toBe(false);
  });

  it('group re-key: local member via group:rekey, foreign member via a sealed sender_key_dist', async () => {
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
    establishOutgoingSession(me, foreign);
    mockFakeSocket.emit.mockImplementation((event: string, _payload: unknown, ack?: (a: unknown) => void) => {
      if (event === 'group:rekey' && typeof ack === 'function') ack({ ok: true });
    });

    await client.rekeyGroupAfterRemoval(me, 'group-1', [me.aegisId, local.aegisId, foreign.aegisId]);
    for (let i = 0; i < 20; i++) await flush();

    const rekey = mockFakeSocket.emit.mock.calls.find((c) => c[0] === 'group:rekey');
    expect(rekey).toBeDefined();
    const dists = (rekey![1] as { distributions: Array<{ aegisId: string }> }).distributions;
    expect(dists.map((d) => d.aegisId)).toEqual([local.aegisId]); // the foreign member is NOT in the relay-local queue
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
    expect((mockSendViaForeignRelay.mock.calls[0] as unknown as [unknown, { to: string }])[1].to).toBe('their-mailbox-id');
    expect(mockSaveSenderKey).toHaveBeenCalledWith('group-1', me.aegisId, expect.anything()); // our own copy persisted first
  });

  it('an incoming sender_key_dist is opened against the authenticated sender, saved, never appended', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, relayOnion: ONION }];
    const senderState = establishSyncedSession(me, peer);

    const sk = generateSenderKey();
    const [box] = await sealSenderKeyForRecipients(sk, 'group-9', peer.aegisId, peer.secretKeyB64, [{ aegisId: me.aegisId, publicKeyB64: me.publicKeyB64 }]);
    const payload = JSON.stringify({ type: 'sender_key_dist', text: JSON.stringify({ groupId: 'group-9', ciphertextB64: box!.ciphertextB64, nonceB64: box!.nonceB64, iteration: box!.iteration }) });
    const { envelope } = encryptMessage(payload, peer.aegisId, me.publicKey, peer.secretKey, senderState);

    await mockFakeSocket.handlers.get('envelope')!({ id: 'env-skd-1', from: peer.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 });
    await flush();

    expect(mockSaveSenderKey).toHaveBeenCalledTimes(1);
    const [groupId, senderId, saved] = mockSaveSenderKey.mock.calls[0] as unknown as [string, string, { chainKey: Uint8Array; iteration: number }];
    expect(groupId).toBe('group-9');
    expect(senderId).toBe(peer.aegisId);
    expect(Array.from(saved.chainKey)).toEqual(Array.from(sk.chainKey));
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('a sender_key_dist box sealed by SOMEONE ELSE is rejected (sender must match the sealed-sender)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    const impostor = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, relayOnion: ONION }];
    const senderState = establishSyncedSession(me, peer);

    const sk = generateSenderKey();
    const [box] = await sealSenderKeyForRecipients(sk, 'group-9', impostor.aegisId, impostor.secretKeyB64, [{ aegisId: me.aegisId, publicKeyB64: me.publicKeyB64 }]);
    const payload = JSON.stringify({ type: 'sender_key_dist', text: JSON.stringify({ groupId: 'group-9', ciphertextB64: box!.ciphertextB64, nonceB64: box!.nonceB64, iteration: 0 }) });
    const { envelope } = encryptMessage(payload, peer.aegisId, me.publicKey, peer.secretKey, senderState);
    await mockFakeSocket.handlers.get('envelope')!({ id: 'env-skd-2', from: peer.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 });
    await flush();
    expect(mockSaveSenderKey).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
