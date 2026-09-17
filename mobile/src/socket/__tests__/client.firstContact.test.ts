/**
 * Federation F3b — FIRST contact across relays (docs/FEDERATION-DESIGN.md D3b).
 *
 * Same-relay first contact bootstraps over v1 (aegisId-addressed, `init` hint).
 * A contact on ANOTHER relay has no v1 path, so the very first message must be
 * the sealed v2 wire itself:
 *   - sender: fresh X3DH (bundle fetched from THEIR relay) → v2 through the
 *     relay pool, x3dh init + first-contact block (identity key, home relay,
 *     mailbox root) sealed inside, signing key embedded for TOFU;
 *   - receiver: an unknown sender's bootstrap creates a PENDING contact bound to
 *     the claimed id (ID↔key), pinned to the embedded signing key, with the
 *     relay + mailbox root needed to answer — then decrypts and appends;
 *   - a retry from the outbox and the profile hand-off never touch the home
 *     socket for a foreign contact.
 *
 * Harness mirrors client.federationControlPlane.test.ts.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { encryptMessageV2, openEnvelopeV2 } from '../../crypto/messaging';
import { performX3DH } from '../../crypto/signal/x3dh';
import { initRatchet } from '../../crypto/signal/ratchet';
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

/**
 * Build a genuine first-contact v2 wire from `alice` (a stranger on ONION) to
 * `me`, as the real sender would: X3DH against `me`'s bundle, then the sealed
 * v2 with x3dh + fc + embedded signing key. Registers `me`'s SPK secret so the
 * receiver can complete the handshake.
 */
function strangerBootstrapWire(alice: Identity, me: Identity, text: string) {
  const spk = nacl.box.keyPair();
  mockSpkSecrets.set(1, encodeBase64(spk.secretKey));
  const bundle = {
    identityKeyB64: me.publicKeyB64,
    signingPublicKeyB64: me.signingPublicKeyB64,
    signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(nacl.sign.detached(spk.publicKey, me.signingSecretKey)) },
    oneTimePreKey: null,
  };
  const x = performX3DH(alice, bundle);
  const state = initRatchet(x.rootKey, spk.publicKey, true);
  state.x3dhInit = { aliceEKB64: x.myEphemeralPublicKeyB64, spkId: 1, opkId: null };
  const root = encodeBase64(nacl.randomBytes(32));
  const payload = JSON.stringify({ type: 'text', text });
  const { wire } = encryptMessageV2(payload, alice.aegisId, me.publicKey, alice.signingSecretKey, state, Date.now(), {
    block: { ik: alice.publicKeyB64, relay: ONION, root },
    senderSigningPublicKey: alice.signingPublicKey,
  });
  return { wire, root };
}

