/**
 * Regression test for broadcastProfileUpdate phantom-notification dedup
 * (mobile/src/socket/client.ts — audit 2026-07-26).
 *
 * Background: a profile broadcast is a real E2EE envelope. To an OFFLINE contact
 * the relay queues it and fires the SAME generic "Nuevo mensaje cifrado" wake-up
 * push as a real message — but on open there is nothing to show (profile_update
 * is applied silently). The old code broadcast on EVERY auth:ok, so every
 * reconnect spammed every established contact with a phantom notification.
 *
 * The fix fingerprints the broadcast-relevant profile fields and skips the whole
 * broadcast when nothing changed since the last one (per identity, persisted in
 * SecureStore). This proves: a fresh/changed profile broadcasts (enters the
 * contact loop) while an unchanged reconnect returns early (never touches the
 * loop → no phantom wake-ups).
 *
 * Crypto-free by design: the single contact has NO ratchet session, so the loop
 * reaches loadRatchetSession() and then `continue`s — loadRatchetSession being
 * called at all is the observable "the broadcast ran" signal. No network, no real
 * SecureStore, no SQLite. No private key material is exposed in any mock.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

// ── Mocks (must be declared before importing client.ts) ───────────────────────

const mockRatchetSessions = new Map<string, string>();
jest.mock('../../db/local', () => ({
  __esModule: true,
  loadRatchetSession: jest.fn(async (aegisId: string) => mockRatchetSessions.get(aegisId) ?? null),
  saveRatchetSession: jest.fn(async (aegisId: string, json: string) => {
    mockRatchetSessions.set(aegisId, json);
  }),
  saveContact: jest.fn(async () => undefined),
  getActiveDbSlot: () => 'self',
  loadOutboxJobs: jest.fn(async () => []),
  enqueueOutboxJob: jest.fn(async () => undefined),
  deleteOutboxJob: jest.fn(async () => undefined),
  incrementOutboxAttempts: jest.fn(async () => undefined),
}));

jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: jest.fn(async (aegisId: string) => ({
    aegisId,
    publicKey: '',
    signingPublicKey: '',
    createdAt: 0,
  })),
  ApiError: class ApiError extends Error {},
}));

const mockContactsState: {
  contacts: Array<{ aegisId: string; publicKeyB64: string; signingPublicKeyB64: string }>;
} = { contacts: [] };
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => mockContactsState,
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

// Mutable profile so a test can simulate the user editing their profile.
const mockIdentityState = {
  displayName: 'Tester',
  avatarColor: '#000',
  profileStatus: '',
  avatarImage: null as string | null,
};
jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: { getState: () => mockIdentityState },
}));

// Stateful SecureStore so the fingerprint persisted by one broadcast is visible
// to the next (the whole point of the dedup guard).
const mockSecureStore = new Map<string, string>();
jest.mock('expo-secure-store', () => ({
  __esModule: true,
  getItemAsync: jest.fn(async (k: string) => mockSecureStore.get(k) ?? null),
  setItemAsync: jest.fn(async (k: string, v: string) => {
    mockSecureStore.set(k, v);
  }),
  deleteItemAsync: jest.fn(async (k: string) => {
    mockSecureStore.delete(k);
  }),
  AFTER_FIRST_UNLOCK: 'afu',
}));
jest.mock('expo-crypto', () => ({
  __esModule: true,
  randomUUID: () => '00000000-0000-0000-0000-000000000000',
}));
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'http://localhost' }));

// Fake socket.io client (minimal — only what connect()/auth needs here).
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
      on(event: string, cb: Function) {
        this.handlers.set(event, cb);
        return this;
      },
      off() {
        return this;
      },
      disconnect: jest.fn(),
      timeout() {
        return {
          emit: (event: string, payload: unknown, cb: (err: Error | null, ack?: unknown) => void) => {
            this.emit(event, payload, (ack: unknown) => cb(null, ack));
          },
        };
      },
      emit: jest.fn((event: string, _payload: unknown, ack?: (ack: unknown) => void) => {
        if (event === 'envelope' && typeof ack === 'function') ack({ ok: true });
      }),
    };
    return mockFakeSocket;
  },
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

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

function bringSocketOnline() {
  const onConnect = mockFakeSocket.handlers.get('connect');
  const onAuthOk = mockFakeSocket.handlers.get('auth:ok');
  if (!onConnect || !onAuthOk) throw new Error('socket handlers not registered');
  onConnect();
  onAuthOk({ opkCount: 100 }); // >= 20 skips the prekey-refill branch
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('broadcastProfileUpdate — phantom-notification dedup (audit 2026-07-26)', () => {
  let broadcastProfileUpdate: typeof import('../client').broadcastProfileUpdate;
  let connect: typeof import('../client').connect;
  let dbLocal: typeof import('../../db/local');

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockSecureStore.clear();
    mockContactsState.contacts = [];
    mockIdentityState.displayName = 'Tester';
    mockIdentityState.avatarColor = '#000';
    mockIdentityState.profileStatus = '';
    mockIdentityState.avatarImage = null;
    const mod = require('../client') as typeof import('../client');
    broadcastProfileUpdate = mod.broadcastProfileUpdate;
    connect = mod.connect;
    dbLocal = require('../../db/local') as typeof import('../../db/local');
  });

  it('broadcasts on change, skips the loop entirely when the profile is unchanged', async () => {
    const me = buildIdentity();
    connect(me);
    bringSocketOnline(); // marks the module connected + authenticated
    await new Promise<void>((r) => setImmediate(() => r()));

    // A contact with NO ratchet session: the loop reaches loadRatchetSession then
    // `continue`s, so a call to loadRatchetSession is the "broadcast ran" signal.
    mockContactsState.contacts = [
      { aegisId: 'PEER-0001-0001', publicKeyB64: me.publicKeyB64, signingPublicKeyB64: '' },
    ];
    mockSecureStore.clear(); // start from "never broadcast this profile"

    // 1) Fresh profile → nothing stored → guard passes → loop runs.
    (dbLocal.loadRatchetSession as jest.Mock).mockClear();
    await broadcastProfileUpdate(me);
    expect(dbLocal.loadRatchetSession).toHaveBeenCalledTimes(1);
    // …and the fingerprint was persisted for next time.
    expect(mockSecureStore.size).toBe(1);

    // 2) Unchanged profile → fingerprint matches → EARLY RETURN before the loop.
    //    This is the phantom-notification fix: no re-broadcast on reconnect.
    (dbLocal.loadRatchetSession as jest.Mock).mockClear();
    await broadcastProfileUpdate(me);
    expect(dbLocal.loadRatchetSession).not.toHaveBeenCalled();

    // 3) User edits their profile → fingerprint differs → broadcasts again.
    mockIdentityState.displayName = 'Tester-renamed';
    (dbLocal.loadRatchetSession as jest.Mock).mockClear();
    await broadcastProfileUpdate(me);
    expect(dbLocal.loadRatchetSession).toHaveBeenCalledTimes(1);
  });
});
