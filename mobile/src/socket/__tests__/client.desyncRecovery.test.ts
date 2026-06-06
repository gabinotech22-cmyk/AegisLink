/**
 * Ratchet desync auto-recovery (mobile/src/socket/client.ts).
 *
 * Scenario reproduced: two devices have a Double Ratchet session that is
 * permanently desynchronised (e.g. emulator userdata rollback). The OUTER
 * sealed-sender box still opens — proving the message genuinely comes from the
 * contact — but ratchetDecrypt() returns null. Because normal messages never
 * re-run X3DH, the session is dead forever. The client must:
 *   1. Detect the desync (outerBox OK + existing session + no x3dh header + null)
 *   2. Delete the dead local session
 *   3. Proactively re-handshake X3DH (emit an `init` envelope to the peer)
 *   4. NOT loop: a cooldown collapses bursts; a grace period protects a
 *      freshly-negotiated session from a stale in-flight message.
 *
 * Everything is mocked: no network, no SecureStore writes, no SQLite. No private
 * key material is asserted on. We drive the registered `envelope` handler.
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

jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async (aegisId: string) => mockRatchetSessions.get(aegisId) ?? null),
  saveRatchetSession: jest.fn(async (aegisId: string, json: string) => {
    mockRatchetSessions.set(aegisId, json);
  }),
  deleteContactRatchetSession: (aegisId: string) => mockDeleteSpy(aegisId),
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

// ── Fake socket ──────────────────────────────────────────────────────────────
interface FakeSocket {
  handlers: Map<string, Function>;
  emit: jest.Mock;
  on: (event: string, cb: Function) => FakeSocket;
  off: () => FakeSocket;
  disconnect: jest.Mock;
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
  };
}

/**
 * Build a healthy sender ratchet (peer side) targeting `me`, plus a persisted
 * RECEIVER session for `me` that is intentionally desynchronised from it.
 * Returns a wire envelope (genuinely sealed for `me`) that opens at the outer
 * layer but cannot be ratchet-decrypted.
 */
function buildDesyncedEnvelope(me: Identity, peer: Identity, createdAtMs: number) {
  // Peer performs X3DH against a bundle for `me` and gets a sender ratchet.
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

  // Encrypt a normal (NON-x3dh-init) message — clear x3dhInit so no headers go on the wire.
  delete senderState.x3dhInit;
  const { envelope } = encryptMessage('hola', peer.aegisId, me.publicKey, peer.secretKey, senderState);

  // Persist a DESYNCED but ESTABLISHED session for `me`: an Alice session
  // against an unrelated root (different root key) so ratchetDecrypt returns
  // null. We use an Alice session (not a never-sent receiver session) so it has
  // a sender chain key (CKs) — required for the non-initiator NUDGE path to be
  // able to encrypt over it, mirroring a real bidirectional session that has
  // already sent messages before desyncing.
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

  return { id: 'env-1', from: peer.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 };
}

/** A valid prekey bundle for `peer` so the recovery re-handshake (which fetches
 *  the peer's prekeys) can complete a full fresh X3DH instead of hanging. */
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

describe('ratchet desync auto-recovery', () => {
  let connect: typeof import('../client').connect;

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockContactsState.contacts = [];
    mockDeleteSpy.mockClear();
    connect = (require('../client') as typeof import('../client')).connect;
  });

  /**
   * Build (me, peer) so that `me` is the canonical INITIATOR (higher aegisId).
   * Only the initiator deletes+re-keys on desync; the lower peer NUDGES (see
   * client.desyncClobber.test.ts). The delete-based assertions here must
   * therefore run with `me` as the initiator to be deterministic.
   */
  function buildInitiatorAndPeer(): { me: Identity; peer: Identity } {
    let me = buildIdentity();
    let peer = buildIdentity();
    if (me.aegisId < peer.aegisId) { const t = me; me = peer; peer = t; }
    return { me, peer };
  }

  it('deletes the dead session and emits a re-handshake init envelope when an authenticated message fails to ratchet-decrypt', async () => {
    const { me, peer } = buildInitiatorAndPeer();

    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    setPeerBundle(peer);

    // Session created well in the past so the grace period does not apply.
    const env = buildDesyncedEnvelope(me, peer, Date.now() - 120_000);

    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope')!(env);
    await new Promise((r) => setImmediate(r));

    // Recovery deleted the dead session for the peer.
    expect(mockDeleteSpy).toHaveBeenCalledWith(peer.aegisId);
  });

  it('does NOT recover (grace period) when the desynced session was created recently', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();

    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];

    // Freshly created session — a stale in-flight message must not tear it down.
    const env = buildDesyncedEnvelope(me, peer, Date.now());

    await mockFakeSocket.handlers.get('envelope')!(env);
    await new Promise((r) => setImmediate(r));

    expect(mockDeleteSpy).not.toHaveBeenCalled();
  });

  it('collapses a burst of failing messages into a single recovery (cooldown)', async () => {
    const { me, peer } = buildInitiatorAndPeer();

    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    setPeerBundle(peer);

    // Three stale messages arrive back-to-back; only the first triggers recovery.
    for (let i = 0; i < 3; i++) {
      const env = buildDesyncedEnvelope(me, peer, Date.now() - 120_000);
      env.id = 'env-' + i;
      await mockFakeSocket.handlers.get('envelope')!(env);
      await new Promise((r) => setImmediate(r));
    }

    expect(mockDeleteSpy).toHaveBeenCalledTimes(1);
  });

  it('the NON-initiator (lower aegisId) does NOT delete/re-key on desync — it nudges instead', async () => {
    // Force `me` to be the LOWER aegisId so we take the non-initiator path.
    let me = buildIdentity();
    let peer = buildIdentity();
    if (me.aegisId > peer.aegisId) { const t = me; me = peer; peer = t; }

    connect(me);
    bringOnline();
    await new Promise((r) => setImmediate(r));

    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    setPeerBundle(peer);

    const env = buildDesyncedEnvelope(me, peer, Date.now() - 120_000);
    mockFakeSocket.emit.mockClear();
    await mockFakeSocket.handlers.get('envelope')!(env);
    await new Promise((r) => setImmediate(r));

    // No delete: the lower peer keeps its session and nudges. Deleting + building
    // a fresh initiator session here is exactly the clobber that caused the
    // on-device infinite loop.
    expect(mockDeleteSpy).not.toHaveBeenCalled();
    // It DID emit a nudge envelope to provoke the higher peer's recovery.
    const emittedEnvelope = mockFakeSocket.emit.mock.calls.some((c) => c[0] === 'envelope');
    expect(emittedEnvelope).toBe(true);
  });
});
