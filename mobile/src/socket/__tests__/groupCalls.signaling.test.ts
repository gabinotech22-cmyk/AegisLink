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

// ── store/groups (used by the group_call:channel membership gate) ──────────
// Mutable so a test can inject a trusted group; "mock" prefix lets Babel
// reference it inside the jest.mock() factory below.
let mockGroups: Array<{ id: string; members: string[] }> = [];
jest.mock('../../store/groups', () => ({
  useGroups: {
    getState: () => ({
      groups: mockGroups,
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
const mockOff = jest.fn();
const mockSocket = { emit: mockEmit, on: mockOn, off: mockOff };

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
  Platform: { OS: 'android', select: (o: Record<string, unknown>) => o.android ?? o.default },
  NativeModules: {},
  StyleSheet: { create: (s: Record<string, unknown>) => s },
}));

// ── AlertHost — cut the theme/StyleSheet chain (themedAlert is fire-and-forget here)
jest.mock('../../components/AlertHost', () => ({
  themedAlert: jest.fn(),
}));

// ── Import the store (real Zustand) and the module under test ──────────────
import { useGroupCall } from '../../store/groupCall';
import { useActiveCalls } from '../../store/activeCalls';
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
    mockGroups = [];
    // Clear any banner state left from a prior test.
    for (const gid of Object.keys(useActiveCalls.getState().calls)) {
      useActiveCalls.getState().remove(gid);
    }
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

  // ── 4. attachGroupCallHandlers registers the Discord-style channel banner ──
  // Group calls no longer ring each member with `group_call:invite`; awareness
  // comes from the passive `group_call:channel` heartbeat (see groupCalls.ts).

  it('attachGroupCallHandlers registers a group_call:channel listener on the socket', () => {
    attachGroupCallHandlers();

    const registeredEvents = (mockOn.mock.calls as [string, unknown][]).map(([ev]) => ev);
    expect(registeredEvents).toContain('group_call:channel');
  });

  // ── 5. attachGroupCallHandlers registers group_call:accept listener ────────

  it('attachGroupCallHandlers registers a group_call:accept listener on the socket', () => {
    attachGroupCallHandlers();

    const registeredEvents = (mockOn.mock.calls as [string, unknown][]).map(([ev]) => ev);
    expect(registeredEvents).toContain('group_call:accept');
  });

  // Helper: locate the registered group_call:channel handler.
  function channelHandler(): (msg: unknown) => void {
    const call = (mockOn.mock.calls as [string, (...args: unknown[]) => void][]).find(
      ([ev]) => ev === 'group_call:channel',
    );
    expect(call).toBeDefined();
    return call![1];
  }

  // ── 6. channel heartbeat from a trusted member surfaces a banner ──────────

  it('group_call:channel handler upserts a banner into useActiveCalls for a trusted group', () => {
    // The membership gate requires the initiator to be a known group member.
    mockGroups = [{ id: 'g-channel-001', members: ['initiator-aegis-001', 'self-aegis-id'] }];

    attachGroupCallHandlers();
    channelHandler()({
      from: 'initiator-aegis-001',
      callId: 'call-channel-001',
      groupId: 'g-channel-001',
      groupName: 'DeltaForce',
      participants: ['initiator-aegis-001'],
      media: 'audio' as const,
    });

    const banner = useActiveCalls.getState().calls['g-channel-001'];
    expect(banner).toBeDefined();
    expect(banner.callId).toBe('call-channel-001');
    expect(banner.initiator).toBe('initiator-aegis-001');
    expect(banner.participants).toEqual(['initiator-aegis-001']);
  });

  it('group_call:channel handler drops heartbeats whose initiator is not a group member', () => {
    // Group exists but the sender is NOT in its member list → gate rejects it.
    mockGroups = [{ id: 'g-channel-002', members: ['someone-else'] }];

    attachGroupCallHandlers();
    channelHandler()({
      from: 'stranger-aegis',
      callId: 'call-channel-002',
      groupId: 'g-channel-002',
      groupName: 'NewGroup',
      participants: ['stranger-aegis'],
      media: 'audio' as const,
    });

    expect(useActiveCalls.getState().calls['g-channel-002']).toBeUndefined();
  });

  // Helper: locate the registered group_call:hangup handler.
  function hangupHandler(): (msg: unknown) => void {
    const call = (mockOn.mock.calls as [string, (...args: unknown[]) => void][]).find(
      ([ev]) => ev === 'group_call:hangup',
    );
    expect(call).toBeDefined();
    return call![1];
  }

  // ── 7. Leaving broadcasts a channel update so banners don't linger ─────────

  it('hangupGroupCall broadcasts a group_call:channel with the remaining roster (self removed)', () => {
    mockGroups = [{ id: 'g-leave', members: ['self-aegis-id', 'peer-A'] }];
    useGroupCall.getState().startOutgoing('call-leave', 'g-leave', 'Leavers', ['peer-A']);
    useGroupCall.getState().setStatus('in-call');

    hangupGroupCall();

    expect(mockEmit).toHaveBeenCalledWith(
      'group_call:channel',
      expect.objectContaining({ callId: 'call-leave', participants: ['peer-A'] }),
    );
  });

  it('hangupGroupCall by the LAST participant broadcasts an empty roster (channel closed)', () => {
    mockGroups = [{ id: 'g-last', members: ['self-aegis-id', 'peer-A'] }];
    // In-call but alone (no other mesh participants) → we are the last to leave.
    useGroupCall.getState().startOutgoing('call-last', 'g-last', 'Lonely', []);
    useGroupCall.getState().setStatus('in-call');

    hangupGroupCall();

    expect(mockEmit).toHaveBeenCalledWith(
      'group_call:channel',
      expect.objectContaining({ callId: 'call-last', participants: [] }),
    );
  });

  // ── 8. An explicitly-empty roster clears the banner immediately ────────────

  it('group_call:channel with an empty participants array removes the active banner', () => {
    mockGroups = [{ id: 'g-close', members: ['initiator-aegis-001', 'self-aegis-id'] }];
    attachGroupCallHandlers();
    const handler = channelHandler();

    // A normal heartbeat opens the banner…
    handler({
      from: 'initiator-aegis-001',
      callId: 'call-close',
      groupId: 'g-close',
      groupName: 'Closers',
      participants: ['initiator-aegis-001'],
      media: 'audio' as const,
    });
    expect(useActiveCalls.getState().calls['g-close']).toBeDefined();

    // …and a leave-broadcast with an empty roster closes it immediately.
    handler({
      from: 'initiator-aegis-001',
      callId: 'call-close',
      groupId: 'g-close',
      groupName: 'Closers',
      participants: [],
      media: 'audio' as const,
    });
    expect(useActiveCalls.getState().calls['g-close']).toBeUndefined();
  });

  // ── 9. Receiving a hangup removes the leaver from our roster (count fix) ────

  it('group_call:hangup handler removes the leaver from the participant roster', () => {
    useGroupCall.getState().startOutgoing('call-roster', 'g-roster', 'Roster', ['peer-A', 'peer-B']);
    useGroupCall.getState().setStatus('in-call');
    expect(useGroupCall.getState().participants.map((p) => p.aegisId)).toEqual(['peer-A', 'peer-B']);

    attachGroupCallHandlers();
    hangupHandler()({ from: 'peer-A', callId: 'call-roster' });

    expect(useGroupCall.getState().participants.map((p) => p.aegisId)).toEqual(['peer-B']);
  });

  // ── 10. Host-ends-for-all ──────────────────────────────────────────────────

  it('hangupGroupCall by the HOST broadcasts an empty roster (host-ends-for-all)', () => {
    mockGroups = [{ id: 'g-host', members: ['self-aegis-id', 'peer-A', 'peer-B'] }];
    // We are the host: our own aegisId is the initiator, peers are still in-call.
    useGroupCall.getState().startOutgoing('call-host', 'g-host', 'Hosts', ['peer-A', 'peer-B'], 'self-aegis-id');
    useGroupCall.getState().setStatus('in-call');

    hangupGroupCall();

    // Even though peer-A/peer-B remain, the host broadcasts [] to end for everyone
    // (a non-host would broadcast the remaining roster — see test 7).
    expect(mockEmit).toHaveBeenCalledWith(
      'group_call:channel',
      expect.objectContaining({ callId: 'call-host', participants: [] }),
    );
  });

  it('group_call:hangup from the initiator ends the call for an active participant', () => {
    // We joined a channel hosted by 'host-aegis' and are in-call with them + peer-B.
    useGroupCall.getState().startOutgoing('call-join', 'g-join', 'Joiners', ['host-aegis', 'peer-B'], 'host-aegis');
    useGroupCall.getState().setStatus('in-call');

    attachGroupCallHandlers();
    hangupHandler()({ from: 'host-aegis', callId: 'call-join' });

    // The host hung up → the whole call ends for us, not just a roster trim.
    expect(useGroupCall.getState().status).toBe('ended');
  });

  it('group_call:hangup from a non-initiator drops only them; the call continues', () => {
    useGroupCall.getState().startOutgoing('call-stay', 'g-stay', 'Stayers', ['host-aegis', 'peer-B'], 'host-aegis');
    useGroupCall.getState().setStatus('in-call');

    attachGroupCallHandlers();
    hangupHandler()({ from: 'peer-B', callId: 'call-stay' });

    expect(useGroupCall.getState().status).toBe('in-call');
    expect(useGroupCall.getState().participants.map((p) => p.aegisId)).toEqual(['host-aegis']);
  });
});
