/**
 * One-sided Double Ratchet desync recovery (mobile/src/socket/client.ts).
 *
 * REGRESSION for the on-device DEADLOCK the symmetric-nudge design missed.
 *
 * Live evidence (two emulators on prod relay):
 *   - A = lower aegisId (NON-initiator / "nudge" role).
 *   - B = higher aegisId (canonical INITIATOR).
 *   - Only A's RECEIVE chain is broken (one-sided desync — A's session rolled
 *     back / partially persisted). A's SEND chain still matches B's RECEIVE
 *     chain, so any nudge A emits DECRYPTS FINE on B.
 *
 * Old protocol: A's nudge decrypts on B → B never detects desync → B never
 * re-keys → A wedged forever (inbound undecryptable, outbox never flushes). The
 * initiator has RECOVERY_FALLBACK_MS; the non-initiator had NO fallback.
 *
 * Fix asserted here (mirrors Session/SimpleX in-band session-reset message):
 *   - HALF 1 (initiator honours reset): when B decrypts a nudge whose payload
 *     carries the AUTHENTICATED `sessionReset` flag (MAC + sealed-sender
 *     verified, never a wire field), B force-runs its INITIATE branch (delete +
 *     fresh X3DH) EVEN THOUGH its own decrypt succeeded, and emits an `init`.
 *   - HALF 2 (authentication guard): a lower peer that receives the same flag
 *     does NOT re-key (avoids a re-key ping-pong / DoS).
 *
 * Everything is mocked: no network, no SecureStore writes, no SQLite.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { encryptMessage } from '../../crypto/messaging';
import { initRatchet, type RatchetState } from '../../crypto/signal/ratchet';
import { performX3DH } from '../../crypto/signal/x3dh';

// ── db/local mock with an in-memory ratchet session store ────────────────────
const mockRatchetSessions = new Map<string, string>();
const mockDeleteSpy = jest.fn(async (aegisId: string) => {
  mockRatchetSessions.delete(aegisId);
});
const mockSaveSpy = jest.fn(async (aegisId: string, json: string) => {
  mockRatchetSessions.set(aegisId, json);
});

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async (aegisId: string) => mockRatchetSessions.get(aegisId) ?? null),
  saveRatchetSession: (aegisId: string, json: string) => mockSaveSpy(aegisId, json),
  deleteContactRatchetSession: (aegisId: string) => mockDeleteSpy(aegisId),
  saveContact: jest.fn(async () => undefined),
  getActiveDbSlot: () => 'self',
  getGroup: jest.fn(async () => null),
  saveGroup: jest.fn(async () => undefined),
  loadOutboxJobs: jest.fn(async () => []),
  enqueueOutboxJob: jest.fn(async () => undefined),
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

const mockSecure = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  __esModule: true,
  getItemAsync: jest.fn(async (k: string) => mockSecure.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => { mockSecure.set(k, v); }),
  deleteItemAsync: jest.fn(async (k: string) => { mockSecure.delete(k); }),
  AFTER_FIRST_UNLOCK: 'afu',
}));
let mockUuidCounter = 0;
jest.mock('expo-crypto', () => ({ __esModule: true, randomUUID: () => `uuid-${mockUuidCounter++}` }));
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
  nextBundle?: unknown;
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
          ack(mockFakeSocket.nextBundle ? { ok: true, bundle: mockFakeSocket.nextBundle } : { ok: false, error: 'not_found' });
        }
      }),
    };
    return mockFakeSocket;
  },
}));

import type { Identity } from '../../crypto/identity';
import { deriveAegisId } from '../../crypto/identity';

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
  };
}

/**
 * Persist an ESTABLISHED bidirectional session for `me` against `peer` and
 * return a wire nudge envelope carrying `sessionReset: true` that `me` CAN
 * decrypt over that session. Models the moment the peer's non-initiator has
 * escalated to a reset request and it arrives at `me`. `me` is the SPK holder
 * (X3DH receiver) and `peer` is the initiator, matching real nudge geometry.
 */
