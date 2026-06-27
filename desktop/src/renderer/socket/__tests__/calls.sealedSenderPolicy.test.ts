/**
 * calls.sealedSenderPolicy.test.ts — sealed-sender (v2) call policy, Fase A.
 *
 * Desktop twin of mobile/src/socket/__tests__/calls.sealedSenderPolicy.test.ts
 * (golden rules #4 sealed-sender-in-calls, #5 mobile↔desktop parity, #6 fail
 * closed, #11 a test per fix — desktop previously had NO call-signaling suite).
 *
 * Under the default SEALED_TRANSPORT_VERSION='v2' policy an updated desktop
 * client must never hand the relay a `from`-bearing (and, on desktop, cleartext)
 * v1 call event:
 *   1. startCall() with no resolvable peer box key FAILS CLOSED — no v1 invite.
 *   2. startCall() with keys present emits the sealed `call:invite:v2` (no `from`).
 *   3. An inbound legacy v1 `call:invite` is REFUSED (we never answer → never
 *      emit our own `from`).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { encodeBase64 } from 'tweetnacl-util';

// A real base64 encoding of 32 zero bytes — decodes back to a 32-byte key so
// peerBoxKey()/peerSigningKey() accept it (tweetnacl-util is NOT mocked here).
const B64_32 = encodeBase64(new Uint8Array(32));

const h = vi.hoisted(() => ({
  peerRecord: undefined as { publicKeyB64?: string; signingPublicKeyB64?: string; name?: string } | undefined,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}));

vi.mock('../client', () => ({
  getSocket: () => ({ emit: h.emit, on: h.on, off: h.off }),
  isConnected: () => true,
}));
vi.mock('../../config', () => ({
  RELAY_URL: 'https://relay.test',
  SEALED_TRANSPORT_VERSION: 'v2',
}));
vi.mock('../../db/local', () => ({ saveCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../store/messages', () => ({ useMessages: { getState: () => ({ append: vi.fn() }) } }));
vi.mock('../../store/identity', () => ({
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
vi.mock('../../store/contacts', () => ({
  useContacts: { getState: () => ({ get: () => h.peerRecord }) },
}));
// Stub the sealed-sender primitives — real crypto is covered by callSession's own
// unit tests. sealCallInvite returns a wire with NO `from`, exactly like prod.
vi.mock('../../crypto/callSession', () => ({
  sealCallInvite: vi.fn().mockReturnValue({
    wire: { ciphertext: 'ct', nonce: 'n', epk: 'epk' },
    callKey: new Uint8Array(32),
  }),
  openCallInvite: vi.fn().mockReturnValue(null),
  sealWithCallKey: vi.fn().mockReturnValue({ ciphertext: 'ct', nonce: 'n' }),
  openWithCallKey: vi.fn().mockReturnValue(null),
}));

import { useCall } from '../../store/call';
import { startCall, attachCallHandlers } from '../calls';

/** Minimal browser-WebRTC stubs so the inline createPeer() runs under Node. */
function installWebRtcStubs(): void {
  class FakePC {
    connectionState = 'new';
    constructor(_cfg?: unknown) {}
    addTrack(): void {}
    addEventListener(): void {}
    async createOffer(): Promise<object> { return { type: 'offer', sdp: 'o' }; }
    async createAnswer(): Promise<object> { return { type: 'answer', sdp: 'a' }; }
    async setLocalDescription(): Promise<void> {}
    async setRemoteDescription(): Promise<void> {}
    async addIceCandidate(): Promise<void> {}
    close(): void {}
  }
  // vi.stubGlobal handles getter-only globals (e.g. `navigator` in Node 20).
  vi.stubGlobal('RTCPeerConnection', FakePC);
  vi.stubGlobal('RTCSessionDescription', class { constructor(_v?: unknown) {} });
  vi.stubGlobal('RTCIceCandidate', class { constructor(_v?: unknown) {} });
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: async () => ({ getTracks: () => [], getAudioTracks: () => [], getVideoTracks: () => [] }),
    },
  });
  // fetchTurnConfig() signs then fetches; reject so it falls back to STUN config.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no turn in test')));
}

function emittedEvents(): string[] {
  return h.emit.mock.calls.map((c) => c[0] as string);
}

describe('desktop calls.ts — sealed-sender (v2) policy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    installWebRtcStubs();
    h.peerRecord = { publicKeyB64: B64_32, signingPublicKeyB64: B64_32, name: 'Peer One' };
    useCall.getState().reset();
  });
  afterEach(() => {
    useCall.getState().reset();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('startCall emits the sealed v2 invite (no `from`) and never a v1 invite', async () => {
    await startCall('peer-A', 'audio');

    const events = emittedEvents();
    expect(events).toContain('call:invite:v2');
    expect(events).not.toContain('call:invite');

    const invite = h.emit.mock.calls.find((c) => c[0] === 'call:invite:v2')?.[1] as Record<string, unknown>;
    expect(invite).toMatchObject({ to: 'peer-A', media: 'audio' });
    expect(invite).not.toHaveProperty('from');
  });

  it('startCall FAILS CLOSED when the peer box key is unavailable — no v1 fallback', async () => {
    h.peerRecord = { signingPublicKeyB64: B64_32, name: 'Keyless Peer' }; // no publicKeyB64

    await startCall('peer-B', 'audio');

    expect(emittedEvents().some((e) => e.startsWith('call:invite'))).toBe(false);
    expect(useCall.getState().status).toBe('ended');
  });

  it('refuses an inbound legacy v1 call:invite under the v2 policy', () => {
    attachCallHandlers();
    const inviteEntry = (h.on.mock.calls as [string, (m: unknown) => void][]).find(([ev]) => ev === 'call:invite');
    expect(inviteEntry).toBeDefined();
    const v1InviteHandler = inviteEntry![1];

    // Desktop v1 invites are cleartext; absent the guard this would ring.
    v1InviteHandler({ callId: 'call-x', from: 'peer-C', media: 'audio', offer: 'plain-sdp' });

    expect(useCall.getState().status).toBe('idle'); // refused before ringing
    expect(emittedEvents()).toHaveLength(0);
  });
});
