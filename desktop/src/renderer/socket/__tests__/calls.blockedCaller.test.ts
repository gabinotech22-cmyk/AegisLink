/**
 * calls.ts — a blocked contact cannot ring us (desktop parity with
 * mobile/src/socket/__tests__/calls.blockedCaller.test.ts).
 *
 * The sealed call:invite:v2 from a blocked contact used to ring. It is now
 * dropped SILENTLY — no "busy" hangup either, which would confirm we are
 * online.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeBase64 } from 'tweetnacl-util';

const B64_32 = encodeBase64(new Uint8Array(32));

const h = vi.hoisted(() => ({
  peerRecord: undefined as { publicKeyB64?: string; signingPublicKeyB64?: string; name?: string; blocked?: boolean; pending?: boolean } | undefined,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
  append: vi.fn(),
}));

vi.mock('../client', () => ({ getSocket: () => ({ emit: h.emit, on: h.on, off: h.off }), isConnected: () => true }));
vi.mock('../../config', () => ({ RELAY_URL: 'https://relay.test', TOR_RELAY: true, ONION_URL: null, FEDERATION: false }));
vi.mock('../../db/local', () => ({ saveCall: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../store/messages', () => ({ useMessages: { getState: () => ({ append: h.append }) } }));
vi.mock('../../store/identity', () => ({
  useIdentity: { getState: () => ({ identity: { aegisId: 'self-aegis-id', secretKey: new Uint8Array(32), signingSecretKey: new Uint8Array(64) } }) },
}));
vi.mock('../../store/contacts', () => ({ useContacts: { getState: () => ({ get: () => h.peerRecord }) } }));
vi.mock('../../crypto/callSession', () => ({
  sealCallInvite: vi.fn().mockReturnValue({ wire: { ciphertext: 'ct', nonce: 'n', epk: 'epk' }, callKey: new Uint8Array(32) }),
  openCallInvite: vi.fn().mockReturnValue({ from: 'peer-A', offer: 'sdp-offer', callKey: new Uint8Array(32) }),
  sealWithCallKey: vi.fn().mockReturnValue({ ciphertext: 'ct', nonce: 'n' }),
  openWithCallKey: vi.fn().mockReturnValue(null),
}));

import { useCall } from '../../store/call';
import { attachCallHandlers, callerMayRing } from '../calls';

function inviteHandler(): (msg: unknown) => Promise<void> | void {
  const call = (h.on.mock.calls as [string, unknown][]).find(([ev]) => ev === 'call:invite:v2');
  return call![1] as (msg: unknown) => Promise<void> | void;
}
const INVITE = { callId: 'call-B', media: 'audio', ciphertext: 'ct', nonce: 'n', epk: 'epk' };

describe('calls.ts — blocked callers (desktop)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useCall.getState().reset();
    h.peerRecord = { publicKeyB64: B64_32, signingPublicKeyB64: B64_32, name: 'Peer' };
  });

  it('callerMayRing: accepted + unblocked only', () => {
    expect(callerMayRing('peer-A')).toBe(true);
    h.peerRecord = { ...h.peerRecord, blocked: true };
    expect(callerMayRing('peer-A')).toBe(false);
    h.peerRecord = { publicKeyB64: B64_32, signingPublicKeyB64: B64_32, pending: true };
    expect(callerMayRing('peer-A')).toBe(false);
    h.peerRecord = undefined;
    expect(callerMayRing('peer-A')).toBe(false);
  });

  it('a blocked contact never rings and gets no signal back', async () => {
    h.peerRecord = { ...h.peerRecord, blocked: true };
    attachCallHandlers();
    await inviteHandler()(INVITE);
    expect(useCall.getState().status).toBe('idle');
    expect(h.emit).not.toHaveBeenCalled();
    expect(h.append).not.toHaveBeenCalled();
  });

  it('an accepted contact still rings', async () => {
    attachCallHandlers();
    await inviteHandler()(INVITE);
    expect(useCall.getState().status).toBe('incoming-ringing');
  });
});
