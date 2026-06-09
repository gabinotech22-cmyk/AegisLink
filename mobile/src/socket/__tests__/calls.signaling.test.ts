/**
 * calls.ts — 1:1 call finalization regression tests
 *
 * Guards the fix for two field-reported bugs (both same root cause):
 *
 *   1. A "Call failed — could not establish a media connection" alert popped up
 *      ~4× every time a *successfully connected* call was hung up.
 *   2. Connected, answered calls were logged in the chat thread as "missed" /
 *      "Sin respuesta" (often several duplicate rows).
 *
 * Root cause: the peer connection's `pc.close()` during teardown drives the
 * connection to 'closed' (and 'failed'), dispatched twice over
 * connectionstatechange + iceconnectionstatechange. The old handler treated
 * 'closed' as a failure and re-entered endCall, which — with `status` already
 * 'ended' — re-derived the call as 'missed' and re-showed the alert.
 *
 * The fix: 'closed' is never a failure; endCall/finalizeCall is idempotent
 * (keyed by callId); the remote-hangup handler persists history directly.
 *
 * These tests use the REAL useCall Zustand store and assert on the persisted
 * history (saveCall) + appended chat message (useMessages.append) + Alert.
 */

// ── react-native-webrtc ────────────────────────────────────────────────────
jest.mock('react-native-webrtc', () => ({
  RTCPeerConnection: jest.fn(),
  MediaStream: jest.fn(),
  RTCSessionDescription: jest.fn(),
  RTCIceCandidate: jest.fn(),
  mediaDevices: {
    getUserMedia: jest.fn().mockResolvedValue({ getTracks: () => [], getAudioTracks: () => [] }),
  },
}));

// ── expo-crypto ────────────────────────────────────────────────────────────
jest.mock('expo-crypto', () => ({ randomUUID: jest.fn().mockReturnValue('test-call-uuid') }));

// ── expo-av ────────────────────────────────────────────────────────────────
jest.mock('expo-av', () => ({ Audio: { setAudioModeAsync: jest.fn().mockResolvedValue(undefined) } }));

// ── tweetnacl / tweetnacl-util (sealed signaling helpers) ──────────────────
jest.mock('tweetnacl', () => ({
  randomBytes: jest.fn().mockReturnValue(new Uint8Array(24)),
  box: Object.assign(jest.fn().mockReturnValue(new Uint8Array(32)), {
    open: jest.fn().mockReturnValue(null),
    publicKeyLength: 32,
    secretKeyLength: 32,
    nonceLength: 24,
  }),
}));
jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn().mockReturnValue('base64string=='),
  decodeBase64: jest.fn().mockReturnValue(new Uint8Array(32)),
}));

// ── webrtc/ice ─────────────────────────────────────────────────────────────
jest.mock('../../webrtc/ice', () => ({ fetchTurnConfig: jest.fn().mockResolvedValue({}) }));

// ── webrtc/peer — capture the handlers passed to createPeer so a test can
//    drive connectionState transitions exactly as react-native-webrtc would. ──
const mockPeerState: { handlers: { onConnectionStateChange: (s: string) => void } | null } = { handlers: null };
const mockCleanup = jest.fn();
jest.mock('../../webrtc/peer', () => ({
  createPeer: jest.fn(async (_media: unknown, handlers: { onConnectionStateChange: (s: string) => void }) => {
    mockPeerState.handlers = handlers;
    return {
      pc: {},
      localStream: { getTracks: () => [], getAudioTracks: () => [] },
      remoteStream: null,
      cleanup: mockCleanup,
    };
  }),
  createOffer: jest.fn().mockResolvedValue('sdp-offer'),
  setRemoteOffer: jest.fn().mockResolvedValue(undefined),
  createAnswer: jest.fn().mockResolvedValue('sdp-answer'),
  setRemoteAnswer: jest.fn().mockResolvedValue(undefined),
  addRemoteIce: jest.fn().mockResolvedValue(undefined),
}));

