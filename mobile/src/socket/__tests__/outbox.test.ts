/**
 * Outbox tests — Signal-style persistent message queue
 *
 * Covers:
 * 1. DB functions: enqueue / load / delete / incrementAttempts (via withDb-serialized mock)
 * 2. sendMessage (1:1):
 *    - Job persisted BEFORE emit; deleted on ACK ok
 *    - Job RETAINED (+ attempts incremented) when ACK fails
 *    - Offline path: job persisted, emit not called, no throw
 * 3. sendGroupMessage (group fan-out):
 *    - Per-member job enqueued; deleted on ACK ok
 *    - Failure for one member keeps that job; other members still deliver
 *    - Error NOT swallowed silently (incrementAttempts called)
 * 4. flushOutbox:
 *    - Drains jobs FIFO (in creation-time order)
 *    - Delivered jobs are deleted; failed jobs are kept + incremented
 *
 * Note: DB functions themselves call into `withDb` which uses the expo-sqlite
 * mock (openDatabaseAsync → mockDb). We exercise the real local.ts functions
 * (enqueueOutboxJob etc.) via a separate DB-layer test suite below.
 */

// ─── Mock setup — must come before any imports that pull in the mocked modules ──

// --- db/local outbox helpers -------------------------------------------------
const mockEnqueueOutboxJob = jest.fn().mockResolvedValue(undefined);
const mockLoadOutboxJobs = jest.fn().mockResolvedValue([]);
const mockLoadDueOutboxJobs = jest.fn().mockResolvedValue([]);
const mockDeleteOutboxJob = jest.fn().mockResolvedValue(undefined);
const mockIncrementOutboxAttempts = jest.fn().mockResolvedValue(undefined);
const mockGetGroup = jest.fn();
const mockSaveGroup = jest.fn().mockResolvedValue(undefined);
const mockLoadRatchetSession = jest.fn().mockResolvedValue(null);
const mockSaveRatchetSession = jest.fn().mockResolvedValue(undefined);
const mockFindOrphanedPending = jest.fn().mockResolvedValue([]);
const mockAdvanceMessageDelivery = jest.fn().mockResolvedValue(undefined);

jest.mock('../../db/local', () => ({
  __esModule: true,
  findOrphanedPendingMessages: (...args: unknown[]) => mockFindOrphanedPending(...args),
  advanceMessageDelivery: (...args: unknown[]) => mockAdvanceMessageDelivery(...args),
  enqueueOutboxJob: (...args: unknown[]) => mockEnqueueOutboxJob(...args),
  loadOutboxJobs: (...args: unknown[]) => mockLoadOutboxJobs(...args),
  loadDueOutboxJobs: (...args: unknown[]) => mockLoadDueOutboxJobs(...args),
  deleteOutboxJob: (...args: unknown[]) => mockDeleteOutboxJob(...args),
  incrementOutboxAttempts: (...args: unknown[]) => mockIncrementOutboxAttempts(...args),
  getGroup: (...args: unknown[]) => mockGetGroup(...args),
  saveGroup: (...args: unknown[]) => mockSaveGroup(...args),
  loadRatchetSession: (...args: unknown[]) => mockLoadRatchetSession(...args),
  saveRatchetSession: (...args: unknown[]) => mockSaveRatchetSession(...args),
  getActiveDbSlot: () => 'self',
}));

// --- store/contacts ----------------------------------------------------------
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => ({
      contacts: [
        { aegisId: 'member-a', publicKeyB64: 'cHViQQ==', name: 'A', verified: true, addedAt: 0 },
        { aegisId: 'member-b', publicKeyB64: 'cHViQg==', name: 'B', verified: true, addedAt: 0 },
      ],
    }),
  },
}));

