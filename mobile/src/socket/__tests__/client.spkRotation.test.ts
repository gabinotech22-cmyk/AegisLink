/**
 * Regression test for B-3 — age-based Signed PreKey rotation (Signal ~weekly).
 *
 * Before B-3 the SPK was only ever rotated when the one-time-prekey pool ran low
 * (`opkCount < 20` at auth:ok). A low-volume device that kept >20 OPKs would
 * NEVER rotate its SPK, so a single SPK secret protected new sessions forever.
 *
 * The fix adds an age trigger: at auth:ok we rotate when the current SPK is older
 * than `SPK_ROTATION_INTERVAL_MS`, regardless of OPK count. A pre-B-3 install
 * with no creation stamp is lazily backfilled (stamp now, do NOT rotate) so the
 * upgrade never force-rotates the whole fleet at once. The pruning also widens to
 * retain the last K=5 SPK secrets so an initial message queued on the relay
 * (TTL 30 days) against an older SPK still decrypts.
 *
 * These tests drive the auth:ok handler directly with an in-memory DB mock — no
 * real SQLite, no real SecureStore, no network. No key material is asserted in logs.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

// ── In-memory mock of the db/local prekey store ──────────────────────────────
const mockDbSpk = new Map<number, string>();
const mockDbOpk = new Map<number, string>();
let mockDbSpkKeyId: number | null = null;
let mockDbSpkCreatedAt: number | null = null;
let mockFailSpkWrite = false;

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
  // Prekey-secret durable store
  saveSpkSecret: jest.fn(async (keyId: number, b64: string) => {
    if (mockFailSpkWrite) return;
    mockDbSpk.set(keyId, b64);
  }),
  loadSpkSecret: jest.fn(async (keyId: number) => mockDbSpk.get(keyId) ?? null),
  loadLatestSpkSecret: jest.fn(async () => {
    if (mockDbSpk.size === 0) return null;
    const maxId = Math.max(...mockDbSpk.keys());
    return { keyId: maxId, b64: mockDbSpk.get(maxId)! };
  }),
  deleteSpkSecret: jest.fn(async (keyId: number) => { mockDbSpk.delete(keyId); }),
  saveOpkSecret: jest.fn(async (keyId: number, b64: string) => { mockDbOpk.set(keyId, b64); }),
  loadOpkSecret: jest.fn(async (keyId: number) => mockDbOpk.get(keyId) ?? null),
  deleteOpkSecret: jest.fn(async (keyId: number) => { mockDbOpk.delete(keyId); }),
  setSpkKeyId: jest.fn(async (n: number) => { mockDbSpkKeyId = n; }),
  getSpkKeyId: jest.fn(async () => mockDbSpkKeyId),
  // B-3: SPK age stamp
  setSpkCreatedAt: jest.fn(async (ms: number) => { mockDbSpkCreatedAt = ms; }),
  getSpkCreatedAt: jest.fn(async () => mockDbSpkCreatedAt),
  // PQSPK store (stubbed — these tests exercise the classic SPK rotation path).
  savePqSpkSecret: jest.fn(async () => undefined),
  loadPqSpkSecret: jest.fn(async () => null),
  setPqSpkKeyId: jest.fn(async () => undefined),
  getPqSpkKeyId: jest.fn(async () => null),
}));

jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: jest.fn(async () => ({ aegisId: '', publicKey: '', signingPublicKey: '', createdAt: 0 })),
  ApiError: class ApiError extends Error {},
}));

const mockContactsState = { contacts: [] as unknown[], loading: false };
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => mockContactsState,
    setState: () => undefined,
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
      byChat: {},
      append: jest.fn(async () => undefined),
      updateDelivery: jest.fn(async () => undefined),
      remoteDelete: jest.fn(async () => undefined),
    }),
  },
}));
jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({ displayName: 'Tester', avatarColor: '#000', profileStatus: '', avatarImage: null }),
  },
}));
jest.mock('../../store/preferences', () => ({
  __esModule: true,
  usePreferences: { getState: () => ({ routeViaTor: false }) },
}));
jest.mock('../../runtime', () => ({ __esModule: true, IS_EXPO_GO: true }));

jest.mock('expo-secure-store', () => ({
  __esModule: true,
  AFTER_FIRST_UNLOCK: 'afterFirstUnlock',
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));
jest.mock('expo-crypto', () => ({
  __esModule: true,
  randomUUID: () => '00000000-0000-0000-0000-000000000000',
}));
jest.mock('../../config', () => ({ __esModule: true, SERVER_URL: 'http://localhost', ONION_URL: '' }));

// ── Fake socket capturing prekeys:upload emits ───────────────────────────────
type AckCb = (ack: unknown) => void;
interface FakeSocket {
  handlers: Map<string, Function>;
  emit: jest.Mock;
  on: (event: string, cb: Function) => FakeSocket;
  off: () => FakeSocket;
  disconnect: jest.Mock;
  connect: jest.Mock;
  auth: Record<string, unknown>;
}
let mockFakeSocket: FakeSocket;
const emittedEvents: string[] = [];

jest.mock('socket.io-client', () => ({
  __esModule: true,
  io: (_url: string, opts: { auth: Record<string, unknown> }) => {
    mockFakeSocket = {
      handlers: new Map(),
      auth: opts.auth,
      on(event: string, cb: Function) { this.handlers.set(event, cb); return this; },
      off() { return this; },
      disconnect: jest.fn(),
      connect: jest.fn(),
      emit: jest.fn((event: string, _payload: unknown, ack?: AckCb) => {
        emittedEvents.push(event);
        if (event === 'prekeys:upload' && typeof ack === 'function') ack({ ok: true });
      }),
    };
    return mockFakeSocket;
  },
}));

import type { Identity } from '../../crypto/identity';

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** Drive connect + auth:ok with the given opkCount and let microtasks settle. */
async function driveAuthOk(opkCount: number): Promise<void> {
  const me = buildIdentity();
  const mod = require('../client') as typeof import('../client');
  mod.connect(me);
  const onConnect = mockFakeSocket.handlers.get('connect')!;
  const onAuthOk = mockFakeSocket.handlers.get('auth:ok')!;
  onConnect();
  await onAuthOk({ opkCount });
  await new Promise((r) => setImmediate(r));
}

