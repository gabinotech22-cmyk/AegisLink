/**
 * Sealed transport for contacts on OUR relay (FEDERATION-DESIGN D6 + Fase 6
 * client side), gated by announced capabilities (net/caps.ts):
 *
 *   - calls: a local contact that announced `sealed-calls` gets the same
 *     transient sealed `call_signal` a foreign one gets — through OUR mailbox
 *     socket, `wakeHint: 'call'` on invites — and the relay never sees a
 *     `call:*` event with `to`. Without the cap, or with the mailbox down, the
 *     relay-visible event goes out exactly as before (a call always rings).
 *   - messages: holding a local contact's mailbox root (with our mailbox up)
 *     means sealed v2 — first contact included (`fc` bootstrap) — and a
 *     `queued` mailbox ack is terminal because a tokenless v2 has no aegisId
 *     transport to fall through to. Without a root: v1 as before.
 *
 * Harness mirrors client.callSignal.test.ts with MAILBOX_ENABLED on and the
 * mailbox socket mocked.
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
  relayOnion?: string | null; pending?: boolean; name?: string; verified?: boolean; caps?: string[] | null;
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
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'http://localhost', SEALED_TRANSPORT_VERSION: 'v2', MAILBOX_ENABLED: true, ONION_URL: null, FEDERATION: true }));
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
/** Which local contacts we hold a mailbox root for (sealedLocal precondition). */
const mockRoots = new Set<string>();
jest.mock('../../crypto/mailboxStore', () => ({
  __esModule: true,
  getOwnMailboxRootB64: jest.fn(async () => MY_ROOT),
  setContactMailboxRoot: (...a: unknown[]) => mockSetContactMailboxRoot(...a),
  getContactMailboxRoot: jest.fn(async (id: string) => (mockRoots.has(id) ? new Uint8Array(32) : null)),
  getContactCurrentMailboxId: jest.fn(async (id: string) => (mockRoots.has(id) ? `mbx-${id.slice(0, 6)}` : null)),
}));
const mockMailboxAuthed = { value: true };
const mockSendViaMailbox = jest.fn(async (..._a: unknown[]) => ({ ok: true, queued: true } as { ok: boolean; queued?: boolean; delivered?: boolean }));
jest.mock('../mailboxSocket', () => ({
  __esModule: true,
  isMailboxAuthed: () => mockMailboxAuthed.value,
  sendViaMailbox: (...a: unknown[]) => mockSendViaMailbox(...a),
  mailboxAckConfirmsDelivery: (ack: { ok?: boolean; delivered?: boolean } | null) => !!ack && ack.ok === true && ack.delivered === true,
  connectMailboxSocket: jest.fn(),
  disconnectMailboxSocket: jest.fn(),
  fetchMailboxOverTor: jest.fn(async () => 0),
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
import { serializeRatchetState } from '../ratchetSerde';

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
  mockRatchetSessions.set(aegisId, serializeRatchetState(state));
}

/** Healthy synced pair: returns the peer's sender state; `me` holds the receiver state. */
function establishSyncedSession(peer: Identity): RatchetState {
  const spk = nacl.box.keyPair();
  const root = nacl.randomBytes(32);
  const sender = initRatchet('self', root, spk.publicKey, true);
  delete sender.x3dhInit;
  const receiver = initRatchet('self', root, sender.info.dhsPublicKey, false, spk);
  delete receiver.x3dhInit;
  receiver.createdAtMs = Date.now() - 120_000;
  persistSession(peer.aegisId, receiver);
  return sender;
}

/** Outgoing: `me` already holds an established session with `peer`. */
function establishOutgoingSession(peer: Identity): void {
  const spk = nacl.box.keyPair();
  const sender = initRatchet('self', nacl.randomBytes(32), spk.publicKey, true);
  delete sender.x3dhInit;
  sender.createdAtMs = Date.now() - 120_000;
  persistSession(peer.aegisId, sender);
}

type OnSocket = { on: (e: string, cb: (...a: unknown[]) => void) => unknown };

describe('sealed transport to contacts on our relay (caps-gated)', () => {
  let client: typeof import('../client');
  let router: typeof import('../callSignalRouter');

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockSpkSecrets.clear();
    mockRoots.clear();
    mockMailboxAuthed.value = true;
    mockContactsState.contacts = [];
    mockIdentityState.identity = null;
    mockAppend.mockClear();
    mockSaveContact.mockClear();
    mockEnqueueOutboxJob.mockClear();
    mockSendViaMailbox.mockClear();
    mockUpdateDelivery.mockClear();
    mockSendViaForeignRelay.mockClear();
    mockForeignRelayHttp.mockReset();
    client = require('../client') as typeof import('../client');
    router = require('../callSignalRouter') as typeof import('../callSignalRouter');
  });

  afterEach(() => { router.clearCallSignalHandlers(); client.disconnect(); });

  function online(me: Identity) {
    client.connect(me);
    bringOnline();
    mockIdentityState.identity = me;
  }

  it('calls: local peer with `sealed-calls` + reachable mailbox → sealed call_signal via our mailbox, wakeHint on invite, never a call:* event', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    online(me);
    await flush();
    mockContactsState.contacts = [
      { aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64, caps: ['sealed-calls'] },
    ];
    mockRoots.add(peer.aegisId);
    establishOutgoingSession(peer);
    mockFakeSocket.emit.mockClear();

    expect(router.routeCallSignal(mockFakeSocket, 'call:invite:v2', peer.aegisId, { callId: 'c1', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' })).toBe(true);
    expect(router.routeCallSignal(mockFakeSocket, 'call:ice:v2', peer.aegisId, { callId: 'c1', ciphertext: 'i', nonce: 'n' })).toBe(true);
    await settle();

    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events.filter((e) => e.startsWith('call:'))).toEqual([]);
    expect(events).not.toContain('envelope');
    expect(events).not.toContain('envelope:v2');
    expect(mockSendViaMailbox).toHaveBeenCalledTimes(2);
    const [invite, ice] = mockSendViaMailbox.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(invite.to).toBe(`mbx-${peer.aegisId.slice(0, 6)}`);
    expect(invite.wakeHint).toBe('call');
    expect(ice.wakeHint).toBeUndefined();
    expect(JSON.stringify(invite)).not.toContain(me.aegisId);
    expect(mockEnqueueOutboxJob).not.toHaveBeenCalled(); // transient
  });

  it('calls: no cap → the relay-visible event as before; cap but mailbox down → same legacy event (a call always rings)', async () => {
    const me = buildIdentity();
    const legacy = buildIdentity();
    const capable = buildIdentity();
    online(me);
    await flush();
    mockContactsState.contacts = [
      { aegisId: legacy.aegisId, publicKeyB64: legacy.publicKeyB64, signingPublicKeyB64: legacy.signingPublicKeyB64 },
      { aegisId: capable.aegisId, publicKeyB64: capable.publicKeyB64, signingPublicKeyB64: capable.signingPublicKeyB64, caps: ['sealed-calls'] },
    ];
    mockRoots.add(capable.aegisId);
    mockFakeSocket.emit.mockClear();

    router.routeCallSignal(mockFakeSocket, 'call:invite:v2', legacy.aegisId, { callId: 'c2', ciphertext: 'x', nonce: 'y' });
    await settle();
    expect(mockFakeSocket.emit).toHaveBeenCalledWith('call:invite:v2', { callId: 'c2', ciphertext: 'x', nonce: 'y', to: legacy.aegisId });

    mockFakeSocket.emit.mockClear();
    mockMailboxAuthed.value = false;
    router.routeCallSignal(mockFakeSocket, 'call:invite:v2', capable.aegisId, { callId: 'c3', ciphertext: 'x', nonce: 'y' });
    await settle();
    expect(mockFakeSocket.emit).toHaveBeenCalledWith('call:invite:v2', { callId: 'c3', ciphertext: 'x', nonce: 'y', to: capable.aegisId });
    expect(mockSendViaMailbox).not.toHaveBeenCalled();
  });

  it('calls: fan-out items — capable local member gets its own sealed copy, the rest stay in one emit; mailbox down → its item in fan-out shape', async () => {
    const me = buildIdentity();
    const a = buildIdentity();
    const b = buildIdentity();
    online(me);
    await flush();
    mockContactsState.contacts = [
      { aegisId: a.aegisId, publicKeyB64: a.publicKeyB64, signingPublicKeyB64: a.signingPublicKeyB64, caps: ['sealed-calls'] },
      { aegisId: b.aegisId, publicKeyB64: b.publicKeyB64, signingPublicKeyB64: b.signingPublicKeyB64 },
    ];
    mockRoots.add(a.aegisId);
    establishOutgoingSession(a);
    mockFakeSocket.emit.mockClear();

    router.routeCallSignalItems(mockFakeSocket, 'group_call:channel', { callId: 'g1', groupId: 'grp' }, [
      { to: a.aegisId, ciphertext: 'ca', nonce: 'na' },
      { to: b.aegisId, ciphertext: 'cb', nonce: 'nb' },
    ]);
    await settle();
    expect(mockFakeSocket.emit).toHaveBeenCalledWith('group_call:channel', { callId: 'g1', groupId: 'grp', items: [{ to: b.aegisId, ciphertext: 'cb', nonce: 'nb' }] });
    expect(mockSendViaMailbox).toHaveBeenCalledTimes(1);

    mockFakeSocket.emit.mockClear();
    mockSendViaMailbox.mockClear();
    mockMailboxAuthed.value = false;
    router.routeCallSignalItems(mockFakeSocket, 'group_call:channel', { callId: 'g2', groupId: 'grp' }, [
      { to: a.aegisId, ciphertext: 'ca', nonce: 'na' },
    ]);
    await settle();
    expect(mockFakeSocket.emit).toHaveBeenCalledWith('group_call:channel', { callId: 'g2', groupId: 'grp', items: [{ to: a.aegisId, ciphertext: 'ca', nonce: 'na' }] });
    expect(mockSendViaMailbox).not.toHaveBeenCalled();
  });

  it('messages: local contact with a known mailbox root → sealed v2 through our mailbox, no delivery token, `queued` is terminal', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    online(me);
    await flush();
    mockContactsState.contacts = [
      { aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 },
    ];
    mockRoots.add(peer.aegisId);
    establishOutgoingSession(peer);
    mockFakeSocket.emit.mockClear();

    await client.sendMessage({ identity: me, recipientAegisId: peer.aegisId, recipientPublicKey: peer.publicKey, plaintext: 'hola' });
    await settle();

    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events).not.toContain('envelope');    // never v1 with a root on file
    expect(events).not.toContain('envelope:v2'); // and no tokenless aegisId v2 either
    expect(mockSendViaMailbox).toHaveBeenCalledTimes(1);
    const env = mockSendViaMailbox.mock.calls[0][0] as Record<string, unknown>;
    expect(env.to).toBe(`mbx-${peer.aegisId.slice(0, 6)}`);
    expect(env.deliveryToken).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain(me.aegisId);
    // queued ack accepted as terminal: the job is gone, no fall-through emit.
    const { deleteOutboxJob } = require('../../db/local') as { deleteOutboxJob: jest.Mock };
    expect(deleteOutboxJob).toHaveBeenCalled();
    // …and the bubble settles: without this it sat on "SENDING…" forever even
    // though the recipient had the message (seen on the 1.0.7 emulators).
    expect(mockUpdateDelivery).toHaveBeenCalledWith(peer.aegisId, env.id, 'sent');
  });

  it('messages: first contact to a local peer with a root → v2 with the fc bootstrap (never v1)', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    online(me);
    await flush();
    mockContactsState.contacts = [
      { aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: '' },
    ];
    mockRoots.add(peer.aegisId);
    // Their prekey bundle from OUR relay (home socket) for the X3DH init.
    const spk = nacl.box.keyPair();
    const sig = vault.sign(peer.signingSecretKey, spk.publicKey);
    mockFakeSocket.emit.mockImplementation((event: string, _p: unknown, ack?: (a: unknown) => void) => {
      if (event === 'prekeys:fetch' && typeof ack === 'function') {
        ack({ ok: true, bundle: {
          identityKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64,
          signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(sig) },
          oneTimePreKey: null,
        } });
      }
    });
    mockFakeSocket.emit.mockClear();

    await client.sendMessage({ identity: me, recipientAegisId: peer.aegisId, recipientPublicKey: peer.publicKey, plaintext: 'primer mensaje' });
    await settle();

    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events).not.toContain('envelope');
    expect(mockSendViaMailbox).toHaveBeenCalledTimes(1);
    const env = mockSendViaMailbox.mock.calls[0][0] as { ciphertext: string; nonce: string; epk: string };
    // The peer can open it as a first contact: sealed to its key, fc block inside.
    const { openEnvelopeV2 } = require('../../crypto/messaging') as typeof import('../../crypto/messaging');
    const inner = openEnvelopeV2({ ciphertext: env.ciphertext, nonce: env.nonce, epk: env.epk }, peer.secretKey, () => null, Date.now(), { allowFirstContact: true });
    expect(inner).not.toBeNull();
    expect(inner!.fc).toEqual({ ik: me.publicKeyB64, relay: null, root: MY_ROOT });
    expect(inner!.tofuSigningKeyB64).toBe(me.signingPublicKeyB64);
  });

  it('messages: local contact WITHOUT a root → v1 on the home socket, exactly as before', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    online(me);
    await flush();
    mockContactsState.contacts = [
      { aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 },
    ];
    establishOutgoingSession(peer);
    mockFakeSocket.emit.mockClear();

    await client.sendMessage({ identity: me, recipientAegisId: peer.aegisId, recipientPublicKey: peer.publicKey, plaintext: 'hola' });
    await settle();
    const events = mockFakeSocket.emit.mock.calls.map((c) => c[0] as string);
    expect(events).toContain('envelope');
    expect(mockSendViaMailbox).not.toHaveBeenCalled();
  });
});
