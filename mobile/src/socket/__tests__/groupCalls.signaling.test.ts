/**
 * groupCalls.ts — signaling layer unit tests
 *
 * Covers:
 * 1. declineGroupCall emits group_call:decline with { callId, to: initiatorAegisId }
 * 2. hangupGroupCall emits group_call:hangup and calls useGroupCall.getState().reset()
 * 3. startGroupCall with no socket (returns early, does not throw)
 * 4. attachGroupCallHandlers registers a group_call:invite listener
 * 5. attachGroupCallHandlers registers a group_call:accept listener
 * 6. group_call:invite handler calls useGroupCall.getState().startIncoming(...) with correct args
 *
 * Socket is mocked at the module boundary via getSocket() / isConnected() in
 * ../client. The real useGroupCall Zustand store is used so state transitions
 * can be verified without extra mocking ceremony.
 */

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

// ── expo-crypto ────────────────────────────────────────────────────────────
jest.mock('expo-crypto', () => ({
  randomUUID: jest.fn().mockReturnValue('test-call-uuid'),
}));

// ── expo-av ────────────────────────────────────────────────────────────────
jest.mock('expo-av', () => ({
  Audio: {
    setAudioModeAsync: jest.fn().mockResolvedValue(undefined),
  },
}));

// ── tweetnacl / tweetnacl-util (sealed signaling helpers) ─────────────────
// We do not test NaCl encryption here — just that the emit payloads are correct
// for the non-encrypted control messages (decline, hangup, invite).
jest.mock('tweetnacl', () => ({
  randomBytes: jest.fn().mockReturnValue(new Uint8Array(24)),
  box: Object.assign(
    jest.fn().mockReturnValue(new Uint8Array(32)),
    {
      open: jest.fn().mockReturnValue(null),
      publicKeyLength: 32,
      secretKeyLength: 32,
      nonceLength: 24,
    },
  ),
}));

jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn().mockReturnValue('base64string=='),
  decodeBase64: jest.fn().mockReturnValue(new Uint8Array(32)),
}));

// ── webrtc/ice ─────────────────────────────────────────────────────────────
jest.mock('../../webrtc/ice', () => ({
  fetchTurnConfig: jest.fn().mockResolvedValue({}),
}));

// ── webrtc/peer ────────────────────────────────────────────────────────────
jest.mock('../../webrtc/peer', () => ({
  createPeer: jest.fn().mockResolvedValue({
    pc: {},
    cleanup: jest.fn(),
  }),
  createOffer: jest.fn().mockResolvedValue('sdp-offer'),
  setRemoteOffer: jest.fn().mockResolvedValue(undefined),
  createAnswer: jest.fn().mockResolvedValue('sdp-answer'),
  setRemoteAnswer: jest.fn().mockResolvedValue(undefined),
  addRemoteIce: jest.fn().mockResolvedValue(undefined),
}));

// ── store/contacts (used by sealSignal / peerPublicKey) ────────────────────
jest.mock('../../store/contacts', () => ({
  useContacts: {
    getState: () => ({
      get: jest.fn().mockReturnValue(undefined),
    }),
  },
}));

// ── store/groups (used by group_call:invite handler) ───────────────────────
jest.mock('../../store/groups', () => ({
  useGroups: {
    getState: () => ({
      groups: [],
    }),
  },
}));

// ── store/identity (used by ownKeys) ──────────────────────────────────────
jest.mock('../../store/identity', () => ({
  useIdentity: {
    getState: () => ({
      identity: {
        aegisId: 'self-aegis-id',
        secretKey: new Uint8Array(32),
      },
    }),
  },
}));

// ── socket/client ─────────────────────────────────────────────────────────
// socket emit/on are jest.fn() so we can assert exact payloads.
const mockEmit = jest.fn();
const mockOn = jest.fn();
const mockSocket = { emit: mockEmit, on: mockOn };

// Must be named with "mock" prefix so Babel allows it inside jest.mock() factory
let mockSocketReturnValue: typeof mockSocket | null = mockSocket;

const mockIsConnected = jest.fn().mockReturnValue(true);

jest.mock('../client', () => ({
  getSocket: () => mockSocketReturnValue,
  isConnected: () => mockIsConnected(),
}));

// ── react-native (Alert) ───────────────────────────────────────────────────
jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
}));

