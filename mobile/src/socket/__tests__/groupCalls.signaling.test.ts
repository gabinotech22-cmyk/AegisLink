/**
 * groupCalls.ts — sealed-sender signaling tests (Fase B)
 *
 * Group-call signaling is now sealed-sender: the relay never stamps `from`, so
 * every control/SDP/ICE body carries the sender's identity SEALED inside a NaCl
 * box, and the receiver recovers it by trial-decrypting against the call/group
 * roster. These tests use REAL crypto (tweetnacl is NOT mocked) with real
 * keypairs for self + simulated peers, so they exercise the actual seal → open
 * round-trip, prove no `from` leaks onto the wire, and prove a spoofed inner
 * identity is rejected.
 *
 * Socket is mocked at the module boundary; the real useGroupCall / useActiveCalls
 * Zustand stores are used so state transitions are verified without extra mocking.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

// ── Real keypairs (generated once) ─────────────────────────────────────────
// Declared with the `mock` prefix so the hoisted jest.mock() factories below may
// reference them. Populated in the top-level setup before any module loads them.
const mockSelfKp = nacl.box.keyPair();
const mockPeerAKp = nacl.box.keyPair();
const mockPeerBKp = nacl.box.keyPair();
const mockHostKp = nacl.box.keyPair();
const mockInitKp = nacl.box.keyPair();

const SELF = 'self-aegis-id';
const PEER_A = 'peer-A';
const PEER_B = 'peer-B';
const HOST = 'host-aegis';
const INIT = 'initiator-aegis-001';

// ── react-native-webrtc ────────────────────────────────────────────────────
jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn(),
  MediaStream: jest.fn(),
  RTCSessionDescription: jest.fn(),
  RTCIceCandidate: jest.fn(),
  mediaDevices: {
    getUserMedia: jest.fn().mockResolvedValue({
      getTracks: () => [],
      getAudioTracks: () => [],
    }),
  },
}));

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn().mockReturnValue('test-call-uuid') }));
jest.mock('expo-av', () => ({ Audio: { setAudioModeAsync: jest.fn().mockResolvedValue(undefined) } }));
jest.mock('../../webrtc/ice', () => ({ fetchTurnConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../webrtc/inCall', () => ({ startInCallAudio: jest.fn(), stopInCallAudio: jest.fn() }));
jest.mock('../../webrtc/callForegroundService', () => ({ startCallService: jest.fn(), stopCallService: jest.fn() }));
jest.mock('../../notifications/push', () => ({ showGroupCallChannelNotification: jest.fn() }));

jest.mock('../../webrtc/peer', () => ({
  createPeer: jest.fn().mockResolvedValue({ pc: {}, cleanup: jest.fn() }),
  createOffer: jest.fn().mockResolvedValue('sdp-offer'),
  setRemoteOffer: jest.fn().mockResolvedValue(undefined),
  createAnswer: jest.fn().mockResolvedValue('sdp-answer'),
  setRemoteAnswer: jest.fn().mockResolvedValue(undefined),
  addRemoteIce: jest.fn().mockResolvedValue(undefined),
}));

// ── store/contacts — real box public keys per peer ─────────────────────────
const mockContacts: Record<string, { publicKeyB64: string }> = {};
jest.mock('../../store/contacts', () => ({
  useContacts: { getState: () => ({ get: (id: string) => mockContacts[id] }) },
}));

// ── store/identity — our real box secret key + aegisId ─────────────────────
jest.mock('../../store/identity', () => ({
  useIdentity: {
    getState: () => ({ identity: { aegisId: SELF, secretKey: mockSelfKp.secretKey } }),
  },
}));

// ── store/groups — mutable trusted membership ──────────────────────────────
let mockGroups: Array<{ id: string; name: string; members: string[] }> = [];
jest.mock('../../store/groups', () => ({
  useGroups: { getState: () => ({ groups: mockGroups }) },
}));

// ── socket/client ──────────────────────────────────────────────────────────
const mockEmit = jest.fn();
const mockOn = jest.fn();
const mockOff = jest.fn();
const mockSocket = { emit: mockEmit, on: mockOn, off: mockOff };
let mockSocketReturnValue: typeof mockSocket | null = mockSocket;
const mockIsConnected = jest.fn().mockReturnValue(true);
jest.mock('../client', () => ({
  getSocket: () => mockSocketReturnValue,
  isConnected: () => mockIsConnected(),
}));

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
  NativeModules: {},
  StyleSheet: { create: (s: Record<string, unknown>) => s },
}));
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));

// ── Module under test + stores ─────────────────────────────────────────────
import { useGroupCall } from '../../store/groupCall';
import { useActiveCalls } from '../../store/activeCalls';
import {
  declineGroupCall,
  hangupGroupCall,
  startGroupCall,
  attachGroupCallHandlers,
} from '../groupCalls';

// ── Test helpers ────────────────────────────────────────────────────────────

/** Seal a signaling body AS `senderAegisId` would, addressed to self. Mirrors groupCalls' sealSignal. */
function sealFrom(senderKp: nacl.BoxKeyPair, senderAegisId: string, payload: string): { ciphertext: string; nonce: string } {
  const inner = { v: 1, from: senderAegisId, payload };
  const innerBytes = new TextEncoder().encode(JSON.stringify(inner));
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const ct = nacl.box(innerBytes, nonce, mockSelfKp.publicKey, senderKp.secretKey);
  return { ciphertext: encodeBase64(ct), nonce: encodeBase64(nonce) };
}

