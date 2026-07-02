/**
 * Clobber regression for ratchet desync recovery (mobile/src/socket/client.ts).
 *
 * Reproduces the on-device INFINITE LOOP that the abstract glare test missed,
 * because it models the real ORDER OF SAVES/adoption — not just the abstract
 * key exchange.
 *
 * Setup (the failing on-device pairing):
 *   - `me` is the LOWER aegisId (NON-initiator / "nudge" role).
 *   - `peer` is the HIGHER aegisId (canonical INITIATOR).
 *   - The two hold a permanently-desynced Double Ratchet session.
 *
 * Old (buggy) behaviour: on desync the lower peer deleted its session and
 * getOrCreateSession built+SAVED a fresh initiator session of its OWN
 * (session-Lower, isInit=true). That overwrote the higher peer's init session
 * the lower peer was supposed to adopt → divergence → every message re-triggered
 * recovery → infinite loop.
 *
 * Fixed behaviour asserted here:
 *   1. The lower peer does NOT delete its session on desync (no re-key).
 *   2. The lower peer does NOT persist a NEW initiator session (no clobber):
 *      after recovery, the persisted session for `peer` is NOT an x3dhInit
 *      (Alice) session minted locally — it is still the (rotated) pre-existing
 *      one, until the higher peer's init is adopted.
 *   3. The lower peer EMITS a nudge (a normal envelope WITHOUT an `x3dh` header).
 *   4. When the higher peer's fresh X3DH init arrives, the lower peer ADOPTS it
 *      and the FINAL persisted session has the SAME root key as the higher
 *      peer's init → they converge.
 *
 * Everything is mocked: no network, no SecureStore writes, no SQLite.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { encryptMessage, openEnvelope } from '../../crypto/messaging';
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
  // Prekey-secret durable store: stubbed to null so the X3DH receive path falls
  // back to the SecureStore secret this test registers (its original mechanism).
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
const mockAppendSpy = jest.fn(async (_msg: { body?: string; chatId?: string }) => undefined);
jest.mock('../../store/messages', () => ({
  __esModule: true,
  useMessages: {
    getState: () => ({
      ephemeralTimer: 0,
      byChat: {},
      getEphemeralTimer: jest.fn(() => 0),
      append: (msg: { body?: string; chatId?: string }) => mockAppendSpy(msg),
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

// SecureStore: return a real SPK secret keyed by the slot key so the higher
// peer's X3DH init (which we adopt) can be received. We register the secret
// from the test once we know it.
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
      // socket.io v4 `.timeout(ms).emit(...)`: adapt the (err, ack) callback
      // to this mock's plain ack-style emit.
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
 * Persist a DESYNCED receiver session for `me` against `peer` and return a wire
 * envelope (genuinely sealed from peer → me) that opens at the outer box but
 * fails ratchetDecrypt. Mirrors buildDesyncedEnvelope in desyncRecovery.test.
 */
function buildDesyncedEnvelope(me: Identity, peer: Identity, createdAtMs: number) {
  const spk = nacl.box.keyPair();
  const sig = nacl.sign.detached(spk.publicKey, me.signingSecretKey);
  const bundle = {
    identityKeyB64: me.publicKeyB64,
    signingPublicKeyB64: me.signingPublicKeyB64,
    signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(sig) },
    oneTimePreKey: null,
  };
  const x3dh = performX3DH(peer, bundle);
  const senderState = initRatchet(x3dh.rootKey, decodeBase64(bundle.signedPreKey.publicKeyB64), true);
  delete senderState.x3dhInit;
  const { envelope } = encryptMessage('hola', peer.aegisId, me.publicKey, peer.secretKey, senderState);

  // The lower peer's persisted session is an ESTABLISHED (bidirectional) one
  // that has desynced — it MUST have a sender chain key (CKs) so the nudge
  // (encryptMessage over it) succeeds, exactly like a real session that has
  // already sent messages. We model it as an Alice session against an unrelated
  // root so its message keys don't match the higher peer (the desync), but it is
  // still fully serialisable/encryptable.
  const wrongDHr = nacl.box.keyPair();
  const wrongRoot = nacl.randomBytes(32);
  const desyncedState: RatchetState = initRatchet(wrongRoot, wrongDHr.publicKey, true);
  delete desyncedState.x3dhInit;
  desyncedState.createdAtMs = createdAtMs;
  const serial = {
    RK: Array.from(desyncedState.RK),
    DHs: { publicKey: Array.from(desyncedState.DHs.publicKey), secretKey: Array.from(desyncedState.DHs.secretKey) },
    DHr: desyncedState.DHr ? Array.from(desyncedState.DHr) : null,
    CKs: desyncedState.CKs ? Array.from(desyncedState.CKs) : null,
    CKr: desyncedState.CKr ? Array.from(desyncedState.CKr) : null,
    Ns: desyncedState.Ns, Nr: desyncedState.Nr, PN: desyncedState.PN,
    MKSKIPPED: [],
    createdAtMs: desyncedState.createdAtMs,
  };
  mockRatchetSessions.set(peer.aegisId, JSON.stringify(serial));

  return { id: 'env-desync', from: peer.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 };
}