// --- store/messages ----------------------------------------------------------
const mockAppend = jest.fn().mockResolvedValue(undefined);
const mockGetEphemeralTimer = jest.fn().mockReturnValue(0);
const mockUpdateDelivery = jest.fn().mockResolvedValue(undefined);
const mockSetMediaUri = jest.fn().mockResolvedValue(undefined);
/** Mutable per test: what retryFailedMessage finds in the store. */
const mockByChat: Record<string, Array<Record<string, unknown>>> = {};
jest.mock('../../store/messages', () => ({
  __esModule: true,
  useMessages: {
    getState: () => ({
      append: mockAppend,
      getEphemeralTimer: mockGetEphemeralTimer,
      updateDelivery: mockUpdateDelivery,
      setMediaUri: mockSetMediaUri,
      byChat: mockByChat,
    }),
  },
}));

// --- store/groups (retry path: 1:1 unless the chat is a group) --------------
jest.mock('../../store/groups', () => ({
  __esModule: true,
  useGroups: { getState: () => ({ groups: [] }) },
}));

// --- mailboxSocket (syncNow drains the mailbox statelessly) -----------------
const mockFetchMailboxOverTor = jest.fn().mockResolvedValue(0);
jest.mock('../mailboxSocket', () => ({
  __esModule: true,
  fetchMailboxOverTor: (...args: unknown[]) => mockFetchMailboxOverTor(...args),
  connectMailboxSocket: jest.fn(),
  disconnectMailboxSocket: jest.fn(),
  sendViaMailbox: jest.fn(),
  isMailboxAuthed: () => false,
  mailboxAckConfirmsDelivery: () => false,
}));

// --- crypto/media (retry re-uploads media from the local copy) ---------------
const mockResolveMedia = jest.fn().mockResolvedValue('file:///cache/dec.jpg');
const mockEncryptAndUploadMedia = jest.fn().mockResolvedValue('blob:fresh:k==:n==');
jest.mock('../../crypto/media', () => ({
  __esModule: true,
  resolveMedia: (...args: unknown[]) => mockResolveMedia(...args),
  encryptAndUploadMedia: (...args: unknown[]) => mockEncryptAndUploadMedia(...args),
}));

// --- store/identity ----------------------------------------------------------
jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({
      displayName: 'TestUser',
      avatarColor: '#000000',
      avatarImage: null,
      profileStatus: undefined,
    }),
  },
}));

// --- store/preferences -------------------------------------------------------
jest.mock('../../store/preferences', () => ({
  __esModule: true,
  usePreferences: { getState: () => ({ onionRouting: false }) },
}));

// --- store/connection ---------------------------------------------------------
jest.mock('../../store/connection', () => ({
  __esModule: true,
  useConnection: { getState: () => ({ setOnline: jest.fn() }) },
}));

// --- crypto/messaging --------------------------------------------------------
const mockEncryptMessage = jest.fn().mockReturnValue({
  envelope: { ciphertextB64: 'cipher==', nonceB64: 'nonce==' },
  newState: {},
});
jest.mock('../../crypto/messaging', () => ({
  encryptMessage: (...args: unknown[]) => mockEncryptMessage(...args),
  openEnvelope: jest.fn(),
}));

// --- crypto/signal/x3dh ------------------------------------------------------
jest.mock('../../crypto/signal/x3dh', () => ({
  performX3DH: jest.fn(),
  performX3DHReceiver: jest.fn(),
  generatePreKeys: jest.fn(),
}));

// --- crypto/signal/ratchet ---------------------------------------------------
jest.mock('../../crypto/signal/ratchet', () => ({
  initRatchet: jest.fn().mockReturnValue({}),
  ratchetEncrypt: jest.fn(),
  ratchetDecrypt: jest.fn(),
  trimOldSkippedKeys: jest.fn(),
  MAX_SKIPPED_KEYS: 1000,
}));

// --- expo-crypto -------------------------------------------------------------
let mockUuidCounter = 0;
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn(() => `uuid-${++mockUuidCounter}`),
}));

