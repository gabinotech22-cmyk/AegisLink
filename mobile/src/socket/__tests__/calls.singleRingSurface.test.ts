/**
 * calls.ts — ONE incoming-call surface, and the audio that depends on it.
 *
 * Field bug (2026-08-07, iOS): an incoming call showed TWO competing UIs with
 * the app open — our full-screen IncomingCallScreen plus the system call banner
 * — and answering from our screen produced a connected call with NO audio.
 *
 * Both symptoms are the same root cause: processIncomingInvite reported EVERY
 * incoming call to CallKit, foreground included. CallKit owns the AVAudioSession
 * for any call it displays and only activates it when the CXAnswerCallAction is
 * fulfilled (RNCallKeep.m performAnswerCallAction → configureAudioSession).
 * Answering from our own UI never fulfilled it, so the session stayed in the
 * ringing state and nobody could hear anything. `setCurrentCallActive`, which we
 * do call on connect, maps to reportOutgoingCall(connectedAt:) — outgoing only,
 * which is why outgoing calls were always audible and only incoming ones were mute.
 *
 * The rules pinned here:
 *   1. Foreground → our screen rings, and NOTHING else is surfaced.
 *   2. Not foreground → exactly ONE OS surface: CallKit where it exists,
 *      our heads-up banner where it doesn't (Android / Expo Go).
 *   3. Accepting a call CallKit rang hands the answer to CallKit, so the system
 *      activates the audio session.
 *   4. Leaving the app mid-ring hands the ring over to the OS instead of
 *      letting it die inside a screen nobody can see.
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

jest.mock('expo-crypto', () => ({ randomUUID: jest.fn().mockReturnValue('test-call-uuid') }));
jest.mock('expo-av', () => ({ Audio: { setAudioModeAsync: jest.fn().mockResolvedValue(undefined) } }));

jest.mock('tweetnacl', () => ({
  randomBytes: jest.fn().mockReturnValue(new Uint8Array(32)),
  box: Object.assign(jest.fn().mockReturnValue(new Uint8Array(32)), {
    open: jest.fn().mockReturnValue(null),
    publicKeyLength: 32,
    secretKeyLength: 32,
    nonceLength: 24,
  }),
  secretbox: Object.assign(jest.fn().mockReturnValue(new Uint8Array(32)), {
    keyLength: 32,
    nonceLength: 24,
  }),
  sign: { publicKeyLength: 32 },
}));
jest.mock('tweetnacl-util', () => ({
  encodeBase64: jest.fn().mockReturnValue('base64string=='),
  decodeBase64: jest.fn().mockReturnValue(new Uint8Array(32)),
}));

jest.mock('../../crypto/callSession', () => ({
  CALL_SESSION_VERSION: 1,
  sealCallInvite: jest.fn().mockReturnValue({
    wire: { ciphertext: 'ct', nonce: 'n', epk: 'epk' },
    callKey: new Uint8Array(32),
  }),
  sealWithCallKey: jest.fn().mockReturnValue({ ciphertext: 'ct', nonce: 'n' }),
  openCallInvite: jest.fn(),
  openWithCallKey: jest.fn().mockReturnValue(null),
}));

jest.mock('../../webrtc/ice', () => ({ fetchTurnConfig: jest.fn().mockResolvedValue({}) }));
jest.mock('../../webrtc/inCall', () => ({ startInCallAudio: jest.fn(), stopInCallAudio: jest.fn() }));

jest.mock('../../webrtc/peer', () => ({
  createPeer: jest.fn(async () => ({
    pc: {},
    localStream: { getTracks: () => [], getAudioTracks: () => [] },
    remoteStream: null,
    cleanup: jest.fn(),
  })),
  createOffer: jest.fn().mockResolvedValue('sdp-offer'),
  setRemoteOffer: jest.fn().mockResolvedValue(undefined),
  createAnswer: jest.fn().mockResolvedValue('sdp-answer'),
  setRemoteAnswer: jest.fn().mockResolvedValue(undefined),
  addRemoteIce: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../store/contacts', () => ({
  useContacts: {
    getState: () => ({ get: jest.fn().mockReturnValue({ publicKeyB64: 'pk', signingPublicKeyB64: 'spk', name: 'Peer One' }) }),
  },
}));
jest.mock('../../store/identity', () => ({
  useIdentity: { getState: () => ({ identity: { aegisId: 'self-aegis-id', secretKey: new Uint8Array(32), signingSecretKey: new Uint8Array(64) } }) },
}));
jest.mock('../../store/messages', () => ({ useMessages: { getState: () => ({ append: jest.fn() }) } }));
jest.mock('../../store/preferences', () => ({
  usePreferences: { getState: () => ({ hideCallIp: true }) },
}));
jest.mock('../../db/local', () => ({ saveCall: jest.fn().mockResolvedValue(undefined) }));

// ── the two surfaces under test ──────────────────────────────────────────────
const mockShowIncomingCallNotification = jest.fn().mockResolvedValue(undefined);
jest.mock('../../notifications/push', () => ({
  showIncomingCallNotification: (...a: unknown[]) => mockShowIncomingCallNotification(...a),
  dismissIncomingCallNotification: jest.fn().mockResolvedValue(undefined),
  showMissedCallNotification: jest.fn().mockResolvedValue(undefined),
}));

const mockDisplayIncomingCall = jest.fn();
const mockAnswerNativeCall = jest.fn();
const mockEndNativeCall = jest.fn();
// Flipped per-test to model iOS (CallKit present) vs Android / Expo Go. Held in
// an object because a jest.mock factory may only close over `mock*` bindings.
const mockCallKit = { available: false };
jest.mock('../../calls/callkeep', () => ({
  displayIncomingCall: (...a: unknown[]) => mockDisplayIncomingCall(...a),
  endNativeCall: (...a: unknown[]) => mockEndNativeCall(...a),
  reportCallConnected: jest.fn(),
  setNativeMuted: jest.fn(),
  answerNativeCall: (...a: unknown[]) => mockAnswerNativeCall(...a),
  isCallKitAvailable: () => mockCallKit.available,
}));

const mockEmit = jest.fn();
const mockOn = jest.fn();
const mockSocket = { emit: mockEmit, on: mockOn, off: jest.fn() };
jest.mock('../client', () => ({ getSocket: () => mockSocket, isConnected: () => true }));

// AppState is mutated per-test; its addEventListener records the handoff
// listener. The factory MUST build the object inline: jest hoists jest.mock()
// above the file's `const`s, and react-native is required during the module
// imports below — a factory returning an outer binding would hand back
// `undefined` and jest would cache that.
jest.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: jest.fn(() => ({ remove: jest.fn() })),
  },
  Platform: { OS: 'ios', select: (obj: Record<string, unknown>) => obj.ios ?? obj.default },
  NativeModules: {},
}));

jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));

import { AppState } from 'react-native';
import { useCall } from '../../store/call';
import { openCallInvite } from '../../crypto/callSession';
import { attachCallHandlers, acceptCall } from '../calls';

const mockOpenCallInvite = openCallInvite as jest.Mock;
const mockAppState = AppState as unknown as { currentState: string; addEventListener: jest.Mock };

function capturedInviteHandler(): (msg: unknown) => Promise<void> {
  const call = (mockOn.mock.calls as [string, unknown][]).find(([ev]) => ev === 'call:invite:v2');
  return call![1] as (msg: unknown) => Promise<void>;
}

/** The AppState 'change' listener the ring handoff armed, if it armed one. */
function capturedHandoffListener(): (state: string) => void {
  const call = (mockAppState.addEventListener.mock.calls as [string, (s: string) => void][])
    .find(([ev]) => ev === 'change');
  return call![1];
}