/**
 * Build a FRESH X3DH init envelope from the higher peer (initiator) to `me`,
 * exactly as sendProfileTo/encryptMessage produce one. `me` must hold the SPK
 * secret in SecureStore (we register it) so decryptAndAppend can run the
 * receiver-side X3DH and adopt. Returns the wire envelope and the init root key.
 */
function buildInitFromHigher(higher: Identity, me: Identity, slotSpkKey: string) {
  // `me` publishes an SPK; we stash its secret so the receiver X3DH succeeds.
  const spk = nacl.box.keyPair();
  const sig = nacl.sign.detached(spk.publicKey, me.signingSecretKey);
  mockSecure.set(slotSpkKey, encodeBase64(spk.secretKey));
  const bundle = {
    identityKeyB64: me.publicKeyB64,
    signingPublicKeyB64: me.signingPublicKeyB64,
    signedPreKey: { keyId: 1, publicKeyB64: encodeBase64(spk.publicKey), signatureB64: encodeBase64(sig) },
    oneTimePreKey: null,
  };
  const x3dh = performX3DH(higher, bundle);
  // Keep the higher peer's live sender state so we can send a SECOND message
  // over the SAME converged session and prove the lower peer decrypts it.
  const senderState = initRatchet(x3dh.rootKey, decodeBase64(bundle.signedPreKey.publicKeyB64), true);
  senderState.x3dhInit = { aliceEKB64: x3dh.myEphemeralPublicKeyB64, spkId: 1, opkId: null };
  const init = JSON.stringify({ type: 'direct_msg', text: 'init-hello' });
  const { envelope, newState } = encryptMessage(init, higher.aegisId, me.publicKey, higher.secretKey, senderState);
  return {
    env: { id: 'env-init', from: higher.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 },
    senderState: newState,
    initRootKey: x3dh.rootKey,
  };
}

/** A normal (non-init) follow-up message from the higher peer over `senderState`. */
function followUpFromHigher(higher: Identity, me: Identity, senderState: RatchetState, text: string) {
  const { envelope, newState } = encryptMessage(
    JSON.stringify({ type: 'direct_msg', text }),
    higher.aegisId,
    me.publicKey,
    higher.secretKey,
    senderState,
  );
  return {
    env: { id: 'env-followup', from: higher.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 },
    senderState: newState,
  };
}

function bringOnline() {
  mockFakeSocket.handlers.get('connect')!();
  mockFakeSocket.handlers.get('auth:ok')!({ opkCount: 100 });
}

/** Decode the inner payload of an emitted envelope to inspect for an `x3dh` header. */
function openEmittedEnvelope(
  emitArgs: [string, { to: string; ciphertext: string; nonce: string }],
  recipient: Identity,
  sender: Identity,
) {
  const payload = emitArgs[1];
  return openEnvelope(
    { ciphertextB64: payload.ciphertext, nonceB64: payload.nonce },
    sender.publicKey,
    recipient.secretKey,
  );
}