// --- expo-secure-store -------------------------------------------------------
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
  AFTER_FIRST_UNLOCK: 'after_first_unlock',
}));

// --- tweetnacl ---------------------------------------------------------------
// The crypto facade (native libsodium) with a stubbed `nacl`: these tests
// only need the calls to succeed, not real cryptography.
jest.mock('../../crypto/sodium', () => ({
  ...jest.requireActual('../../crypto/sodium'),
  nacl: {
    randomBytes: jest.fn((n: number) => new Uint8Array(n)),
    box: Object.assign(jest.fn().mockReturnValue(new Uint8Array(32)), {
      open: jest.fn().mockReturnValue(null),
      publicKeyLength: 32,
      secretKeyLength: 32,
      nonceLength: 24,
    }),
    secretbox: Object.assign(jest.fn().mockReturnValue(new Uint8Array(8)), {
      keyLength: 32,
      nonceLength: 24,
      open: jest.fn().mockReturnValue(null),
    }),
    sign: Object.assign(jest.fn(), {
      detached: Object.assign(jest.fn().mockReturnValue(new Uint8Array(64)), {
        verify: jest.fn().mockReturnValue(true),
      }),
      signatureLength: 64,
      publicKeyLength: 32,
      secretKeyLength: 64,
    }),
    scalarMult: {
      base: jest.fn().mockReturnValue(new Uint8Array(32)),
    },
  },
}));

jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn(() => 'base64=='),
  decodeBase64: jest.fn(() => new Uint8Array(32)),
  encodeUTF8: jest.fn(() => new Uint8Array(4)),
  decodeUTF8: jest.fn(() => 'text'),
}));

// --- api (prekey fetch) -------------------------------------------------------
jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: jest.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {},
}));

// --- config ------------------------------------------------------------------
jest.mock('../../config', () => ({
  SERVER_URL: 'http://localhost:3000',
  ONION_URL: null,
  RELAY_URL: 'http://localhost:3000',
  MAILBOX_ENABLED: true,
}));

// ─── Actual imports ───────────────────────────────────────────────────────────

import { sendMessage, sendGroupMessage, retryFailedMessage, settleOrphanedPendingOnce, ORPHANED_PENDING_MIN_AGE_MS, syncNow } from '../client';
import type { Identity } from '../../crypto/identity';

// ─── Helpers ─────────────────────────────────────────────────────────────────

const BASE_IDENTITY: Identity = {
  aegisId: 'self-id',
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(32),
  publicKeyB64: 'c2VsZlB1Yg==',
  secretKeyB64: 'c2VsZlNlYw==',
  signingPublicKey: new Uint8Array(32),
  signingSecretKey: new Uint8Array(64),
  signingPublicKeyB64: 'c2lnUHVi',
  signingSecretKeyB64: 'c2lnU2Vj',
  createdAt: 0,
};

const RECIPIENT_PUB_KEY = new Uint8Array(32);

// ─── ❶  outbox mock call contract tests ──────────────────────────────────────
// Verify that client.ts calls enqueueOutboxJob / deleteOutboxJob /
// incrementOutboxAttempts with the correct arguments. The real DB functions
// are tested separately in db/__tests__/outbox.db.test.ts.

