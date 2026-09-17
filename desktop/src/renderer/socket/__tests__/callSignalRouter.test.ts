/**
 * callSignalRouter.test.ts — federation F4 (docs/FEDERATION-DESIGN.md D3).
 * Desktop twin of the routing assertions in mobile
 * socket/__tests__/client.callSignal.test.ts:
 *   - a local peer keeps the socket event, a foreign peer gets a transient
 *     `call_signal` sealed message (invites with wakeHint: 'call');
 *   - per-recipient fan-outs split local items / foreign copies;
 *   - the sealed dispatch reaches the registered handler with `from` pinned,
 *     drops unknown events and malformed payloads; the socket path has no `from`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { encodeBase64 } from 'tweetnacl-util';

const ONION = 'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd.onion';
const KEY = encodeBase64(new Uint8Array(32));

const h = vi.hoisted(() => ({
  contacts: [] as Array<{ aegisId: string; publicKeyB64: string; relayOnion?: string | null }>,
  sendMessage: vi.fn(async (_o: unknown) => undefined),
}));

vi.mock('../client', () => ({ sendMessage: (o: unknown) => h.sendMessage(o) }));
vi.mock('../../store/contacts', () => ({ useContacts: { getState: () => ({ contacts: h.contacts }) } }));
vi.mock('../../store/identity', () => ({
  useIdentity: { getState: () => ({ identity: { aegisId: 'ME', secretKey: new Uint8Array(32), signingSecretKey: new Uint8Array(64) } }) },
}));
vi.mock('../../config', () => ({ RELAY_URL: 'https://relay.test', TOR_RELAY: true, ONION_URL: null, FEDERATION: true }));

import { routeCallSignal, routeCallSignalItems, onCallSignal, dispatchSealedCallSignal, clearCallSignalHandlers } from '../callSignalRouter';

function fakeSocket() {
  const handlers = new Map<string, (...a: unknown[]) => void>();
  return {
    emit: vi.fn(),
    on: (e: string, cb: (...a: unknown[]) => void) => { handlers.set(e, cb); },
    handlers,
  };
}

describe('callSignalRouter (F4)', () => {
  beforeEach(() => {
    h.contacts = [
      { aegisId: 'LOCAL', publicKeyB64: KEY },
      { aegisId: 'FOREIGN', publicKeyB64: KEY, relayOnion: ONION },
    ];
    h.sendMessage.mockClear();
    clearCallSignalHandlers();
  });

  it('local peer → socket event with `to`; foreign peer → transient sealed call_signal, invite carries wakeHint=call', () => {
    const s = fakeSocket();
    expect(routeCallSignal(s, 'call:invite:v2', 'LOCAL', { callId: 'c1', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' })).toBe(true);
    expect(s.emit).toHaveBeenCalledWith('call:invite:v2', { callId: 'c1', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z', to: 'LOCAL' });
    expect(h.sendMessage).not.toHaveBeenCalled();

    s.emit.mockClear();
    expect(routeCallSignal(s, 'call:invite:v2', 'FOREIGN', { callId: 'c2', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' })).toBe(true);
    expect(s.emit).not.toHaveBeenCalled(); // never the home socket
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    const opts = h.sendMessage.mock.calls[0][0] as Record<string, unknown>;
    expect(opts.recipientAegisId).toBe('FOREIGN');
    expect(opts.type).toBe('call_signal');
    expect(opts.transient).toBe(true);
    expect(opts.skipLocalAppend).toBe(true);
    expect(opts.wakeHint).toBe('call');
    expect(typeof opts.expiresAt).toBe('number');
    expect(JSON.parse(opts.plaintext as string)).toEqual({ event: 'call:invite:v2', msg: { callId: 'c2', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' } });

    h.sendMessage.mockClear();
    routeCallSignal(s, 'call:ice:v2', 'FOREIGN', { callId: 'c2', ciphertext: 'x', nonce: 'y' });
    expect((h.sendMessage.mock.calls[0][0] as Record<string, unknown>).wakeHint).toBeUndefined();
  });

  it('a foreign peer with an unusable key is a signaling failure, never a home-socket emit', () => {
    h.contacts = [{ aegisId: 'FOREIGN', publicKeyB64: '!!!', relayOnion: ONION }];
    const s = fakeSocket();
    expect(routeCallSignal(s, 'call:invite:v2', 'FOREIGN', { callId: 'c' })).toBe(false);
    expect(s.emit).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('fan-out items split: local items in one emit, one sealed copy per foreign member', () => {
    const s = fakeSocket();
    routeCallSignalItems(s, 'group_call:channel', { callId: 'g', groupId: 'grp', media: 'audio' }, [
      { to: 'LOCAL', ciphertext: 'L', nonce: 'l' },
      { to: 'FOREIGN', ciphertext: 'F', nonce: 'f' },
    ]);
    expect(s.emit).toHaveBeenCalledTimes(1);
    expect(s.emit).toHaveBeenCalledWith('group_call:channel', { callId: 'g', groupId: 'grp', media: 'audio', items: [{ to: 'LOCAL', ciphertext: 'L', nonce: 'l' }] });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(JSON.parse((h.sendMessage.mock.calls[0][0] as { plaintext: string }).plaintext)).toEqual({
      event: 'group_call:channel', msg: { callId: 'g', groupId: 'grp', media: 'audio', ciphertext: 'F', nonce: 'f' },
    });
  });

  it('sealed dispatch reaches the registered handler with `from`; unknown/malformed dropped; socket path has no `from`', async () => {
    const s = fakeSocket();
    const handler = vi.fn();
    onCallSignal(s, 'call:hangup:v2', handler);
    await dispatchSealedCallSignal('PEER', JSON.stringify({ event: 'envelope', msg: { x: 1 } }));
    await dispatchSealedCallSignal('PEER', JSON.stringify({ event: 'call:hangup:v2', msg: 'nope' }));
    await dispatchSealedCallSignal('PEER', 'not json');
    await dispatchSealedCallSignal('PEER', JSON.stringify({ event: 'call:ice:v2', msg: {} })); // no handler
    expect(handler).not.toHaveBeenCalled();
    await dispatchSealedCallSignal('PEER', JSON.stringify({ event: 'call:hangup:v2', msg: { callId: 'c', reason: 'busy' } }));
    expect(handler).toHaveBeenCalledWith({ callId: 'c', reason: 'busy' }, 'PEER');
    handler.mockClear();
    s.handlers.get('call:hangup:v2')!({ callId: 'c' });
    expect(handler).toHaveBeenCalledWith({ callId: 'c' });
  });
});
