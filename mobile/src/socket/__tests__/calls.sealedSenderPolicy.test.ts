/**
 * calls.sealedSenderPolicy.test.ts — sealed-sender (v2) call policy, Fase A+C.
 *
 * Golden rules #4 (sealed-sender in ALL signaling, incl. calls) + #6 (production
 * fails closed). The client must NEVER hand the relay a `from`-bearing v1 call
 * event:
 *
 *   1. startCall() to a peer whose static box key is unavailable FAILS CLOSED —
 *      it surfaces an error and never emits a legacy `call:invite` (v1). The only
 *      invite an updated client ever emits is the sealed `call:invite:v2` (no
 *      `from` on the wire).
 *   2. (Fase C) The v1 call:invite handler is no longer wired — the relay no
 *      longer routes v1 events, and the client does not listen for them.
 *
 * See docs/FASE4-SEALED-CALL-SIGNALING-DESIGN.md and the parity suite in
 * desktop/src/renderer/socket/__tests__/calls.sealedSenderPolicy.test.ts.
 */

// ── config — exercise the DEFAULT sealed-sender (v2) policy deterministically. ─
jest.mock('../../config', () => ({
  ...jest.requireActual('../../config'),
  SEALED_TRANSPORT_VERSION: 'v2',
}));

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

// ── tweetnacl — secretbox.keyLength is read in startCall to size the v2 callKey. ─
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

// ── crypto/callSession — stub the sealed-sender primitives (real crypto is
//    covered by callSession's own unit tests). sealCallInvite returns a wire
//    with NO `from` field, exactly like production. ────────────────────────────
jest.mock('../../crypto/callSession', () => ({
  CALL_SESSION_VERSION: 1,
  sealCallInvite: jest.fn().mockReturnValue({
    wire: { ciphertext: 'ct', nonce: 'n', epk: 'epk' },
    callKey: new Uint8Array(32),
  }),
  sealWithCallKey: jest.fn().mockReturnValue({ ciphertext: 'ct', nonce: 'n' }),
  openCallInvite: jest.fn().mockReturnValue(null),
  openWithCallKey: jest.fn().mockReturnValue(null),
}));

jest.mock('../../webrtc/ice', () => ({ fetchTurnConfig: jest.fn().mockResolvedValue({}) }));

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

// ── store/contacts — the peer record is mutable per-test so we can simulate a
//    contact WITH or WITHOUT a resolvable static box key. ──────────────────────
type PeerRecord = { publicKeyB64?: string; signingPublicKeyB64?: string; name?: string } | undefined;
let mockPeerRecord: PeerRecord = { publicKeyB64: 'pk', signingPublicKeyB64: 'spk', name: 'Peer One' };
jest.mock('../../store/contacts', () => ({
  useContacts: { getState: () => ({ get: () => mockPeerRecord }) },
}));

// ── store/identity — full sealed-sender identity (box + signing). ─────────────
jest.mock('../../store/identity', () => ({
  useIdentity: {
    getState: () => ({
      identity: {
        aegisId: 'self-aegis-id',
        secretKey: new Uint8Array(32),
        signingSecretKey: new Uint8Array(64),
      },
    }),
  },
}));

const mockAppendFn = jest.fn();
jest.mock('../../store/messages', () => ({
  useMessages: { getState: () => ({ append: mockAppendFn }) },
}));
jest.mock('../../db/local', () => ({ saveCall: jest.fn().mockResolvedValue(undefined) }));

const mockEmit = jest.fn();
const mockOn = jest.fn();
const mockOff = jest.fn();
const mockSocket = { emit: mockEmit, on: mockOn, off: mockOff };
jest.mock('../client', () => ({
  getSocket: () => mockSocket,
  isConnected: () => true,
}));

jest.mock('react-native', () => ({
  AppState: { currentState: 'active' },
  Platform: { OS: 'android', select: (obj: Record<string, unknown>) => obj.android ?? obj.default },
  NativeModules: {},
}));
jest.mock('../../components/AlertHost', () => ({ themedAlert: jest.fn() }));
// callkeep — only reached if an invite is ACCEPTED (i.e. the v2-policy guard
// failed to refuse it). Stubbed so the "would-be-accepted" path is observable.
jest.mock('../../calls/callkeep', () => ({
  displayIncomingCall: jest.fn(),
  endNativeCall: jest.fn(),
  reportCallConnected: jest.fn(),
  setNativeMuted: jest.fn(),
}));

import nacl from 'tweetnacl';
import { themedAlert } from '../../components/AlertHost';
import { useCall } from '../../store/call';
import { startCall, attachCallHandlers } from '../calls';

const mockAlert = themedAlert as jest.Mock;

/** Events emitted on the socket, in order. */
function emittedEvents(): string[] {
  return mockEmit.mock.calls.map((c) => c[0] as string);
}
/** The payload of the first emit of `event`, or undefined. */
function firstPayload(event: string): Record<string, unknown> | undefined {
  const call = mockEmit.mock.calls.find((c) => c[0] === event);
  return call?.[1] as Record<string, unknown> | undefined;
}

describe('calls.ts — sealed-sender (v2) policy', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.clearAllMocks();
    mockPeerState.handlers = null;
    mockPeerRecord = { publicKeyB64: 'pk', signingPublicKeyB64: 'spk', name: 'Peer One' };
    useCall.getState().reset();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    useCall.getState().reset();
  });

  it('startCall emits the sealed v2 invite (no `from` on the wire) and never a v1 invite', async () => {
    await startCall('peer-A', 'audio');

    const events = emittedEvents();
    expect(events).toContain('call:invite:v2');
    expect(events).not.toContain('call:invite'); // legacy v1 must never be emitted

    const invite = firstPayload('call:invite:v2')!;
    expect(invite).toMatchObject({ callId: 'test-call-uuid', to: 'peer-A', media: 'audio' });
    expect(invite).not.toHaveProperty('from'); // sealed-sender: relay never learns the caller
  });

  it('startCall FAILS CLOSED when the peer box key is unavailable — no v1 fallback', async () => {
    // Contact known by name but missing the static X25519 key → v2 impossible.
    mockPeerRecord = { signingPublicKeyB64: 'spk', name: 'Keyless Peer' };

    await startCall('peer-B', 'audio');

    // No invite of ANY version may reach the relay.
    expect(emittedEvents().some((e) => e.startsWith('call:invite'))).toBe(false);
    // The user is told, and the call is torn down cleanly.
    expect(mockAlert).toHaveBeenCalledTimes(1);
    expect(useCall.getState().status).toBe('ended');
  });

  it('v1 call:invite handler is not wired (Fase C: v1 removed entirely)', () => {
    attachCallHandlers();
    // After Fase C the client no longer registers a handler for the v1
    // `call:invite` event at all — the relay does not route it, and neither
    // should the client listen. The `call:invite:v2` handler IS wired.
    const registeredEvents = (mockOn.mock.calls as [string, unknown][]).map(([ev]) => ev);
    expect(registeredEvents).not.toContain('call:invite');
    expect(registeredEvents).not.toContain('call:answer');
    expect(registeredEvents).not.toContain('call:ice');
    expect(registeredEvents).not.toContain('call:hangup');
    // v2 handlers ARE wired
    expect(registeredEvents).toContain('call:invite:v2');
    expect(registeredEvents).toContain('call:answer:v2');
    expect(registeredEvents).toContain('call:ice:v2');
    expect(registeredEvents).toContain('call:hangup:v2');
  });
});