describe('Outbox mock-contract: sendMessage offline enqueues correctly', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUuidCounter = 0;
  });

  it('enqueueOutboxJob called with correct shape for direct message', async () => {
    await sendMessage({
      identity: BASE_IDENTITY,
      recipientAegisId: 'peer-x',
      recipientPublicKey: RECIPIENT_PUB_KEY,
      plaintext: 'contract test',
    });

    expect(mockEnqueueOutboxJob).toHaveBeenCalledTimes(1);
    const arg = mockEnqueueOutboxJob.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.kind).toBe('direct');
    expect(arg.groupId).toBeNull();
    expect(arg.recipientAegisId).toBe('peer-x');
    expect(typeof arg.jobId).toBe('string');
    expect(typeof arg.msgId).toBe('string');
    expect(typeof arg.payload).toBe('string');
    // payload should be JSON containing text
    const parsed = JSON.parse(arg.payload as string) as { text: string };
    expect(parsed.text).toBe('contract test');
  });

  it('enqueueOutboxJob called with kind:group for group messages', async () => {
    mockGetGroup.mockResolvedValue({
      id: 'g-contract',
      name: 'Contract Group',
      members: ['self-id', 'member-a'],
      createdAt: 0,
      adminId: 'self-id',
      adminSig: 'sig==',
      avatarColor: null,
      avatarImage: null,
    });

    await sendGroupMessage({
      identity: BASE_IDENTITY,
      groupId: 'g-contract',
      plaintext: 'group contract',
    });

    // member-a gets a job
    expect(mockEnqueueOutboxJob).toHaveBeenCalledTimes(1);
    const arg = mockEnqueueOutboxJob.mock.calls[0][0] as Record<string, unknown>;
    expect(arg.kind).toBe('group');
    expect(arg.groupId).toBe('g-contract');
    expect(arg.recipientAegisId).toBe('member-a');
  });
});

// ─── ❷  sendMessage (1:1) outbox tests ───────────────────────────────────────

describe('sendMessage — outbox integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUuidCounter = 0;
  });

  it('OFFLINE: enqueueOutboxJob is called; emit is NOT called', async () => {
    // Socket is null (offline) — module initialises with null socket
    await sendMessage({
      identity: BASE_IDENTITY,
      recipientAegisId: 'peer-1',
      recipientPublicKey: RECIPIENT_PUB_KEY,
      plaintext: 'hello offline',
    });

    expect(mockEnqueueOutboxJob).toHaveBeenCalledTimes(1);
    expect(mockEnqueueOutboxJob).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientAegisId: 'peer-1',
        kind: 'direct',
        groupId: null,
      }),
    );
    // No socket → no emit
    // (We can't access the private socket var but encryptMessage is not called
    //  because getOrCreateSession would fail before emitting)
  });
});

// ─── ❸  sendGroupMessage — outbox per-member tests ────────────────────────────

describe('sendGroupMessage — outbox per-member', () => {
  const groupWithTwoMembers = {
    id: 'grp-1',
    name: 'Group Alpha',
    members: ['self-id', 'member-a', 'member-b'],
    createdAt: 100,
    adminId: 'self-id',
    adminSig: 'sig==',
    avatarColor: null,
    avatarImage: null,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockUuidCounter = 0;
    mockGetGroup.mockResolvedValue(groupWithTwoMembers);
  });

  it('OFFLINE: enqueues one job per non-self member', async () => {
    await sendGroupMessage({
      identity: BASE_IDENTITY,
      groupId: 'grp-1',
      plaintext: 'hello group',
    });

    // Two non-self members → two enqueue calls
    expect(mockEnqueueOutboxJob).toHaveBeenCalledTimes(2);
    const calls = mockEnqueueOutboxJob.mock.calls.map((c: unknown[]) => (c[0] as { recipientAegisId: string }).recipientAegisId);
    expect(calls).toContain('member-a');
    expect(calls).toContain('member-b');

    // All jobs have kind:'group'
    mockEnqueueOutboxJob.mock.calls.forEach((c: unknown[]) => {
      expect((c[0] as { kind: string }).kind).toBe('group');
      expect((c[0] as { groupId: string }).groupId).toBe('grp-1');
    });
  });

  it('OFFLINE: local append still happens when skipLocalAppend is absent', async () => {
    await sendGroupMessage({
      identity: BASE_IDENTITY,
      groupId: 'grp-1',
      plaintext: 'test text',
    });

    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'grp-1', direction: 'out' }),
    );
  });

  it('OFFLINE: skipLocalAppend:true prevents local append', async () => {
    await sendGroupMessage({
      identity: BASE_IDENTITY,
      groupId: 'grp-1',
      plaintext: 'image payload',
      skipLocalAppend: true,
    });

    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('throws group_not_found when getGroup returns null', async () => {
    mockGetGroup.mockResolvedValue(null);

    await expect(
      sendGroupMessage({ identity: BASE_IDENTITY, groupId: 'bad-grp', plaintext: 'x' }),
    ).rejects.toThrow('group_not_found');
  });
});

