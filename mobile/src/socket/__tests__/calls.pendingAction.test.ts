/**
 * calls.ts — pendingAction (Accept/Decline pressed on the OS call notification
 * before the offer arrived) regression tests.
 *
 * Field bug: pressing "Contestar"/"Rechazar" on the incoming-call notification
 * never actually answered or declined the call — the notification response
 * listener (notifications/push.ts) had no handler for the ACCEPT_CALL /
 * DECLINE_CALL action identifiers, so it fell through to the default branch
 * (just opens the chat). This was worst for a killed app: only the generic
 * zero-metadata wake push had arrived (no SDP offer yet — sealed-sender), so
 * even a correct handler couldn't answer immediately.
 *
 * The fix threads a `pendingAction` flag through the call store
 * (store/call.ts): the notification handler marks intent and reconnects; once
 * the relay redelivers the queued call:invite (server/src/relay/handler.ts
 * takePendingCallInvite), processIncomingInvite (this file) consumes the flag
 * and acts immediately instead of just ringing.
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
jest.mock('../../store/contacts', () => ({
  useContacts: {
    getState: () => ({ get: jest.fn().mockReturnValue({ publicKeyB64: 'pk', signingPublicKeyB64: 'spk', name: 'Peer One' }) }),
  },
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
import { attachCallHandlers, endCall } from '../calls';

const mockOpenCallInvite = openCallInvite as jest.Mock;

/** The handler registered for `call:invite:v2` via attachCallHandlers(). */
function capturedInviteHandler(): (msg: unknown) => Promise<void> {
  const call = (mockOn.mock.calls as [string, unknown][]).find(([ev]) => ev === 'call:invite:v2');
  return call![1] as (msg: unknown) => Promise<void>;
}

/** The handler registered for `call:hangup:v2` (remote hangup). */
function capturedHangupHandler(): (msg: unknown) => void {
  const call = (mockOn.mock.calls as [string, unknown][]).find(([ev]) => ev === 'call:hangup:v2');
  return call![1] as (msg: unknown) => void;
}

/** Drain a chain of already-resolved promises (acceptCall's fire-and-forget tail). */
async function flushMicrotasks(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

describe('calls.ts — pendingAction consumed on invite (re)delivery', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSocketReturnValue = mockSocket;
    mockPeerState.handlers = null;
    useCall.getState().reset();
    mockOpenCallInvite.mockReturnValue({ from: 'peer-A', offer: 'sdp-offer', callKey: new Uint8Array(32) });
  });

  it('auto-accepts as soon as the invite lands, if the user already pressed Accept on the notification', async () => {
    useCall.getState().setPendingAction('accept');
    attachCallHandlers();
    const onInvite = capturedInviteHandler();

    await onInvite({ callId: 'call-Z', media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' });

    // acceptCall() is fired via `void acceptCall()` (not awaited by
    // processIncomingInvite), but its synchronous prefix — setStatus —
    // already ran by the time onInvite resolves.
    expect(useCall.getState().status).toBe('connecting');
    // The one-shot flag must not survive being consumed.
    expect(useCall.getState().pendingAction).toBeNull();

    // Let acceptCall()'s remaining awaited chain (turnConfig, createPeer,
    // setRemoteOffer, flushPendingIce, createAnswer, emitSealedSignal) drain
    // before asserting its tail effect (pendingOffer cleared once answered).
    await flushMicrotasks();
    expect(useCall.getState().pendingOffer).toBeNull();
  });

  it('auto-declines as soon as the invite lands, if the user already pressed Decline on the notification', async () => {
    useCall.getState().setPendingAction('decline');
    attachCallHandlers();
    const onInvite = capturedInviteHandler();

    await onInvite({ callId: 'call-Y', media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' });

    expect(useCall.getState().status).toBe('ended');
    expect(mockEmit).toHaveBeenCalledWith(
      'call:hangup:v2',
      expect.objectContaining({ callId: 'call-Y', reason: 'declined' }),
    );
    expect(useCall.getState().pendingAction).toBeNull();
  });

  it('rings normally (no auto-action) when no pendingAction was set', async () => {
    attachCallHandlers();
    const onInvite = capturedInviteHandler();

    await onInvite({ callId: 'call-X', media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' });

    expect(useCall.getState().status).toBe('incoming-ringing');
    expect(useCall.getState().pendingOffer).toBe('sdp-offer');
  });

  it('ignores a STALE pendingAction (>60s old) — a new call must ring, never auto-answer', async () => {
    // The press's invite was never redelivered (relay TTL expired); a fresh
    // call arrives much later. Without the freshness gate this auto-answered.
    useCall.getState().setPendingAction('accept');
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);

    attachCallHandlers();
    const onInvite = capturedInviteHandler();
    await onInvite({ callId: 'call-W', media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' });

    expect(useCall.getState().status).toBe('incoming-ringing');
    // The stale flag was still consumed (cleared) by startIncoming's reset.
    expect(useCall.getState().pendingAction).toBeNull();
    (Date.now as jest.Mock).mockRestore();
  });

  afterEach(() => {
    useCall.getState().reset();
  });
});

describe('calls.ts — incoming-call notification cleanup on end (Llamada perdida)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSocketReturnValue = mockSocket;
    mockPeerState.handlers = null;
    useCall.getState().reset();
    mockOpenCallInvite.mockReturnValue({ from: 'peer-A', offer: 'sdp-offer', callKey: new Uint8Array(32) });
  });
  afterEach(() => useCall.getState().reset());

  it('caller hangs up while ringing → dismisses the banner AND posts a missed-call record', async () => {
    attachCallHandlers();
    const onInvite = capturedInviteHandler();
    const onHangup = capturedHangupHandler();

    // Incoming call rings (no pendingAction → no auto-answer).
    await onInvite({ callId: 'call-M', media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' });
    expect(useCall.getState().status).toBe('incoming-ringing');

    // Caller hangs up before we answer → remote hangup → finalizeCall('missed').
    onHangup({ callId: 'call-M', reason: 'remote_hangup' });

    expect(mockDismissIncomingCall).toHaveBeenCalledWith('call-M');
    expect(mockShowMissedCall).toHaveBeenCalledWith('peer-A', expect.any(String), 'call-M');
  });

  it('user declines → dismisses the banner but posts NO missed-call record', async () => {
    attachCallHandlers();
    const onInvite = capturedInviteHandler();
    await onInvite({ callId: 'call-D', media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' });

    endCall('declined');

    expect(mockDismissIncomingCall).toHaveBeenCalledWith('call-D');
    expect(mockShowMissedCall).not.toHaveBeenCalled();
  });
});