// ── Import the store (real Zustand) and the module under test ──────────────
import { useGroupCall } from '../../store/groupCall';
import {
  declineGroupCall,
  hangupGroupCall,
  startGroupCall,
  attachGroupCallHandlers,
} from '../groupCalls';

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('groupCalls signaling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSocketReturnValue = mockSocket;
    mockIsConnected.mockReturnValue(true);
    useGroupCall.getState().reset();
  });

  afterEach(() => {
    useGroupCall.getState().reset();
  });

  // ── 1. declineGroupCall emits correct payload ──────────────────────────────

  it('declineGroupCall emits group_call:decline with callId and to: initiatorAegisId', () => {
    declineGroupCall('call-abc', 'initiator-aegis-001');

    expect(mockEmit).toHaveBeenCalledWith('group_call:decline', {
      callId: 'call-abc',
      to: 'initiator-aegis-001',
    });
  });

  it('declineGroupCall resets the groupCall store', () => {
    useGroupCall.getState().startIncoming('call-abc', 'g-1', 'Alpha', 'initiator-aegis-001');
    expect(useGroupCall.getState().status).toBe('ringing-in');

    declineGroupCall('call-abc', 'initiator-aegis-001');

    expect(useGroupCall.getState().status).toBe('idle');
    expect(useGroupCall.getState().callId).toBeNull();
  });

  // ── 2. hangupGroupCall emits group_call:hangup and resets store ────────────

  it('hangupGroupCall emits group_call:hangup and calls store reset', () => {
    // Put the store into an in-call state with a known callId and participants
    useGroupCall.getState().startOutgoing('call-xyz', 'g-2', 'BetaGroup', ['peer-A', 'peer-B']);
    useGroupCall.getState().setStatus('in-call');

    hangupGroupCall();

    expect(mockEmit).toHaveBeenCalledWith(
      'group_call:hangup',
      expect.objectContaining({ callId: 'call-xyz' }),
    );

    // After the synchronous hangup the status transitions to 'ended'
    // (reset is deferred by setTimeout(800ms) in production code)
    expect(useGroupCall.getState().status).toBe('ended');
  });

  it('hangupGroupCall does nothing (no emit) when callId is null', () => {
    // Store is already idle with callId = null from the beforeEach reset
    hangupGroupCall();
    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ── 3. startGroupCall with no socket returns early without throwing ────────

  it('startGroupCall returns early and does not throw when getSocket() returns null', async () => {
    mockSocketReturnValue = null;

    const identity = {
      aegisId: 'self-aegis-id',
      publicKeyB64: 'pubkey',
      secretKey: new Uint8Array(32),
      // Minimal identity shape required by the function signature
    } as Parameters<typeof startGroupCall>[0];

    await expect(
      startGroupCall(identity, { id: 'g-3', name: 'GammaCrew', members: [] }, ['peer-X']),
    ).resolves.toBeUndefined();

    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ── 4. attachGroupCallHandlers registers group_call:invite listener ────────

  it('attachGroupCallHandlers registers a group_call:invite listener on the socket', () => {
    attachGroupCallHandlers();

    const registeredEvents = (mockOn.mock.calls as [string, unknown][]).map(([ev]) => ev);
    expect(registeredEvents).toContain('group_call:invite');
  });

  // ── 5. attachGroupCallHandlers registers group_call:accept listener ────────

  it('attachGroupCallHandlers registers a group_call:accept listener on the socket', () => {
    attachGroupCallHandlers();

    const registeredEvents = (mockOn.mock.calls as [string, unknown][]).map(([ev]) => ev);
    expect(registeredEvents).toContain('group_call:accept');
  });

  // ── 6. group_call:invite handler calls startIncoming with correct args ─────

  it('group_call:invite handler calls useGroupCall.getState().startIncoming with correct args', () => {
    attachGroupCallHandlers();

    // Locate the invite handler registered by socket.on(...)
    const inviteCall = (mockOn.mock.calls as [string, (...args: unknown[]) => void][]).find(
      ([ev]) => ev === 'group_call:invite',
    );
    expect(inviteCall).toBeDefined();
    const inviteHandler = inviteCall![1];

    const inviteMsg = {
      from: 'initiator-aegis-001',
      callId: 'call-invite-001',
      groupId: 'g-invite-001',
      groupName: 'DeltaForce',
      media: 'audio' as const,
    };

    inviteHandler(inviteMsg);

    const state = useGroupCall.getState();
    expect(state.status).toBe('ringing-in');
    expect(state.callId).toBe('call-invite-001');
    expect(state.groupId).toBe('g-invite-001');
    expect(state.groupName).toBe('DeltaForce');
    expect(state.initiator).toBe('initiator-aegis-001');
  });

  it('group_call:invite handler auto-declines when already in a call', () => {
    // Put store in-call before registering handlers
    useGroupCall.getState().startOutgoing('existing-call', 'g-x', 'ExistingGroup', ['peer-Z']);
    useGroupCall.getState().setStatus('in-call');

    attachGroupCallHandlers();

    const inviteCall = (mockOn.mock.calls as [string, (...args: unknown[]) => void][]).find(
      ([ev]) => ev === 'group_call:invite',
    );
    const inviteHandler = inviteCall![1];

    inviteHandler({
      from: 'new-initiator',
      callId: 'new-call-id',
      groupId: 'g-new',
      groupName: 'NewGroup',
      media: 'audio' as const,
    });

    // Should emit a decline and NOT change the store status
    expect(mockEmit).toHaveBeenCalledWith(
      'group_call:decline',
      expect.objectContaining({ callId: 'new-call-id', to: 'new-initiator' }),
    );
    expect(useGroupCall.getState().callId).toBe('existing-call');
  });
});