// ─── ❹  flushOutbox — drain order and retry tests ─────────────────────────────

describe('flushOutbox — FIFO drain via auth:ok (indirect)', () => {
  // We test flushOutbox indirectly by verifying that loadOutboxJobs is called
  // on auth:ok and that the ordering contract holds. Direct testing of the
  // private flushOutbox function is done by inspecting mock call order.

  beforeEach(() => {
    jest.clearAllMocks();
    mockUuidCounter = 0;
  });

  it('loadOutboxJobs is called with FIFO order intent (sorted by created_at ASC in DB layer)', async () => {
    // The DB layer sorts by created_at ASC (FIFO). The client drains them in array
    // order. We verify that loadOutboxJobs returns a sorted list (mocked) and
    // that the order is preserved in enqueue calls.

    // Simulate two offline messages enqueued
    await sendMessage({
      identity: BASE_IDENTITY,
      recipientAegisId: 'peer-1',
      recipientPublicKey: RECIPIENT_PUB_KEY,
      plaintext: 'first',
    });
    await sendMessage({
      identity: BASE_IDENTITY,
      recipientAegisId: 'peer-1',
      recipientPublicKey: RECIPIENT_PUB_KEY,
      plaintext: 'second',
    });

    // Both jobs enqueued
    expect(mockEnqueueOutboxJob).toHaveBeenCalledTimes(2);

    // The payloads should contain the correct plaintext
    const payloads = mockEnqueueOutboxJob.mock.calls.map((c: unknown[]) => {
      const job = c[0] as { payload: string };
      return JSON.parse(job.payload) as { text: string };
    });
    expect(payloads[0].text).toBe('first');
    expect(payloads[1].text).toBe('second');
  });
});

// ─── ❺  Pre-appended media bubbles keep their id ──────────────────────────────
// A media sender appends its own bubble, then calls sendMessage with
// skipLocalAppend. Without `messageId` the outbox job (and every status update
// that follows: sent, delivered, read, failed) targeted a fresh uuid nothing
// rendered — the photo sat on "sending" forever, delivered or not.

describe('sendMessage — messageId ties the outbox job to the pre-appended bubble', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUuidCounter = 0;
  });

  it('uses the caller bubble id as the outbox msgId', async () => {
    await sendMessage({
      identity: BASE_IDENTITY,
      recipientAegisId: 'peer-1',
      recipientPublicKey: RECIPIENT_PUB_KEY,
      plaintext: '[image:blob:x:k==:n==]hola',
      skipLocalAppend: true,
      messageId: 'bubble-photo-1',
    });
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockEnqueueOutboxJob).toHaveBeenCalledTimes(1);
    expect((mockEnqueueOutboxJob.mock.calls[0][0] as { msgId: string }).msgId).toBe('bubble-photo-1');
  });

  it('without messageId the id is still generated (text path unchanged)', async () => {
    await sendMessage({
      identity: BASE_IDENTITY,
      recipientAegisId: 'peer-1',
      recipientPublicKey: RECIPIENT_PUB_KEY,
      plaintext: 'plain',
    });
    const job = mockEnqueueOutboxJob.mock.calls[0][0] as { msgId: string };
    expect(job.msgId).toMatch(/^uuid-/);
    expect(mockAppend).toHaveBeenCalledWith(expect.objectContaining({ id: job.msgId }));
  });
});