// ── store/contacts — return a valid peer so sealSignal() succeeds in startCall ─
jest.mock('../../store/contacts', () => ({
  useContacts: {
    getState: () => ({ get: jest.fn().mockReturnValue({ publicKeyB64: 'pk', name: 'Peer One' }) }),
  },
}));

// ── store/identity (ownKeys + append guard) ────────────────────────────────
jest.mock('../../store/identity', () => ({
  useIdentity: { getState: () => ({ identity: { aegisId: 'self-aegis-id', secretKey: new Uint8Array(32) } }) },
}));

// ── store/messages — capture appended chat rows ([call:…] system messages) ──
// A STABLE append fn (not a fresh jest.fn() per getState()) so the production
// code and the test observe the same mock.
const mockAppendFn = jest.fn();
jest.mock('../../store/messages', () => ({
  useMessages: { getState: () => ({ append: mockAppendFn }) },
}));

// ── db/local — capture persisted call-history rows ─────────────────────────
jest.mock('../../db/local', () => ({ saveCall: jest.fn().mockResolvedValue(undefined) }));

// ── socket/client ──────────────────────────────────────────────────────────
const mockEmit = jest.fn();
const mockOn = jest.fn();
const mockSocket = { emit: mockEmit, on: mockOn };
let mockSocketReturnValue: typeof mockSocket | null = mockSocket;
const mockIsConnected = jest.fn().mockReturnValue(true);
jest.mock('../client', () => ({
  getSocket: () => mockSocketReturnValue,
  isConnected: () => mockIsConnected(),
}));

// ── react-native (Alert + AppState) ────────────────────────────────────────
jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  AppState: { currentState: 'active' },
}));

import { Alert } from 'react-native';
import { useCall } from '../../store/call';
import { useMessages } from '../../store/messages';
import { saveCall } from '../../db/local';
import { startCall, endCall, attachCallHandlers } from '../calls';

const mockAlert = Alert.alert as jest.Mock;
const mockSaveCall = saveCall as jest.Mock;
const mockAppend = useMessages.getState().append as jest.Mock;

/** Pull the appended chat-message bodies (the `[call:…]` tokens) in order. */
function appendedBodies(): string[] {
  return mockAppend.mock.calls.map((c) => (c[0] as { body: string }).body);
}

/** Put the store into a connected (answered) call without going through WebRTC. */
function enterConnectedCall(peerId: string, callId: string, direction: 'in' | 'out'): void {
  const s = useCall.getState();
  if (direction === 'out') s.startOutgoing(peerId, callId, 'audio');
  else s.startIncoming(peerId, callId, 'audio', 'sdp-offer');
  s.setActivePeer({ pc: {} as never, localStream: null, remoteStream: null, cleanup: mockCleanup });
  s.setStatus('in-call'); // stamps startedAt → wasAnswered === true
}

