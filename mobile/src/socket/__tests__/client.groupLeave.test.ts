/**
 * [group:left] over the E2EE channel — leaving a group is no longer local-only.
 *
 *   1. A member's left marker makes a NON-admin receiver drop them from the
 *      local roster (no bubble).
 *   2. The same marker makes the ADMIN receiver run removeMember (re-sign,
 *      re-key, broadcast).
 *   3. A message for a group WE left is dropped (not recreated) unless it is
 *      the admin re-inviting us with a roster that includes us.
 * Same harness as client.groupDissolve.test.ts.
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
const mockRemoveMember = jest.fn(async () => undefined);
jest.mock('../../store/groups', () => ({
  __esModule: true,
  useGroups: { getState: () => ({ hydrate: mockHydrate, removeMember: mockRemoveMember }), setState: (...args: unknown[]) => mockGroupsSetState(...(args as [never])) },
}));
const mockPrefSet = jest.fn(async (_k: unknown, _v: unknown) => undefined);
const mockPrefs = { requireGroupApproval: false, leftGroupIds: [] as string[], set: (k: unknown, v: unknown) => mockPrefSet(k, v) };
jest.mock('../../store/preferences', () => ({
  __esModule: true,
  usePreferences: { getState: () => mockPrefs },
}));
jest.mock('../../crypto/channelKeyStore', () => ({ __esModule: true, deleteSenderKey: jest.fn(async () => undefined) }));
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
import { identityFromRaw } from '../../crypto/__tests__/helpers/rawIdentity';
import { serializeRatchetState } from '../ratchetSerde';

function buildIdentity(): Identity {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair();
  return identityFromRaw(box, sign, 'AEGIS' + encodeBase64(box.publicKey).slice(0, 6));
}

function persistSession(aegisId: string, state: RatchetState): void {
  mockRatchetSessions.set(aegisId, serializeRatchetState(state));
}

function establishSyncedSession(me: Identity, peer: Identity): RatchetState {
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

function bringOnline() {
  mockFakeSocket.handlers.get('connect')!();
  mockFakeSocket.handlers.get('auth:ok')!({ opkCount: 100 });
}

const flush = () => new Promise((r) => setImmediate(r));

const GROUP_ID = 'g-shared';
const GROUP_CREATED_AT = 1_700_000_000_000;

describe('[group:left] over the E2EE channel', () => {
  let client: typeof import('../client');

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    mockRatchetSessions.clear();
    mockGroups.clear();
    mockPrefs.leftGroupIds = [];
    mockContactsState.contacts = [];
    mockIdentityState.identity = null;
    client = require('../client') as typeof import('../client');
  });

  afterEach(() => {
    client.disconnect();
  });

  function leftPayload(sender: Identity, me: Identity, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: 'group_msg', groupId: GROUP_ID, groupName: 'Team', members: [me.aegisId, sender.aegisId, 'peer-x'],
      groupCreatedAt: GROUP_CREATED_AT, adminId: 'peer-x', adminSig: 'irrelevant==', left: true,
      senderId: sender.aegisId, senderName: 'S', senderColor: '#fff', senderImage: null, body: '[group:left]', ...extra,
    });
  }

  async function deliver(sender: Identity, me: Identity, payload: string, id: string): Promise<void> {
    const senderState = establishSyncedSession(me, sender);
    const { envelope } = encryptMessage(payload, sender.aegisId, me.publicKey, sender.secretKey, senderState);
    await mockFakeSocket.handlers.get('envelope')!({ id, from: sender.aegisId, to: me.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 });
    await flush();
  }

  it('a non-admin receiver drops the leaver from the local roster, no bubble', async () => {
    const me = buildIdentity();
    const leaver = buildIdentity();
    client.connect(me); bringOnline(); await flush();
    mockContactsState.contacts = [{ aegisId: leaver.aegisId, publicKeyB64: leaver.publicKeyB64, signingPublicKeyB64: leaver.signingPublicKeyB64 }];
    mockGroups.set(GROUP_ID, { id: GROUP_ID, name: 'Team', members: [me.aegisId, leaver.aegisId, 'peer-x'], createdAt: GROUP_CREATED_AT, adminId: 'peer-x', adminSig: 'x==' });

    await deliver(leaver, me, leftPayload(leaver, me), 'env-left-1');

    const g = mockGroups.get(GROUP_ID) as { members: string[] };
    expect(g.members).toEqual([me.aegisId, 'peer-x']);
    expect(mockHydrate).toHaveBeenCalled();
    expect(mockRemoveMember).not.toHaveBeenCalled();
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('the admin receiver re-signs and re-keys through removeMember', async () => {
    const me = buildIdentity();
    const leaver = buildIdentity();
    client.connect(me); bringOnline(); await flush();
    mockContactsState.contacts = [{ aegisId: leaver.aegisId, publicKeyB64: leaver.publicKeyB64, signingPublicKeyB64: leaver.signingPublicKeyB64 }];
    mockGroups.set(GROUP_ID, { id: GROUP_ID, name: 'Team', members: [me.aegisId, leaver.aegisId], createdAt: GROUP_CREATED_AT, adminId: me.aegisId, adminSig: 'x==' });

    await deliver(leaver, me, leftPayload(leaver, me, { adminId: me.aegisId }), 'env-left-2');

    expect(mockRemoveMember).toHaveBeenCalledWith(GROUP_ID, leaver.aegisId);
    expect(mockAppend).not.toHaveBeenCalled();
  });

  it('a message for a group we left is dropped, unless the admin re-invites us', async () => {
    const me = buildIdentity();
    const peer = buildIdentity();
    client.connect(me); bringOnline(); await flush();
    mockContactsState.contacts = [{ aegisId: peer.aegisId, publicKeyB64: peer.publicKeyB64, signingPublicKeyB64: peer.signingPublicKeyB64 }];
    mockPrefs.leftGroupIds = [GROUP_ID];

    // Straggler (non-admin) still sending to the group: nothing is recreated.
    await deliver(peer, me, JSON.stringify({
      type: 'group_msg', groupId: GROUP_ID, groupName: 'Team', members: [me.aegisId, peer.aegisId], groupCreatedAt: GROUP_CREATED_AT,
      adminId: 'someone-else', adminSig: 'x==', senderId: peer.aegisId, senderName: 'P', senderColor: '#fff', senderImage: null, body: 'hola',
    }), 'env-straggler');
    expect(mockGroups.has(GROUP_ID)).toBe(false);
    expect(mockAppend).not.toHaveBeenCalled();
    expect(mockPrefSet).not.toHaveBeenCalled();

    // The admin re-inviting us clears the memory (the rest of the pipeline then
    // decides whether the signed roster is trusted — out of scope here).
    await deliver(peer, me, JSON.stringify({
      type: 'group_msg', groupId: GROUP_ID, groupName: 'Team', members: [me.aegisId, peer.aegisId], groupCreatedAt: GROUP_CREATED_AT,
      adminId: peer.aegisId, adminSig: 'x==', senderId: peer.aegisId, senderName: 'P', senderColor: '#fff', senderImage: null, body: '[group:meta]',
    }), 'env-reinvite');
    expect(mockPrefSet).toHaveBeenCalledWith('leftGroupIds', []);
  });
});