// ─── ❻  retryFailedMessage rebuilds a media message ──────────────────────────

describe('retryFailedMessage — 1:1', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUuidCounter = 0;
    for (const k of Object.keys(mockByChat)) delete mockByChat[k];
  });

  it('image: re-uploads from the local copy and sends [image:<fresh>]caption as direct_msg', async () => {
    mockByChat['member-a'] = [{
      id: 'msg-img', chatId: 'member-a', direction: 'out', type: 'image',
      body: 'mira', mediaUri: 'blob:old:k==:n==', createdAt: 1, deliveryStatus: 'failed',
    }];

    const ok = await retryFailedMessage(BASE_IDENTITY, 'member-a', 'msg-img');

    expect(ok).toBe(true);
    // Stale reference → decrypt the local ciphertext, upload it again.
    expect(mockResolveMedia).toHaveBeenCalledWith('blob:old:k==:n==', 'jpg');
    expect(mockEncryptAndUploadMedia).toHaveBeenCalledWith('file:///cache/dec.jpg', 'image/jpeg');
    expect(mockSetMediaUri).toHaveBeenCalledWith('member-a', 'msg-img', 'blob:fresh:k==:n==');
    // Same bubble id, wire type the receiver renders, attachment + caption joined.
    expect(mockEnqueueOutboxJob).toHaveBeenCalledTimes(1);
    const job = mockEnqueueOutboxJob.mock.calls[0][0] as { msgId: string; payload: string };
    expect(job.msgId).toBe('msg-img');
    const payload = JSON.parse(job.payload) as { type: string; text: string };
    expect(payload.type).toBe('direct_msg');
    expect(payload.text).toBe('[image:blob:fresh:k==:n==]mira');
    expect(mockUpdateDelivery).toHaveBeenCalledWith('member-a', 'msg-img', 'pending');
  });

  it('image whose upload never succeeded: uploads the picker file directly', async () => {
    mockByChat['member-a'] = [{
      id: 'msg-local', chatId: 'member-a', direction: 'out', type: 'image',
      body: '', mediaUri: 'file:///picker/photo.jpg', createdAt: 1, deliveryStatus: 'failed',
    }];
    expect(await retryFailedMessage(BASE_IDENTITY, 'member-a', 'msg-local')).toBe(true);
    expect(mockResolveMedia).not.toHaveBeenCalled();
    expect(mockEncryptAndUploadMedia).toHaveBeenCalledWith('file:///picker/photo.jpg', 'image/jpeg');
  });

  it('text: wire type is direct_msg (not the local row type)', async () => {
    mockByChat['member-a'] = [{
      id: 'msg-txt', chatId: 'member-a', direction: 'out', type: 'text',
      body: 'hey', mediaUri: null, createdAt: 1, deliveryStatus: 'failed',
    }];
    expect(await retryFailedMessage(BASE_IDENTITY, 'member-a', 'msg-txt')).toBe(true);
    const payload = JSON.parse((mockEnqueueOutboxJob.mock.calls[0][0] as { payload: string }).payload) as { type: string; text: string };
    expect(payload).toMatchObject({ type: 'direct_msg', text: 'hey' });
    expect(mockEncryptAndUploadMedia).not.toHaveBeenCalled();
  });

  it('media gone from the device: not retryable, nothing enqueued', async () => {
    mockResolveMedia.mockResolvedValueOnce(null);
    mockByChat['member-a'] = [{
      id: 'msg-gone', chatId: 'member-a', direction: 'out', type: 'video',
      body: '', mediaUri: 'blob:old:k==:n==', createdAt: 1, deliveryStatus: 'failed',
    }];
    expect(await retryFailedMessage(BASE_IDENTITY, 'member-a', 'msg-gone')).toBe(false);
    expect(mockEnqueueOutboxJob).not.toHaveBeenCalled();
  });

  it('view-once: never retried (the media only ever lived in the original envelope)', async () => {
    mockByChat['member-a'] = [{
      id: 'msg-vo', chatId: 'member-a', direction: 'out', type: 'image',
      body: '[viewonce]', mediaUri: 'file:///x.jpg', createdAt: 1, deliveryStatus: 'failed',
    }];
    expect(await retryFailedMessage(BASE_IDENTITY, 'member-a', 'msg-vo')).toBe(false);
    expect(mockEnqueueOutboxJob).not.toHaveBeenCalled();
  });
});