async function deliverInvite(callId = 'call-1'): Promise<void> {
  attachCallHandlers();
  await capturedInviteHandler()({ callId, media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAppState.currentState = 'active';
  mockCallKit.available = false;
  useCall.getState().reset();
  mockOpenCallInvite.mockReturnValue({ from: 'peer-A', offer: 'sdp-offer', callKey: new Uint8Array(32) });
});

describe('incoming call — exactly one ring surface', () => {
  it('foreground: our screen rings alone — no CallKit, no OS banner', async () => {
    mockAppState.currentState = 'active';
    mockCallKit.available = true; // iOS

    await deliverInvite();

    expect(useCall.getState().status).toBe('incoming-ringing');
    // THE regression: CallKit must not be told about a call our screen is ringing.
    expect(mockDisplayIncomingCall).not.toHaveBeenCalled();
    expect(mockShowIncomingCallNotification).not.toHaveBeenCalled();
  });

  it('background on iOS: CallKit rings, and the banner does NOT double up', async () => {
    mockAppState.currentState = 'background';
    mockCallKit.available = true;

    await deliverInvite('call-ios-bg');

    expect(mockDisplayIncomingCall).toHaveBeenCalledTimes(1);
    expect(mockDisplayIncomingCall.mock.calls[0][0]).toBe('call-ios-bg');
    expect(mockShowIncomingCallNotification).not.toHaveBeenCalled();
  });

  it('background without CallKit (Android / Expo Go): the banner rings alone', async () => {
    mockAppState.currentState = 'background';
    mockCallKit.available = false;

    await deliverInvite('call-android-bg');

    expect(mockShowIncomingCallNotification).toHaveBeenCalledTimes(1);
    expect(mockDisplayIncomingCall).not.toHaveBeenCalled();
  });
});

describe('answering hands the audio session back to CallKit', () => {
  it('accepting a CallKit-rung call fulfils the answer action (else: no audio)', async () => {
    mockAppState.currentState = 'background';
    mockCallKit.available = true;
    await deliverInvite('call-audio');
    expect(useCall.getState().status).toBe('incoming-ringing');

    await acceptCall();

    // Without this the call connects but the AVAudioSession never activates.
    expect(mockAnswerNativeCall).toHaveBeenCalledWith('call-audio');
  });

  it('is idempotent: the native answerCall event re-entering acceptCall is a no-op', async () => {
    mockAppState.currentState = 'background';
    mockCallKit.available = true;
    await deliverInvite('call-reentry');

    await acceptCall();
    const callsAfterFirst = mockAnswerNativeCall.mock.calls.length;
    // CallKit's 'answerCall' listener drives acceptCall() again — the
    // status !== 'incoming-ringing' guard must stop it dead.
    await acceptCall();

    expect(mockAnswerNativeCall.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('ring handoff when the user leaves the app mid-ring', () => {
  it('moves the ring to the OS surface instead of letting it die on screen', async () => {
    mockAppState.currentState = 'active';
    mockCallKit.available = true;

    await deliverInvite('call-handoff');
    expect(mockDisplayIncomingCall).not.toHaveBeenCalled();
    expect(mockAppState.addEventListener).toHaveBeenCalledTimes(1);

    // User swipes away while it is still ringing.
    mockAppState.currentState = 'background';
    capturedHandoffListener()('background');

    expect(mockDisplayIncomingCall).toHaveBeenCalledTimes(1);
    expect(mockDisplayIncomingCall.mock.calls[0][0]).toBe('call-handoff');
  });

  it('does not surface anything once the call is no longer ringing', async () => {
    mockAppState.currentState = 'active';
    mockCallKit.available = true;
    await deliverInvite('call-answered');

    await acceptCall(); // no longer 'incoming-ringing'
    mockDisplayIncomingCall.mockClear();

    capturedHandoffListener()('background');

    expect(mockDisplayIncomingCall).not.toHaveBeenCalled();
  });
});
