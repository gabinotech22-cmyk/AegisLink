/**
 * sendGroupMessage — skipLocalAppend regression test
 *
 * Verifies that:
 * 1. When skipLocalAppend is true, useMessages.getState().append is NOT called
 *    by sendGroupMessage (caller already pre-appended the bubble).
 * 2. When skipLocalAppend is absent/false and the group has no members besides
 *    self (so no fan-out happens), append IS called once with the local message.
 *
 * Uses the offline path (socket=null) for isolation. With the new outbox pattern
 * sendGroupMessage always loads the group first, then fans out per member,
 * enqueues outbox jobs, and appends locally if !skipLocalAppend.
 *
 * NOTE: The online path (full multicast loop) is exercised by integration tests
 * in GroupChat.voice.test.tsx where sendGroupMessage is mocked at the boundary.
 * Here we test the module internals directly.
 */

// ── db/local (required inline inside sendGroupMessage) ────────────────────────
const mockGetGroup = jest.fn();
const mockSaveGroup = jest.fn();
const mockEnqueueOutboxJob = jest.fn().mockResolvedValue(undefined);
const mockDeleteOutboxJob = jest.fn().mockResolvedValue(undefined);
const mockIncrementOutboxAttempts = jest.fn().mockResolvedValue(undefined);
const mockLoadOutboxJobs = jest.fn().mockResolvedValue([]);

jest.mock('../../db/local', () => ({
  __esModule: true,
  getGroup: (...args: unknown[]) => mockGetGroup(...args),
  saveGroup: (...args: unknown[]) => mockSaveGroup(...args),
  loadRatchetSession: jest.fn().mockResolvedValue(null),
  saveRatchetSession: jest.fn().mockResolvedValue(undefined),
  getActiveDbSlot: () => 'self',
  enqueueOutboxJob: (...args: unknown[]) => mockEnqueueOutboxJob(...args),
  deleteOutboxJob: (...args: unknown[]) => mockDeleteOutboxJob(...args),
  incrementOutboxAttempts: (...args: unknown[]) => mockIncrementOutboxAttempts(...args),
  loadOutboxJobs: (...args: unknown[]) => mockLoadOutboxJobs(...args),
}));

// ── store/contacts ────────────────────────────────────────────────────────────
jest.mock('../../store/contacts', () => ({
  __esModule: true,
  useContacts: {
    getState: () => ({ contacts: [] }),
  },
}));

// ── store/messages (the target of append) ─────────────────────────────────────
const mockAppend = jest.fn().mockResolvedValue(undefined);

jest.mock('../../store/messages', () => ({
  __esModule: true,
  useMessages: {
    getState: () => ({
      append: mockAppend,
      getEphemeralTimer: jest.fn().mockReturnValue(0),
    }),
  },
}));

// ── store/identity ────────────────────────────────────────────────────────────
jest.mock('../../store/identity', () => ({
  __esModule: true,
  useIdentity: {
    getState: () => ({
      displayName: 'Me',
      avatarColor: '#00FF88',
      avatarImage: null,
      profileStatus: undefined,
    }),
  },
}));

// ── store/preferences ─────────────────────────────────────────────────────────
jest.mock('../../store/preferences', () => ({
  __esModule: true,
  usePreferences: { getState: () => ({ onionRouting: false }) },
}));

// ── api (looked up during session creation) ───────────────────────────────────
jest.mock('../../api', () => ({
  __esModule: true,
  lookupIdentity: jest.fn().mockResolvedValue(null),
  ApiError: class ApiError extends Error {},
}));

// ── crypto/* ──────────────────────────────────────────────────────────────────
jest.mock('../../crypto/messaging', () => ({
  encryptMessage: jest.fn().mockReturnValue({
    envelope: { ciphertextB64: 'ct==', nonceB64: 'nc==' },
    newState: {},
  }),
  openEnvelope: jest.fn(),
}));

