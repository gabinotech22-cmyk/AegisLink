/**
 * Group dissolution over the E2EE channel (mobile/src/socket/client.ts).
 *
 * Field bug: the group admin "deleting" a group (GroupAdmin.tsx danger zone)
 * only wiped it LOCALLY (leaveGroup) — every other member kept the group and
 * its history alive forever. The fix broadcasts a signed dissolution marker
 * (`dissolved: true` + `dissolveSig`, see crypto/groupSig.ts
 * canonicalGroupDissolveBytes) riding the existing group_msg carrier, verified
 * against the group's CURRENT adminId before being honored.
 *
 * This is security-critical: an unauthenticated dissolve would let ANY sender
 * remotely wipe a group for every member. These tests lock:
 *   - a verified dissolve from the real admin wipes the group locally.
 *   - a dissolve claiming to be from the admin, but sent by a NON-admin member
 *     (sealed-sender-authenticated contact != group.adminId), is ignored.
 *   - a dissolve from the admin with an INVALID signature is ignored.
 *
 * Harness mirrors client.deleteForEveryone.test.ts: everything mocked, we
 * drive the registered `envelope` handler with genuinely encrypted+signed
 * wires (real tweetnacl, not mocked) so signature verification is real.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { encryptMessage } from '../../crypto/messaging';
import { initRatchet, type RatchetState } from '../../crypto/signal/ratchet';
import { signGroupDissolve } from '../../crypto/groupSig';

// ── db/local mock with in-memory ratchet sessions + a group table ──────────
const mockRatchetSessions = new Map<string, string>();
const mockGroups = new Map<string, unknown>();
const mockDeleteGroup = jest.fn(async (id: string) => {
  mockGroups.delete(id);
});
const mockDeleteContactMessages = jest.fn(async (_id: string) => undefined);

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
  getGroup: jest.fn(async (id: string) => (mockGroups.get(id) as never) ?? null),
  saveGroup: jest.fn(async (g: { id: string }) => {
    mockGroups.set(g.id, g);
  }),
  deleteGroup: (...args: [string]) => mockDeleteGroup(...args),
  deleteContactMessages: (...args: [string]) => mockDeleteContactMessages(...args),
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

const mockRemoteDelete = jest.fn(async () => undefined);
const mockAppend = jest.fn(async () => undefined);
const mockUpdateDelivery = jest.fn(async () => undefined);
const mockClearChat = jest.fn();
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
      clearChat: mockClearChat,
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

const mockHydrate = jest.fn();
const mockGroupsSetState = jest.fn(
  (updater: (s: { groups: Array<{ id: string }> }) => { groups: Array<{ id: string }> }) => {
    updater({ groups: [] });
  },
);
jest.mock('../../store/groups', () => ({
  __esModule: true,
  useGroups: { getState: () => ({ hydrate: mockHydrate }), setState: (...args: unknown[]) => mockGroupsSetState(...(args as [never])) },
}));
jest.mock('../../store/preferences', () => ({
  __esModule: true,
  usePreferences: { getState: () => ({ requireGroupApproval: false }) },
}));
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
  } as Identity;
}

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

function bringOnline() {
  mockFakeSocket.handlers.get('connect')!();
  mockFakeSocket.handlers.get('auth:ok')!({ opkCount: 100 });
}

const flush = () => new Promise((r) => setImmediate(r));

const GROUP_ID = 'g-shared';
const GROUP_CREATED_AT = 1_700_000_000_000;

describe('group dissolution over the E2EE channel', () => {
  let client: typeof import('../client');

  beforeEach(() => {
    jest.resetModules();
    mockRatchetSessions.clear();
    mockGroups.clear();
    mockContactsState.contacts = [];
    mockIdentityState.identity = null;
    mockRemoteDelete.mockClear();
    mockAppend.mockClear();
    mockUpdateDelivery.mockClear();
    mockClearChat.mockClear();
    mockDeleteGroup.mockClear();
    mockDeleteContactMessages.mockClear();
    mockGroupsSetState.mockClear();
    client = require('../client') as typeof import('../client');
  });

  afterEach(() => {
    client.disconnect();
  });

  it('a verified dissolve from the real admin wipes the group locally', async () => {
    const me = buildIdentity();
    const admin = buildIdentity(); // peer IS the group admin

    client.connect(me);
    bringOnline();
    await flush();

    mockContactsState.contacts = [
      { aegisId: admin.aegisId, publicKeyB64: admin.publicKeyB64, signingPublicKeyB64: admin.signingPublicKeyB64 },
    ];
    mockGroups.set(GROUP_ID, {
      id: GROUP_ID,
      name: 'Team',
      members: [me.aegisId, admin.aegisId],
      createdAt: GROUP_CREATED_AT,
      adminId: admin.aegisId,
      adminSig: 'irrelevant-for-this-test==',
    });

    const senderState = establishSyncedSession(me, admin);

    const dissolveSig = signGroupDissolve(
      { groupId: GROUP_ID, adminId: admin.aegisId, createdAt: GROUP_CREATED_AT },
      admin.signingSecretKey,
    );
    const payload = JSON.stringify({
      type: 'group_msg',
      groupId: GROUP_ID,
      groupName: 'Team',
      members: [me.aegisId, admin.aegisId],
      groupCreatedAt: GROUP_CREATED_AT,
      adminId: admin.aegisId,
      adminSig: 'irrelevant-for-this-test==',
      dissolved: true,
      dissolveAdminId: admin.aegisId,
      dissolveSig,
      senderId: admin.aegisId,
      senderName: 'Admin',
      senderColor: '#fff',
      senderImage: null,
      body: '[group:dissolved]',
    });
    const { envelope } = encryptMessage(payload, admin.aegisId, me.publicKey, admin.secretKey, senderState);

    await mockFakeSocket.handlers.get('envelope')!({
      id: 'env-dissolve-1',
      from: admin.aegisId,
      to: me.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
    await flush();

    expect(mockDeleteContactMessages).toHaveBeenCalledWith(GROUP_ID);
    expect(mockDeleteGroup).toHaveBeenCalledWith(GROUP_ID);
    expect(mockClearChat).toHaveBeenCalledWith(GROUP_ID);
    // No chat bubble rendered for the dissolve carrier.
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('rejects a dissolve claiming the admin role but sent by a NON-admin member', async () => {
    const me = buildIdentity();
    const admin = buildIdentity();
    const impostor = buildIdentity(); // a regular member, NOT group.adminId

    client.connect(me);
    bringOnline();
    await flush();

    mockContactsState.contacts = [
      { aegisId: impostor.aegisId, publicKeyB64: impostor.publicKeyB64, signingPublicKeyB64: impostor.signingPublicKeyB64 },
    ];
    mockGroups.set(GROUP_ID, {
      id: GROUP_ID,
      name: 'Team',
      members: [me.aegisId, admin.aegisId, impostor.aegisId],
      createdAt: GROUP_CREATED_AT,
      adminId: admin.aegisId, // real admin is `admin`, NOT `impostor`
      adminSig: 'irrelevant-for-this-test==',
    });

    const senderState = establishSyncedSession(me, impostor);

    // Impostor cannot produce a signature the admin's key would verify, but
    // even if it forged some string, the sealed-sender-authenticated sender
    // (impostor) does not match existingGroup.adminId — must be rejected
    // before any signature check even matters.
    const bogusSig = signGroupDissolve(
      { groupId: GROUP_ID, adminId: admin.aegisId, createdAt: GROUP_CREATED_AT },
      impostor.signingSecretKey, // signed with the WRONG key
    );
    const payload = JSON.stringify({
      type: 'group_msg',
      groupId: GROUP_ID,
      groupName: 'Team',
      members: [me.aegisId, admin.aegisId, impostor.aegisId],
      groupCreatedAt: GROUP_CREATED_AT,
      adminId: admin.aegisId,
      adminSig: 'irrelevant-for-this-test==',
      dissolved: true,
      dissolveAdminId: admin.aegisId, // impostor CLAIMS to be signing for the admin
      dissolveSig: bogusSig,
      senderId: impostor.aegisId,
      senderName: 'Impostor',
      senderColor: '#fff',
      senderImage: null,
      body: '[group:dissolved]',
    });
    const { envelope } = encryptMessage(payload, impostor.aegisId, me.publicKey, impostor.secretKey, senderState);

    await mockFakeSocket.handlers.get('envelope')!({
      id: 'env-dissolve-2',
      from: impostor.aegisId,
      to: me.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
    await flush();

    expect(mockDeleteGroup).not.toHaveBeenCalled();
    expect(mockDeleteContactMessages).not.toHaveBeenCalled();
    expect(mockClearChat).not.toHaveBeenCalled();
  });

  it('rejects a dissolve from the real admin sender with an INVALID signature', async () => {
    const me = buildIdentity();
    const admin = buildIdentity();

    client.connect(me);
    bringOnline();
    await flush();

    mockContactsState.contacts = [
      { aegisId: admin.aegisId, publicKeyB64: admin.publicKeyB64, signingPublicKeyB64: admin.signingPublicKeyB64 },
    ];
    mockGroups.set(GROUP_ID, {
      id: GROUP_ID,
      name: 'Team',
      members: [me.aegisId, admin.aegisId],
      createdAt: GROUP_CREATED_AT,
      adminId: admin.aegisId,
      adminSig: 'irrelevant-for-this-test==',
    });

    const senderState = establishSyncedSession(me, admin);

    // Sign over the WRONG createdAt — signature will not verify against the
    // group's real createdAt, simulating a corrupted/forged signature.
    const invalidSig = signGroupDissolve(
      { groupId: GROUP_ID, adminId: admin.aegisId, createdAt: GROUP_CREATED_AT + 1 },
      admin.signingSecretKey,
    );
    const payload = JSON.stringify({
      type: 'group_msg',
      groupId: GROUP_ID,
      groupName: 'Team',
      members: [me.aegisId, admin.aegisId],
      groupCreatedAt: GROUP_CREATED_AT,
      adminId: admin.aegisId,
      adminSig: 'irrelevant-for-this-test==',
      dissolved: true,
      dissolveAdminId: admin.aegisId,
      dissolveSig: invalidSig,
      senderId: admin.aegisId,
      senderName: 'Admin',
      senderColor: '#fff',
      senderImage: null,
      body: '[group:dissolved]',
    });
    const { envelope } = encryptMessage(payload, admin.aegisId, me.publicKey, admin.secretKey, senderState);

    await mockFakeSocket.handlers.get('envelope')!({
      id: 'env-dissolve-3',
      from: admin.aegisId,
      to: me.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
    await flush();

    expect(mockDeleteGroup).not.toHaveBeenCalled();
    expect(mockDeleteContactMessages).not.toHaveBeenCalled();
    expect(mockClearChat).not.toHaveBeenCalled();
  });
});