describe('B-3 — age-based SPK rotation', () => {
  beforeEach(() => {
    jest.resetModules();
    mockDbSpk.clear();
    mockDbOpk.clear();
    mockDbSpkKeyId = null;
    mockDbSpkCreatedAt = null;
    mockFailSpkWrite = false;
    emittedEvents.length = 0;
    mockContactsState.contacts = [];
  });

  it('rotates when the SPK is older than the interval even with a healthy OPK pool', async () => {
    mockDbSpkKeyId = 3;
    mockDbSpk.set(3, 'seed-spk-3');
    mockDbSpkCreatedAt = Date.now() - 8 * DAY_MS; // stale (> 7 days)

    await driveAuthOk(50); // OPK pool healthy — only age can trigger

    expect(emittedEvents).toContain('prekeys:upload');
    expect(mockDbSpkKeyId).toBe(4); // monotonic keyId advanced
    // createdAt re-stamped to ~now (no longer stale).
    expect(mockDbSpkCreatedAt).not.toBeNull();
    expect(Date.now() - (mockDbSpkCreatedAt as number)).toBeLessThan(DAY_MS);
  });

  it('does NOT rotate when the SPK is fresh and the OPK pool is healthy', async () => {
    mockDbSpkKeyId = 3;
    mockDbSpk.set(3, 'seed-spk-3');
    mockDbSpkCreatedAt = Date.now() - 60 * 60 * 1000; // 1 hour old

    await driveAuthOk(50);

    expect(emittedEvents).not.toContain('prekeys:upload');
    expect(mockDbSpkKeyId).toBe(3); // unchanged
  });

  it('lazily backfills a missing creation stamp WITHOUT rotating (migration safety)', async () => {
    mockDbSpkKeyId = 3;
    mockDbSpk.set(3, 'seed-spk-3');
    mockDbSpkCreatedAt = null; // pre-B-3 install: SPK exists, no stamp

    await driveAuthOk(50);

    expect(emittedEvents).not.toContain('prekeys:upload'); // no rotation storm
    expect(mockDbSpkKeyId).toBe(3); // unchanged
    expect(mockDbSpkCreatedAt).not.toBeNull(); // clock started from now
  });

  it('still refills on OPK depletion (depletion path unaffected by B-3)', async () => {
    mockDbSpkKeyId = 3;
    mockDbSpk.set(3, 'seed-spk-3');
    mockDbSpkCreatedAt = Date.now() - 60 * 60 * 1000; // fresh — not stale

    await driveAuthOk(5); // below the 20 threshold

    expect(emittedEvents).toContain('prekeys:upload');
    expect(mockDbSpkKeyId).toBe(4);
  });

  it('retains the last 5 SPK secrets on rotation (grace window for queued inits)', async () => {
    mockDbSpkKeyId = 5;
    for (let i = 1; i <= 5; i++) mockDbSpk.set(i, `seed-spk-${i}`);
    mockDbSpkCreatedAt = Date.now() - 8 * DAY_MS; // stale → rotate

    await driveAuthOk(50);

    expect(mockDbSpkKeyId).toBe(6);
    // Immediately-previous SPK (keyId 5) stays decryptable — the grace window.
    expect(mockDbSpk.has(5)).toBe(true);
    expect(mockDbSpk.has(4)).toBe(true);
    expect(mockDbSpk.has(6)).toBe(true); // freshly written
    // keyId 6-5 = 1 falls out of the K=5 window and is pruned.
    expect(mockDbSpk.has(1)).toBe(false);
  });
});