jest.mock('../../crypto/signal/x3dh', () => ({
  performX3DH: jest.fn(),
  performX3DHReceiver: jest.fn(),
  generatePreKeys: jest.fn(),
}));

jest.mock('../../crypto/signal/ratchet', () => ({
  initRatchet: jest.fn().mockReturnValue({}),
  ratchetEncrypt: jest.fn(),
  ratchetDecrypt: jest.fn(),
  trimOldSkippedKeys: jest.fn(),
  MAX_SKIPPED_KEYS: 1000,
}));

// ── expo-crypto ───────────────────────────────────────────────────────────────
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn().mockReturnValue('test-uuid') }));

// ── expo-secure-store ─────────────────────────────────────────────────────────
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

// ── tweetnacl ─────────────────────────────────────────────────────────────────
jest.mock('tweetnacl', () => ({
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
}));

jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn(() => 'base64=='),
  decodeBase64: jest.fn(() => new Uint8Array(32)),
  encodeUTF8: jest.fn(() => new Uint8Array(4)),
  decodeUTF8: jest.fn(() => 'text'),
}));

// ── socket/client — socket is null (offline) ──────────────────────────────────
// With the new outbox pattern, sendGroupMessage always loads the group, fans out
// per member (enqueuing outbox jobs), then appends locally if !skipLocalAppend.

import { sendGroupMessage } from '../client';
import type { Identity } from '../../crypto/identity';

const mockIdentity: Identity = {
  aegisId: 'self-id',
  publicKey: new Uint8Array(32),
  secretKey: new Uint8Array(32),
  publicKeyB64: 'cHVia2V5',
  secretKeyB64: 'c2VjcmV0',
  signingPublicKey: new Uint8Array(32),
  signingSecretKey: new Uint8Array(64),
  signingPublicKeyB64: 'c2lnbmluZw==',
  signingSecretKeyB64: 'c2lnU2VjcmV0',
  createdAt: 0,
};

/** A group where the only member is the sender — no per-member fan-out occurs. */
const groupOnlySelf = {
  id: 'g-1',
  name: 'Test Group',
  members: ['self-id'],
  createdAt: 0,
  adminId: 'self-id',
  adminSig: 'c2lnPT0=', // pre-set so signGroupMetadata is NOT called
  avatarColor: null,
  avatarImage: null,
};

describe('sendGroupMessage — skipLocalAppend', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetGroup.mockResolvedValue(groupOnlySelf);
  });

  it('does NOT call useMessages.append when skipLocalAppend is true (offline path)', async () => {
    await sendGroupMessage({
      identity: mockIdentity,
      groupId: 'g-1',
      plaintext: '[image:blob:id:key:nonce]',
      msgType: 'image',
      mediaUri: 'blob:id:key:nonce',
      skipLocalAppend: true,
    });

    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('calls useMessages.append once when skipLocalAppend is absent and send completes', async () => {
    await sendGroupMessage({
      identity: mockIdentity,
      groupId: 'g-1',
      plaintext: 'hello world',
    });

    // Group has only self as member → no per-member fan-out, local append runs
    expect(mockAppend).toHaveBeenCalledTimes(1);
    expect(mockAppend).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: 'g-1', direction: 'out' }),
    );
  });

  it('sendGroupMessage accepts skipLocalAppend:true without TypeScript error at call-site', async () => {
    // This is a compile-time assertion — if skipLocalAppend is not in the type,
    // tsc --noEmit will fail. The runtime path is the same offline test.
    const opts: Parameters<typeof sendGroupMessage>[0] = {
      identity: mockIdentity,
      groupId: 'g-test',
      plaintext: 'text',
      skipLocalAppend: true,
    };
    mockGetGroup.mockResolvedValue({ ...groupOnlySelf, id: 'g-test' });
    await sendGroupMessage(opts);
    expect(mockAppend).not.toHaveBeenCalled();
  });
});