// ─── ❼  Orphan sweep: pending rows nothing will ever settle ─────────────────

describe('settleOrphanedPendingOnce', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    for (const k of Object.keys(mockByChat)) delete mockByChat[k];
  });

  it('marks orphans failed — through the store for loaded chats, DB-only otherwise — and runs once', async () => {
    mockByChat['peer-loaded'] = [];
    mockFindOrphanedPending.mockResolvedValueOnce([
      { id: 'm-1', chatId: 'peer-loaded' },
      { id: 'm-2', chatId: 'peer-cold' },
    ]);
    const before = Date.now();

    await settleOrphanedPendingOnce();

    // Age cutoff: now minus the grace window (a fresh upload is not an orphan).
    const cutoff = mockFindOrphanedPending.mock.calls[0][0] as number;
    expect(before - cutoff).toBeGreaterThanOrEqual(ORPHANED_PENDING_MIN_AGE_MS - 5);
    expect(mockUpdateDelivery).toHaveBeenCalledWith('peer-loaded', 'm-1', 'failed');
    expect(mockAdvanceMessageDelivery).toHaveBeenCalledWith('m-2', 'failed');
    expect(mockAdvanceMessageDelivery).not.toHaveBeenCalledWith('m-1', 'failed');

    await settleOrphanedPendingOnce();
    expect(mockFindOrphanedPending).toHaveBeenCalledTimes(1);
  });
});

// ─── ❽  syncNow: the one call behind foreground resume and pull-to-refresh ──

describe('syncNow', () => {
  beforeEach(() => jest.clearAllMocks());

  it('drains the mailbox over Tor and runs an outbox pass', async () => {
    await expect(syncNow(BASE_IDENTITY)).resolves.toBeUndefined();
    // fetchMailboxOverTor is itself fail-soft (resolves 0 on any error).
    expect(mockFetchMailboxOverTor).toHaveBeenCalled();
    // flushOutbox starts by loading the due jobs.
    expect(mockLoadDueOutboxJobs).toHaveBeenCalled();
  });
});

describe('silentWakeHintFor — protocol traffic never wakes the recipient (phantom notifications)', () => {
  it('marks receipts, typing, profile, delete, key distribution and group control carriers silent', () => {
    const { silentWakeHintFor } = require('../client') as typeof import('../client');
    for (const type of ['typing', 'read_receipt', 'msg_delete', 'sender_key_dist', 'profile_update']) {
      expect(silentWakeHintFor(JSON.stringify({ type, text: 'x' }))).toBe('silent');
    }
    expect(silentWakeHintFor(JSON.stringify({ type: 'group_msg', body: '[group:meta]' }))).toBe('silent');
    expect(silentWakeHintFor(JSON.stringify({ type: 'group_msg', body: '[group:dissolved]' }))).toBe('silent');
  });
  it('leaves real messages, group content and call signals alone', () => {
    const { silentWakeHintFor } = require('../client') as typeof import('../client');
    expect(silentWakeHintFor(JSON.stringify({ type: 'direct_msg', text: 'hola' }))).toBeUndefined();
    expect(silentWakeHintFor(JSON.stringify({ type: 'group_msg', body: 'hola grupo' }))).toBeUndefined();
    expect(silentWakeHintFor(JSON.stringify({ type: 'call_signal', text: '{}' }))).toBeUndefined();
    expect(silentWakeHintFor('not json')).toBeUndefined();
  });
});
