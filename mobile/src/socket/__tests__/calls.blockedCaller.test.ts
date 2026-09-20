/**
 * calls.ts — a blocked (or not yet accepted) contact cannot ring us.
 *
 * "Block" promised they cannot reach you; messages were dropped by three
 * guards but a sealed call:invite:v2 from a blocked contact still rang the
 * phone. The invite is now dropped SILENTLY (no "busy" hangup either — that
 * would confirm we are online). Same harness as calls.pendingAction.test.ts.
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

// ── crypto/callSession — the callee-side open is what this suite drives ───
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

// ── webrtc/ice ─────────────────────────────────────────────────────────────
jest.mock('../../webrtc/ice', () => ({ fetchTurnConfig: jest.fn().mockResolvedValue({}) }));

// ── webrtc/peer ─────────────────────────────────────────────────────────────
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

// ── store/contacts ───────────────────────────────────────────────────────────
const mockContact: Record<string, unknown> = { publicKeyB64: 'pk', signingPublicKeyB64: 'spk', name: 'Peer One' };
jest.mock('../../store/contacts', () => ({
  useContacts: { getState: () => ({ get: () => mockContact }) },
}));

// ── store/identity ───────────────────────────────────────────────────────────
jest.mock('../../store/identity', () => ({
  useIdentity: { getState: () => ({ identity: { aegisId: 'self-aegis-id', secretKey: new Uint8Array(32), signingSecretKey: new Uint8Array(64) } }) },
}));

// ── store/messages ───────────────────────────────────────────────────────────
const mockAppendFn = jest.fn();
jest.mock('../../store/messages', () => ({
  useMessages: { getState: () => ({ append: mockAppendFn }) },
}));

// ── db/local ─────────────────────────────────────────────────────────────────
jest.mock('../../db/local', () => ({ saveCall: jest.fn().mockResolvedValue(undefined) }));

// ── notifications/push — finalizeCall dismisses the incoming banner and, for a
//    missed call, posts a "Llamada perdida" record. Stub both so we can assert. ─
const mockDismissIncomingCall = jest.fn().mockResolvedValue(undefined);
const mockShowMissedCall = jest.fn().mockResolvedValue(undefined);
jest.mock('../../notifications/push', () => ({
  showIncomingCallNotification: jest.fn().mockResolvedValue(undefined),
  dismissIncomingCallNotification: (...a: unknown[]) => mockDismissIncomingCall(...a),
  showMissedCallNotification: (...a: unknown[]) => mockShowMissedCall(...a),
}));

// ── socket/client ────────────────────────────────────────────────────────────
const mockEmit = jest.fn();
const mockOn = jest.fn();
const mockOff = jest.fn();
const mockSocket = { emit: mockEmit, on: mockOn, off: mockOff };
let mockSocketReturnValue: typeof mockSocket | null = mockSocket;
jest.mock('../client', () => ({
  getSocket: () => mockSocketReturnValue,
  isConnected: () => true,
}));

// ── react-native (AppState + Platform) ────────────────────────────────────────
jest.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Platform: { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default },
  NativeModules: {},
}));

// ── components/AlertHost ─────────────────────────────────────────────────────
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));

import { useCall } from '../../store/call';
import { openCallInvite } from '../../crypto/callSession';
import { attachCallHandlers, callerMayRing } from '../calls';

const mockOpenCallInvite = openCallInvite as jest.Mock;

function capturedInviteHandler(): (msg: unknown) => Promise<void> {
  const call = (mockOn.mock.calls as [string, unknown][]).find(([ev]) => ev === 'call:invite:v2');
  return call![1] as (msg: unknown) => Promise<void>;
}

const INVITE = { callId: 'call-B', media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' };

describe('calls.ts — blocked / pending callers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSocketReturnValue = mockSocket;
    useCall.getState().reset();
    delete mockContact.blocked;
    delete mockContact.pending;
    mockOpenCallInvite.mockReturnValue({ from: 'peer-A', offer: 'sdp-offer', callKey: new Uint8Array(32) });
  });

  it('callerMayRing: accepted + unblocked only', () => {
    expect(callerMayRing('peer-A')).toBe(true);
    mockContact.blocked = true;
    expect(callerMayRing('peer-A')).toBe(false);
    delete mockContact.blocked;
    mockContact.pending = true;
    expect(callerMayRing('peer-A')).toBe(false);
  });

  it('a blocked contact never rings and gets no signal back', async () => {
    mockContact.blocked = true;
    attachCallHandlers();
    await capturedInviteHandler()(INVITE);
    expect(useCall.getState().status).toBe('idle');
    expect(mockEmit).not.toHaveBeenCalled();
    expect(mockAppendFn).not.toHaveBeenCalled();
  });

  it('a pending message request cannot ring either', async () => {
    mockContact.pending = true;
    attachCallHandlers();
    await capturedInviteHandler()(INVITE);
    expect(useCall.getState().status).toBe('idle');
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('an accepted contact still rings', async () => {
    attachCallHandlers();
    await capturedInviteHandler()(INVITE);
    expect(useCall.getState().status).toBe('incoming-ringing');
  });
});