function buildResetNudge(me: Identity, peer: Identity) {
  const spk = nacl.box.keyPair();
  const sig = nacl.sign.detached(spk.publicKey, me.signingSecretKey);
  mockSecure.set('aegis.spkSecret.b64', encodeBase64(spk.secretKey));
  const bundle = {
    identityKeyB64: me.publicKeyB64,
    signingPublicKeyB64: me.signingPublicKeyB64,
    signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(sig) },
    oneTimePreKey: null,
  };
  // `peer` (the requester) is Alice; it sends the nudge over an ESTABLISHED
  // session (no x3dh header on the wire — a normal ratchet message).
  const x3dh = performX3DH(peer, bundle);
  const peerSender = initRatchet(x3dh.rootKey, decodeBase64(bundle.signedPreKey.publicKeyB64), true);
  delete peerSender.x3dhInit; // NUDGE, not an init

  // `me` holds the matching Bob session so it can decrypt the nudge.
  const spkPub = nacl.scalarMult.base(spk.secretKey);
  const meSession = initRatchet(x3dh.rootKey, decodeBase64(bundle.signedPreKey.publicKeyB64), false, {
    publicKey: spkPub,
    secretKey: spk.secretKey,
  });
  delete meSession.x3dhInit;
  meSession.createdAtMs = Date.now() - 120_000;
  const serial = {
    RK: Array.from(meSession.RK),
    DHs: { publicKey: Array.from(meSession.DHs.publicKey), secretKey: Array.from(meSession.DHs.secretKey) },
    DHr: meSession.DHr ? Array.from(meSession.DHr) : null,
    CKs: meSession.CKs ? Array.from(meSession.CKs) : null,
    CKr: meSession.CKr ? Array.from(meSession.CKr) : null,
    Ns: meSession.Ns, Nr: meSession.Nr, PN: meSession.PN,
    MKSKIPPED: [],
    createdAtMs: meSession.createdAtMs,
  };
  mockRatchetSessions.set(peer.aegisId, JSON.stringify(serial));

  const resetPayload = JSON.stringify({
    type: 'profile_update',
    senderName: 'Tester',
    senderColor: '#000',
    senderStatus: '',
    sessionReset: true,
  });
  const { envelope } = encryptMessage(resetPayload, peer.aegisId, me.publicKey, peer.secretKey, peerSender);
  return {
    env: { id: 'env-reset', from: peer.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 },
  };
}

function bringOnline() {
  mockFakeSocket.handlers.get('connect')!();
  mockFakeSocket.handlers.get('auth:ok')!({ opkCount: 100 });
}

function setBundle(peer: Identity) {
  const spk = nacl.box.keyPair();
  const sig = nacl.sign.detached(spk.publicKey, peer.signingSecretKey);
  mockFakeSocket.nextBundle = {
    identityKeyB64: peer.publicKeyB64,
    signingPublicKeyB64: peer.signingPublicKeyB64,
    signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(sig) },
    oneTimePreKey: null,
  };
}

describe('one-sided ratchet desync — authenticated session-reset request', () => {
  let connect: typeof import('../client').connect;

  beforeEach(() => {
    jest.resetModules();
    mockUuidCounter = 0;
    mockRatchetSessions.clear();
    mockSecure.clear();
    mockContactsState.contacts = [];
    mockDeleteSpy.mockClear();
    mockSaveSpy.mockClear();
    connect = (require('../client') as typeof import('../client')).connect;
  });

  afterEach(() => {
    (require('../client') as typeof import('../client')).disconnect();
  });

  /** me = HIGHER (initiator); peer = LOWER (the reset requester). */
  function makeHigherAndLower(): { me: Identity; peer: Identity } {
    let a = buildIdentity();
    let b = buildIdentity();
    if (a.aegisId < b.aegisId) { const t = a; a = b; b = t; }
    return { me: a, peer: b };
  }

  it('the INITIATOR (higher aegisId) re-keys on an authenticated sessionReset even though its own decrypt succeeded', async () => {
    const { me, peer } = makeHigherAndLower();
    expect(me.aegisId > peer.aegisId).toBe(true); // me is the canonical initiator

    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockContactsState.contacts = [
      { aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 },
    ];
    setBundle(peer);

    const { env } = buildResetNudge(me, peer);

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope')!(env);
    await new Promise((r) => setImmediate(r));

    // The reset request decrypted fine (our own detector never fired), yet we
    // deleted the dead session and emitted a FRESH X3DH init to the requester.
    expect(mockDeleteSpy).toHaveBeenCalledWith(peer.aegisId);
    const initEmit = mockFakeSocket.emit.mock.calls.find(
      (c) => c[0] === 'envelope' && c[1]?.to === peer.aegisId && c[1]?.init === true,
    );
    expect(initEmit).toBeDefined();
  });

  it('a NON-initiator (lower aegisId) IGNORES a sessionReset request — no re-key ping-pong', async () => {
    // me = LOWER, peer = HIGHER: invert the ordering.
    let me = buildIdentity();
    let peer = buildIdentity();
    if (me.aegisId > peer.aegisId) { const t = me; me = peer; peer = t; }
    expect(me.aegisId < peer.aegisId).toBe(true);

    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockContactsState.contacts = [
      { aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 },
    ];
    setBundle(peer);

    const { env } = buildResetNudge(me, peer);

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope')!(env);
    await new Promise((r) => setImmediate(r));

    // Non-initiator must NOT delete/re-key on a reset request (that peer should be
    // adopting OUR init). Guards against a reset ping-pong between two peers.
    expect(mockDeleteSpy).not.toHaveBeenCalledWith(peer.aegisId);
  });
});