describe('calls.ts — 1:1 finalization', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockSocketReturnValue = mockSocket;
    mockIsConnected.mockReturnValue(true);
    mockPeerState.handlers = null;
    useCall.getState().reset();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    useCall.getState().reset();
  });

  // ── BUG 2: connected call hung up locally → logged ONCE as 'answered' ──────
  it('local hang-up of a connected call logs exactly one "answered" row', () => {
    enterConnectedCall('peer-A', 'call-A', 'out');

    endCall('hangup');

    expect(mockSaveCall).toHaveBeenCalledTimes(1);
    expect(mockSaveCall.mock.calls[0][0]).toMatchObject({ status: 'answered', direction: 'out' });
    const bodies = appendedBodies();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatch(/^\[call:answered:audio:\d+s\]$/);
  });

  // ── BUG 1+2: teardown 'failed'/'closed' re-entries are no-ops (idempotent) ─
  it('teardown re-entries after a connected hang-up neither re-log nor re-alert', () => {
    enterConnectedCall('peer-B', 'call-B', 'out');

    endCall('hangup'); // user hangs up → status becomes 'ended'
    // Simulate the peer connection's teardown events firing AFTER the hang-up,
    // duplicated across both listeners — exactly what produced the 4× alert.
    endCall('rtc_failure');
    endCall('rtc_failure');
    endCall('hangup');

    expect(mockSaveCall).toHaveBeenCalledTimes(1);
    expect(appendedBodies()).toHaveLength(1);
    expect(appendedBodies()[0]).toMatch(/^\[call:answered:/);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  // ── BUG 1: 'closed' connectionState never surfaces a "Call failed" alert ──
  it('a connected call whose peer closes shows no "Call failed" alert and logs "answered" once', async () => {
    await startCall('peer-C', 'audio');
    const h = mockPeerState.handlers!;
    expect(h).toBeTruthy();

    h.onConnectionStateChange('connected'); // → in-call
    expect(useCall.getState().status).toBe('in-call');

    endCall('hangup');                       // user ends the connected call
    h.onConnectionStateChange('closed');     // teardown side effect — must be a no-op
    h.onConnectionStateChange('failed');     // teardown side effect — must be a no-op

    expect(mockAlert).not.toHaveBeenCalled();
    expect(mockSaveCall).toHaveBeenCalledTimes(1);
    expect(mockSaveCall.mock.calls[0][0]).toMatchObject({ status: 'answered' });
    expect(appendedBodies()).toEqual([expect.stringMatching(/^\[call:answered:/)]);
  });

  // ── Regression guard: a GENUINE setup failure still alerts — exactly once ──
  it('a call that never connects still shows one "Call failed" alert and logs "missed" once', async () => {
    await startCall('peer-D', 'audio'); // status stays 'outgoing-ringing' (never connected)
    const h = mockPeerState.handlers!;

    h.onConnectionStateChange('failed'); // genuine ICE failure → alert + missed
    h.onConnectionStateChange('failed'); // duplicate listener → must be a no-op
    h.onConnectionStateChange('closed'); // teardown → must be a no-op

    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(mockSaveCall).toHaveBeenCalledTimes(1);
    expect(mockSaveCall.mock.calls[0][0]).toMatchObject({ status: 'missed' });
    expect(appendedBodies()).toHaveLength(1);
    expect(appendedBodies()[0]).toMatch(/^\[call:missed:/);
  });

  // ── BUG 2 (receiver side): remote hang-up of a connected call → 'answered' ─
  it('remote call:hangup of a connected call logs "answered" (not "missed"), no alert', () => {
    enterConnectedCall('peer-E', 'call-E', 'in');

    attachCallHandlers();
    const hangupEntry = (mockOn.mock.calls as [string, (m: unknown) => void][]).find(([ev]) => ev === 'call:hangup');
    expect(hangupEntry).toBeDefined();
    const hangupHandler = hangupEntry![1];

    hangupHandler({ callId: 'call-E', from: 'peer-E', reason: 'hangup' });
    // Duplicate teardown events that used to mis-log it as missed:
    hangupHandler({ callId: 'call-E', from: 'peer-E', reason: 'hangup' });
    endCall('rtc_failure');

    expect(mockSaveCall).toHaveBeenCalledTimes(1);
    expect(mockSaveCall.mock.calls[0][0]).toMatchObject({ status: 'answered', direction: 'in' });
    expect(appendedBodies()).toEqual([expect.stringMatching(/^\[call:answered:/)]);
    expect(mockAlert).not.toHaveBeenCalled();
  });

  // ── Decline path still logs as 'declined' on both reasons ─────────────────
  it('declining a ringing call logs it as "declined"', () => {
    useCall.getState().startIncoming('peer-F', 'call-F', 'audio', 'sdp-offer');

    endCall('declined');

    expect(mockSaveCall).toHaveBeenCalledTimes(1);
    expect(mockSaveCall.mock.calls[0][0]).toMatchObject({ status: 'declined' });
    expect(appendedBodies()[0]).toMatch(/^\[call:declined:/);
  });
});