/** Open a wire that WE emitted (sealed by self) using the recipient's secret key. Returns the inner. */
function openAsRecipient(recipientKp: nacl.BoxKeyPair, wire: { ciphertext: string; nonce: string }): { v: number; from: string; payload: string } {
  const { decodeBase64 } = require('tweetnacl-util');
  const opened = nacl.box.open(decodeBase64(wire.ciphertext), decodeBase64(wire.nonce), mockSelfKp.publicKey, recipientKp.secretKey);
  if (!opened) throw new Error('open failed');
  return JSON.parse(new TextDecoder().decode(opened));
}

const flush = () => new Promise<void>((r) => setImmediate(r));

function handlerFor(event: string): (msg: unknown) => void {
  const call = (mockOn.mock.calls as [string, (...a: unknown[]) => void][]).find(([ev]) => ev === event);
  expect(call).toBeDefined();
  return call![1];
}

/** Every group_call:* payload the relay would receive must NOT carry a plaintext `from`. */
function assertNoFromOnAnyEmit(): void {
  for (const [, payload] of mockEmit.mock.calls as [string, Record<string, unknown>][]) {
    expect(payload).not.toHaveProperty('from');
    // The fan-out events must not carry a cleartext recipient/roster list either.
    expect(payload).not.toHaveProperty('participants');
    expect(payload).not.toHaveProperty('groupName');
  }
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('groupCalls sealed-sender signaling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSocketReturnValue = mockSocket;
    mockIsConnected.mockReturnValue(true);
    useGroupCall.getState().reset();
    mockGroups = [];
    for (const k of Object.keys(mockContacts)) delete mockContacts[k];
    mockContacts[PEER_A] = { publicKeyB64: encodeBase64(mockPeerAKp.publicKey) };
    mockContacts[PEER_B] = { publicKeyB64: encodeBase64(mockPeerBKp.publicKey) };
    mockContacts[HOST] = { publicKeyB64: encodeBase64(mockHostKp.publicKey) };
    mockContacts[INIT] = { publicKeyB64: encodeBase64(mockInitKp.publicKey) };
    for (const gid of Object.keys(useActiveCalls.getState().calls)) useActiveCalls.getState().remove(gid);
  });

  afterEach(() => useGroupCall.getState().reset());

  // ── Listener registration + early returns (no crypto) ──────────────────────

  it('attachGroupCallHandlers registers all group_call:* listeners', () => {
    attachGroupCallHandlers();
    const events = (mockOn.mock.calls as [string, unknown][]).map(([ev]) => ev);
    for (const ev of ['group_call:accept', 'group_call:decline', 'group_call:offer', 'group_call:answer', 'group_call:ice', 'group_call:channel', 'group_call:hangup']) {
      expect(events).toContain(ev);
    }
  });

  it('startGroupCall returns early (no emit, no throw) when getSocket() is null', async () => {
    mockSocketReturnValue = null;
    const identity = { aegisId: SELF, publicKeyB64: 'pk', secretKey: mockSelfKp.secretKey } as Parameters<typeof startGroupCall>[0];
    await expect(startGroupCall(identity, { id: 'g', name: 'G', members: [] }, [PEER_A])).resolves.toBeUndefined();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('hangupGroupCall is a no-op (no emit) when callId is null', () => {
    hangupGroupCall();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ── Emit shapes: sealed, no `from`, recipient can authenticate us ──────────

  it('declineGroupCall emits a SEALED decline (no plaintext from; body authenticates self)', () => {
    declineGroupCall('call-abc', INIT);

    expect(mockEmit).toHaveBeenCalledTimes(1);
    const [event, payload] = mockEmit.mock.calls[0] as [string, Record<string, unknown>];
    expect(event).toBe('group_call:decline');
    expect(payload).toMatchObject({ callId: 'call-abc', to: INIT });
    expect(payload.ciphertext).toEqual(expect.any(String));
    expect(payload.nonce).toEqual(expect.any(String));
    expect(payload).not.toHaveProperty('from');
    // The initiator (recipient) opens it → our identity is sealed inside.
    const inner = openAsRecipient(mockInitKp, payload as { ciphertext: string; nonce: string });
    expect(inner.from).toBe(SELF);
  });

  it('hangupGroupCall emits a per-recipient SEALED fan-out (items[], no plaintext to[]/from)', () => {
    mockGroups = [{ id: 'g-2', name: 'Beta', members: [SELF, PEER_A, PEER_B] }];
    useGroupCall.getState().startOutgoing('call-xyz', 'g-2', 'Beta', [PEER_A, PEER_B]);
    useGroupCall.getState().setStatus('in-call');

    hangupGroupCall();

    const hangup = (mockEmit.mock.calls as [string, Record<string, unknown>][]).find(([e]) => e === 'group_call:hangup');
    expect(hangup).toBeDefined();
    const payload = hangup![1] as { callId: string; items: Array<{ to: string; ciphertext: string; nonce: string }> };
    expect(payload.callId).toBe('call-xyz');
    expect(payload.items).toHaveLength(2);
    expect(payload.items.map((i) => i.to).sort()).toEqual([PEER_A, PEER_B]);
    expect(payload).not.toHaveProperty('from');
    expect(payload).not.toHaveProperty('to');
    // Each item authenticates us to its specific recipient.
    const toA = payload.items.find((i) => i.to === PEER_A)!;
    expect(openAsRecipient(mockPeerAKp, toA).from).toBe(SELF);
    assertNoFromOnAnyEmit();
  });

  it('startGroupCall heartbeat seals the roster (no cleartext participants/groupName on the wire)', async () => {
    mockGroups = [{ id: 'g-hb', name: 'Heartbeat', members: [SELF, PEER_A, PEER_B] }];
    const identity = { aegisId: SELF, publicKeyB64: 'pk', secretKey: mockSelfKp.secretKey } as Parameters<typeof startGroupCall>[0];

    await startGroupCall(identity, { id: 'g-hb', name: 'Heartbeat', members: [SELF, PEER_A, PEER_B] }, [PEER_A, PEER_B]);

    const channel = (mockEmit.mock.calls as [string, Record<string, unknown>][]).find(([e]) => e === 'group_call:channel');
    expect(channel).toBeDefined();
    const payload = channel![1] as { callId: string; groupId: string; media: string; items: Array<{ to: string; ciphertext: string; nonce: string }> };
    expect(payload.groupId).toBe('g-hb');           // routing stays cleartext
    expect(payload.media).toBe('audio');
    expect(payload.items.length).toBe(2);            // one sealed copy per recipient
    expect(payload).not.toHaveProperty('from');
    expect(payload).not.toHaveProperty('participants'); // roster is NOT in cleartext
    expect(payload).not.toHaveProperty('groupName');
    // The sealed body carries the roster + group name to the recipient only.
    const inner = openAsRecipient(mockPeerAKp, payload.items.find((i) => i.to === PEER_A)!);
    const body = JSON.parse(inner.payload) as { groupName: string; participants: string[] };
    expect(body.groupName).toBe('Heartbeat');
    expect(body.participants).toContain(SELF);
    expect(inner.from).toBe(SELF);
    assertNoFromOnAnyEmit();
  });

  // ── Handler round-trip + authentication ────────────────────────────────────

  it('group_call:offer handler opens a sealed offer, adds the peer, and answers (sealed, no from)', async () => {
    mockGroups = [{ id: 'g-off', name: 'Off', members: [SELF, PEER_A] }];
    useGroupCall.getState().startOutgoing('call-off', 'g-off', 'Off', [], SELF);
    useGroupCall.getState().setStatus('in-call');

    attachGroupCallHandlers();
    handlerFor('group_call:offer')({ callId: 'call-off', ...sealFrom(mockPeerAKp, PEER_A, 'remote-offer-sdp') });
    await flush();
    await flush();

    // peer-A was recovered from the sealed body and added to the roster.
    expect(useGroupCall.getState().participants.map((p) => p.aegisId)).toContain(PEER_A);
    // …and we answered them, sealed, with no plaintext from.
    const answer = (mockEmit.mock.calls as [string, Record<string, unknown>][]).find(([e]) => e === 'group_call:answer');
    expect(answer).toBeDefined();
    const payload = answer![1] as Record<string, unknown>;
    expect(payload).toMatchObject({ callId: 'call-off', to: PEER_A });
    expect(payload).not.toHaveProperty('from');
    expect(openAsRecipient(mockPeerAKp, payload as { ciphertext: string; nonce: string }).from).toBe(SELF);
  });

  it('group_call:offer handler REJECTS a spoofed inner identity (sealed by A, claims B)', async () => {
    mockGroups = [{ id: 'g-spoof', name: 'Spoof', members: [SELF, PEER_A, PEER_B] }];
    useGroupCall.getState().startOutgoing('call-spoof', 'g-spoof', 'Spoof', [], SELF);
    useGroupCall.getState().setStatus('in-call');

    // peer-A seals the body but claims to be peer-B inside.
    const spoofed = sealFrom(mockPeerAKp, PEER_B, 'evil-offer');
    attachGroupCallHandlers();
    handlerFor('group_call:offer')({ callId: 'call-spoof', ...spoofed });
    await flush();
    await flush();

    // Neither identity is accepted: B's key can't open A's box, and A's key opens
    // it but the inner `from` (B) won't match A → trial yields nothing.
    expect(useGroupCall.getState().participants.map((p) => p.aegisId)).not.toContain(PEER_B);
    expect(useGroupCall.getState().participants.map((p) => p.aegisId)).not.toContain(PEER_A);
    expect((mockEmit.mock.calls as [string][]).some(([e]) => e === 'group_call:answer')).toBe(false);
  });

  // ── Channel banner from a sealed heartbeat ─────────────────────────────────

  it('group_call:channel handler upserts a banner from a sealed heartbeat (trusted member)', () => {
    mockGroups = [{ id: 'g-ch', name: 'Delta', members: [INIT, SELF] }];
    attachGroupCallHandlers();

    handlerFor('group_call:channel')({
      callId: 'call-ch',
      groupId: 'g-ch',
      media: 'audio',
      ...sealFrom(mockInitKp, INIT, JSON.stringify({ groupName: 'Delta', participants: [INIT] })),
    });

    const banner = useActiveCalls.getState().calls['g-ch'];
    expect(banner).toBeDefined();
    expect(banner.callId).toBe('call-ch');
    expect(banner.initiator).toBe(INIT);
    expect(banner.participants).toEqual([INIT]);
  });

  it('group_call:channel handler DROPS a heartbeat it cannot authenticate against the roster', () => {
    // The sealing key (a stranger) is not a member → not a trial candidate → drop.
    const strangerKp = nacl.box.keyPair();
    mockGroups = [{ id: 'g-strange', name: 'NG', members: [SELF] }];
    attachGroupCallHandlers();

    handlerFor('group_call:channel')({
      callId: 'call-strange',
      groupId: 'g-strange',
      media: 'audio',
      ...sealFrom(strangerKp, 'stranger-aegis', JSON.stringify({ groupName: 'NG', participants: ['stranger-aegis'] })),
    });

    expect(useActiveCalls.getState().calls['g-strange']).toBeUndefined();
  });

  it('group_call:channel with a sealed EMPTY roster closes the banner', () => {
    mockGroups = [{ id: 'g-close', name: 'Closers', members: [INIT, SELF] }];
    attachGroupCallHandlers();
    const channel = handlerFor('group_call:channel');

    channel({ callId: 'call-close', groupId: 'g-close', media: 'audio', ...sealFrom(mockInitKp, INIT, JSON.stringify({ groupName: 'Closers', participants: [INIT] })) });
    expect(useActiveCalls.getState().calls['g-close']).toBeDefined();

    channel({ callId: 'call-close', groupId: 'g-close', media: 'audio', ...sealFrom(mockInitKp, INIT, JSON.stringify({ groupName: 'Closers', participants: [] })) });
    expect(useActiveCalls.getState().calls['g-close']).toBeUndefined();
  });

  // ── Hangup handler ─────────────────────────────────────────────────────────

  it('group_call:hangup handler removes the (authenticated) leaver from the roster', () => {
    mockGroups = [{ id: 'g-roster', name: 'Roster', members: [SELF, PEER_A, PEER_B, HOST] }];
    useGroupCall.getState().startOutgoing('call-roster', 'g-roster', 'Roster', [PEER_A, PEER_B], HOST);
    useGroupCall.getState().setStatus('in-call');

    attachGroupCallHandlers();
    handlerFor('group_call:hangup')({ callId: 'call-roster', ...sealFrom(mockPeerAKp, PEER_A, '') });

    expect(useGroupCall.getState().participants.map((p) => p.aegisId)).toEqual([PEER_B]);
    expect(useGroupCall.getState().status).toBe('in-call');
  });

  it('group_call:hangup from the host ends the call for an active participant', () => {
    mockGroups = [{ id: 'g-join', name: 'Joiners', members: [SELF, HOST, PEER_B] }];
    useGroupCall.getState().startOutgoing('call-join', 'g-join', 'Joiners', [HOST, PEER_B], HOST);
    useGroupCall.getState().setStatus('in-call');

    attachGroupCallHandlers();
    handlerFor('group_call:hangup')({ callId: 'call-join', ...sealFrom(mockHostKp, HOST, '') });

    expect(useGroupCall.getState().status).toBe('ended');
  });
});