describe('federation F3b — first contact across relays', () => {
  let client: typeof import('../client');

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockSpkSecrets.clear();
    mockContactsState.contacts = [];
    mockIdentityState.identity = null;
    mockAppend.mockClear();
    mockSaveContact.mockClear();
    mockEnqueueOutboxJob.mockClear();
    mockSetContactMailboxRoot.mockClear();
    mockSendViaForeignRelay.mockClear();
    mockForeignRelayHttp.mockReset();
    client = require('../client') as typeof import('../client');
  });

  afterEach(() => { client.disconnect(); });

  it('sender: the FIRST message to a foreign contact is a sealed v2 bootstrap through their relay (x3dh + fc + TOFU key)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    // Added from a v2 link: relay + (elsewhere) mailbox root known, no session yet.
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, relayOnion: ONION }];
    foreignPeerBundleVia(peer);

    mockFakeSocket.emit.mockClear();
    await client.sendMessage({ identity: me, recipientAegisId: peer.aegisId, recipientPublicKey: peer.publicKey, plaintext: 'hola', skipLocalAppend: true });
    await settle();

    // Bundle came from THEIR relay; nothing about them left on our socket.
    expect(mockForeignRelayHttp).toHaveBeenCalledWith(expect.objectContaining({ onion: ONION }), `/prekeys/bundle/${peer.aegisId}`);
    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    // The only prekeys:fetch allowed on our socket is for OUR OWN devices
    // (multi-device self-copy) — never the foreign peer's id.
    for (const c of mockFakeSocket.emit.mock.calls) {
      if (c[0] === 'prekeys:fetch') expect(JSON.stringify(c[1])).not.toContain(peer.aegisId);
    }
    expect(events).not.toContain('envelope');
    expect(events).not.toContain('envelope:v2');
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
    const [relay, env] = mockSendViaForeignRelay.mock.calls[0] as unknown as [{ onion: string }, { id: string; to: string; ciphertext: string; nonce: string; epk: string }];
    expect(relay.onion).toBe(ONION);
    expect(env.to).toBe('their-mailbox-id');
    expect(Object.keys(env).sort()).toEqual(['ciphertext', 'epk', 'id', 'nonce', 'to']); // no from, no token
    expect(JSON.stringify(env)).not.toContain(me.aegisId);

    // The peer — who has never heard of us — can open it as a bootstrap, and ONLY as one.
    const unknown = () => null;
    expect(openEnvelopeV2({ ciphertext: env.ciphertext, nonce: env.nonce, epk: env.epk }, peer.secretKey, unknown, Date.now())).toBeNull();
    const inner = openEnvelopeV2({ ciphertext: env.ciphertext, nonce: env.nonce, epk: env.epk }, peer.secretKey, unknown, Date.now(), { allowFirstContact: true });
    expect(inner).not.toBeNull();
    expect(inner!.from).toBe(me.aegisId);
    expect(inner!.tofuSigningKeyB64).toBe(me.signingPublicKeyB64);
    expect(inner!.x3dh).toEqual(expect.objectContaining({ spkId: 1, opkId: null }));
    expect(inner!.fc).toEqual({ ik: me.publicKeyB64, relay: null, root: MY_ROOT }); // home relay = official until F5

    // The pending init was consumed: the next message is a plain established v2.
    expect(JSON.parse(mockRatchetSessions.get(peer.aegisId)!).x3dhInit).toBeUndefined();
  });

  it('receiver: a stranger\'s bootstrap creates a PENDING contact (ID↔key bound, TOFU pinned, relay + root kept) and decrypts', async () => {
    const me = buildIdentity();
    const alice = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    const { wire, root } = strangerBootstrapWire(alice, me, 'hola desde otro relay');

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope:v2')!({ id: 'env-fc-1', to: me.aegisId, ciphertext: wire.ciphertext, nonce: wire.nonce, epk: wire.epk, createdAt: Date.now() });
    await settle();

    // Contact created as a message request on THEIR relay, keys from the block.
    expect(mockSaveContact).toHaveBeenCalledTimes(1);
    const created = mockSaveContact.mock.calls[0][0] as MockContact;
    expect(created).toEqual(expect.objectContaining({
      aegisId: alice.aegisId,
      publicKeyB64: alice.publicKeyB64,
      signingPublicKeyB64: alice.signingPublicKeyB64,
      pending: true,
      verified: false,
      relayOnion: ONION,
    }));
    expect(mockSetContactMailboxRoot).toHaveBeenCalledWith(alice.aegisId, root);
    expect(mockContactsState.contacts.map((c) => c.aegisId)).toEqual([alice.aegisId]);

    // Decrypted, appended, acked (persisted) — and a receiver session now exists.
    expect(mockAppend).toHaveBeenCalledTimes(1);
    const appended = mockAppend.mock.calls[0] as unknown[];
    expect(JSON.stringify(appended)).toContain('hola desde otro relay');
    expect(mockFakeSocket.emit).toHaveBeenCalledWith('envelope:ack', { id: 'env-fc-1' });
    expect(mockRatchetSessions.has(alice.aegisId)).toBe(true);

    // Our profile hand-off goes back through THEIR relay on that session — never
    // as a v1 `envelope` on our home socket.
    expect(mockSendViaForeignRelay).toHaveBeenCalledTimes(1);
    expect((mockSendViaForeignRelay.mock.calls[0] as unknown as [{ onion: string }])[0].onion).toBe(ONION);
    expect(mockFakeSocket.emit.mock.calls.map((c) => c[0])).not.toContain('envelope');
  });

  it('receiver: a bootstrap whose identity key does not match the claimed id is dropped, no contact created', async () => {
    const me = buildIdentity();
    const alice = buildIdentity();
    const impostor = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    // Claims alice's id but carries the impostor's identity key in the block.
    const forged: Identity = { ...impostor, aegisId: alice.aegisId } as Identity;
    const { wire } = strangerBootstrapWire(forged, me, 'soy alice');

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope:v2')!({ id: 'env-fc-2', to: me.aegisId, ciphertext: wire.ciphertext, nonce: wire.nonce, epk: wire.epk, createdAt: Date.now() });
    await settle();

    expect(mockSaveContact).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockContactsState.contacts).toEqual([]);
    expect(mockFakeSocket.emit).toHaveBeenCalledWith('envelope:ack', { id: 'env-fc-2' }); // deliberate discard
  });

  it('receiver: a stranger who is NOT bootstrapping (no fc) is still rejected and left for retry', async () => {
    const me = buildIdentity();
    const alice = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    // Established-style v2 (no x3dh/fc) from someone we do not know.
    const spk = nacl.box.keyPair();
    const state = initRatchet(nacl.randomBytes(32), spk.publicKey, true);
    delete state.x3dhInit;
    const { wire } = encryptMessageV2(JSON.stringify({ type: 'text', text: 'x' }), alice.aegisId, me.publicKey, alice.signingSecretKey, state, Date.now());

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope:v2')!({ id: 'env-fc-3', to: me.aegisId, ciphertext: wire.ciphertext, nonce: wire.nonce, epk: wire.epk, createdAt: Date.now() });
    await settle();

    expect(mockSaveContact).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockFakeSocket.emit).not.toHaveBeenCalledWith('envelope:ack', expect.anything()); // retry, relay keeps its copy
  });

  it('sender: a foreign contact\'s message never leaks to the home socket even when their relay is down (parked for retry)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me);
    bringOnline();
    await flush();
    mockIdentityState.identity = me;
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, relayOnion: ONION }];
    foreignPeerBundleVia(peer);
    mockSendViaForeignRelay.mockResolvedValueOnce(null as unknown as { ok: boolean; queued: boolean });

    mockFakeSocket.emit.mockClear();
    await expect(client.sendMessage({ identity: me, recipientAegisId: peer.aegisId, recipientPublicKey: peer.publicKey, plaintext: 'hola', skipLocalAppend: true })).rejects.toThrow('foreign_relay_unreachable');
    await settle();

    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events).not.toContain('envelope');
    expect(events).not.toContain('envelope:v2');
    expect(mockEnqueueOutboxJob).toHaveBeenCalledTimes(1); // job retained for the scheduler
  });
});