describe('ratchet desync recovery — no clobber for the non-initiator (lower aegisId)', () => {
  let connect: typeof import('../client').connect;
  const SLOT_SPK_KEY = 'aegis.spkSecret.b64';

  beforeEach(() => {
    jest.resetModules();
    jest.useFakeTimers();
    mockUuidCounter = 0;
    mockRatchetSessions.clear();
    mockSecure.clear();
    mockContactsState.contacts = [];
    mockDeleteSpy.mockClear();
    mockSaveSpy.mockClear();
    mockAppendSpy.mockClear();
    connect = (require('../client') as typeof import('../client')).connect;
  });

  afterEach(() => {
    // Drop any pending recovery-fallback timer before discarding fake timers,
    // mirroring client.desyncRecovery.test.ts (see comment there).
    (require('../client') as typeof import('../client')).disconnect();
    jest.useRealTimers();
  });

  /** Order me < peer so `me` is the LOWER (non-initiator) and `peer` the higher. */
  function makeLowerAndHigher(): { me: Identity; peer: Identity } {
    let a = buildIdentity();
    let b = buildIdentity();
    if (a.aegisId > b.aegisId) { const t = a; a = b; b = t; }
    return { me: a, peer: b };
  }

  it('non-initiator nudges WITHOUT deleting or re-keying, then adopts the higher peer init → converges (no clobber)', async () => {
    const { me, peer } = makeLowerAndHigher();
    expect(me.aegisId < peer.aegisId).toBe(true); // me is the non-initiator

    connect(me);
    bringOnline();
    await Promise.resolve();
    jest.runOnlyPendingTimers();

    mockContactsState.contacts = [
      { aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 },
    ];

    // 1) A genuine-but-undecryptable message from the higher peer arrives → desync.
    //    Session was created long ago so the grace period does not apply.
    const desync = buildDesyncedEnvelope(me, peer, Date.now() - 120_000);
    const sessionBeforeRecovery = mockRatchetSessions.get(peer.aegisId);

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope')!(desync);
    await Promise.resolve();

    // ── Assertion (1): non-initiator did NOT delete its session ────────────────
    expect(mockDeleteSpy).not.toHaveBeenCalled();

    // ── Assertion (3): it EMITTED a nudge — an envelope WITHOUT an x3dh header ──
    const envelopeEmits = mockFakeSocket.emit.mock.calls.filter((c) => c[0] === 'envelope');
    expect(envelopeEmits.length).toBeGreaterThanOrEqual(1);
    const nudgeInner = openEmittedEnvelope(
      envelopeEmits[0] as [string, { to: string; ciphertext: string; nonce: string }],
      peer,
      me,
    );
    expect(nudgeInner).not.toBeNull();
    expect(nudgeInner!.x3dh).toBeUndefined(); // a NUDGE, not a fresh X3DH init

    // ── Assertion (2): the persisted session is NOT a locally-minted Alice init ─
    // (the clobber would have saved an x3dhInit session of our own here).
    const sessionAfterNudge = mockRatchetSessions.get(peer.aegisId);
    expect(sessionAfterNudge).toBeDefined();
    expect(JSON.parse(sessionAfterNudge as string).x3dhInit).toBeUndefined();
    // It changed (the nudge rotated the existing session) but is still ours, not a re-key.
    expect(sessionAfterNudge).not.toEqual(sessionBeforeRecovery);

    // 2) The higher peer (initiator) reacts to our nudge by sending a fresh X3DH
    //    init. Deliver it; the lower peer must ADOPT it (replacing its session).
    const { env: initEnv, senderState: higherStateAfterInit } = buildInitFromHigher(peer, me, SLOT_SPK_KEY);
    await mockFakeSocket.handlers.get('envelope')!(initEnv);
    await Promise.resolve();

    // After adoption the persisted session must be a Bob (receiver) session
    // derived from the higher peer's init — NOT a locally-minted Alice init.
    const adoptedJson = mockRatchetSessions.get(peer.aegisId);
    expect(adoptedJson).toBeDefined();
    expect(JSON.parse(adoptedJson as string).x3dhInit).toBeUndefined();

    // ── Assertion (4): TRUE CONVERGENCE — the lower peer decrypts a FOLLOW-UP ───
    // normal message sent by the higher peer over the SAME converged session.
    // If the lower peer had clobbered with its own session, this would fail and
    // re-trigger recovery (the on-device loop). A successful append == converged.
    mockAppendSpy.mockClear();
    const followUp = followUpFromHigher(peer, me, higherStateAfterInit, 'after-converge');
    await mockFakeSocket.handlers.get('envelope')!(followUp.env);
    await Promise.resolve();

    const appended = mockAppendSpy.mock.calls.find((c) => c[0]?.body === 'after-converge');
    expect(appended).toBeDefined();

    // Flush any deferred timers (recovery window / adopt-reply) without throwing.
    jest.runOnlyPendingTimers();
  });
});
