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
  contacts: [] as Array<{ aegisId: string; publicKeyB64: string; relayOnion?: string | null; caps?: string[] | null }>,
  sendMessage: vi.fn(async (_o: unknown) => undefined),
  mailboxAuthed: true,
  roots: new Set<string>(),
}));

vi.mock('../client', () => ({ sendMessage: (o: unknown) => h.sendMessage(o) }));
vi.mock('../../store/contacts', () => ({ useContacts: { getState: () => ({ contacts: h.contacts }) } }));
vi.mock('../../store/identity', () => ({
  useIdentity: { getState: () => ({ identity: { aegisId: 'ME', secretKey: new Uint8Array(32), signingSecretKey: new Uint8Array(64) } }) },
}));
vi.mock('../../config', () => ({ RELAY_URL: 'https://relay.test', TOR_RELAY: true, ONION_URL: null, FEDERATION: true, MAILBOX_ENABLED: true }));
vi.mock('../mailboxSocket', () => ({ isMailboxAuthed: () => h.mailboxAuthed }));
vi.mock('../../crypto/mailboxStore', () => ({
  getContactCurrentMailboxId: async (id: string) => (h.roots.has(id) ? `mbx-${id}` : null),
}));

/** The sealed decision is chained per peer (order-preserving): let it settle. */
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

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
    h.mailboxAuthed = true;
    h.roots.clear();
    clearCallSignalHandlers();
  });

  it('local peer → socket event with `to`; foreign peer → transient sealed call_signal, invite carries wakeHint=call', async () => {
    const s = fakeSocket();
    expect(routeCallSignal(s, 'call:invite:v2', 'LOCAL', { callId: 'c1', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' })).toBe(true);
    expect(s.emit).toHaveBeenCalledWith('call:invite:v2', { callId: 'c1', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z', to: 'LOCAL' });
    expect(h.sendMessage).not.toHaveBeenCalled();

    s.emit.mockClear();
    expect(routeCallSignal(s, 'call:invite:v2', 'FOREIGN', { callId: 'c2', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' })).toBe(true);
    await settle();
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
    await settle();
    expect((h.sendMessage.mock.calls[0][0] as Record<string, unknown>).wakeHint).toBeUndefined();
  });

  it('D6: local peer with `sealed-calls` + reachable mailbox → sealed call_signal in order; no cap or mailbox down → legacy event', async () => {
    h.contacts = [
      { aegisId: 'CAP', publicKeyB64: KEY, caps: ['sealed-calls'] },
      { aegisId: 'OLD', publicKeyB64: KEY },
    ];
    h.roots.add('CAP');
    const s = fakeSocket();
    expect(routeCallSignal(s, 'call:invite:v2', 'CAP', { callId: 'c3', media: 'audio', ciphertext: 'x', nonce: 'y', epk: 'z' })).toBe(true);
    expect(routeCallSignal(s, 'call:ice:v2', 'CAP', { callId: 'c3', ciphertext: 'i', nonce: 'n' })).toBe(true);
    await settle();
    expect(s.emit).not.toHaveBeenCalled();
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    const [invite, ice] = h.sendMessage.mock.calls.map((c) => c[0] as Record<string, unknown>);
    expect(invite.recipientAegisId).toBe('CAP');
    expect(invite.wakeHint).toBe('call');
    expect(JSON.parse(invite.plaintext as string).event).toBe('call:invite:v2');
    expect(JSON.parse(ice.plaintext as string).event).toBe('call:ice:v2');

    h.sendMessage.mockClear();
    routeCallSignal(s, 'call:invite:v2', 'OLD', { callId: 'c4', ciphertext: 'x', nonce: 'y' });
    await settle();
    expect(s.emit).toHaveBeenCalledWith('call:invite:v2', { callId: 'c4', ciphertext: 'x', nonce: 'y', to: 'OLD' });
    expect(h.sendMessage).not.toHaveBeenCalled();

    s.emit.mockClear();
    h.mailboxAuthed = false;
    routeCallSignal(s, 'call:invite:v2', 'CAP', { callId: 'c5', ciphertext: 'x', nonce: 'y' });
    await settle();
    expect(s.emit).toHaveBeenCalledWith('call:invite:v2', { callId: 'c5', ciphertext: 'x', nonce: 'y', to: 'CAP' });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('D6: fan-out — capable local member gets a sealed copy; with the mailbox down its item goes in fan-out shape', async () => {
    h.contacts = [
      { aegisId: 'CAP', publicKeyB64: KEY, caps: ['sealed-calls'] },
      { aegisId: 'OLD', publicKeyB64: KEY },
    ];
    h.roots.add('CAP');
    const s = fakeSocket();
    routeCallSignalItems(s, 'group_call:channel', { callId: 'g1' }, [
      { to: 'CAP', ciphertext: 'ca', nonce: 'na' },
      { to: 'OLD', ciphertext: 'co', nonce: 'no' },
    ]);
    await settle();
    expect(s.emit).toHaveBeenCalledWith('group_call:channel', { callId: 'g1', items: [{ to: 'OLD', ciphertext: 'co', nonce: 'no' }] });
    expect(h.sendMessage).toHaveBeenCalledTimes(1);

    s.emit.mockClear();
    h.sendMessage.mockClear();
    h.mailboxAuthed = false;
    routeCallSignalItems(s, 'group_call:channel', { callId: 'g2' }, [{ to: 'CAP', ciphertext: 'ca', nonce: 'na' }]);
    await settle();
    expect(s.emit).toHaveBeenCalledWith('group_call:channel', { callId: 'g2', items: [{ to: 'CAP', ciphertext: 'ca', nonce: 'na' }] });
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('a foreign peer with an unusable key is a signaling failure, never a home-socket emit', () => {
    h.contacts = [{ aegisId: 'FOREIGN', publicKeyB64: '!!!', relayOnion: ONION }];
    const s = fakeSocket();
    expect(routeCallSignal(s, 'call:invite:v2', 'FOREIGN', { callId: 'c' })).toBe(false);
    expect(s.emit).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  it('fan-out items split: local items in one emit, one sealed copy per foreign member', async () => {
    const s = fakeSocket();
    routeCallSignalItems(s, 'group_call:channel', { callId: 'g', groupId: 'grp', media: 'audio' }, [
      { to: 'LOCAL', ciphertext: 'L', nonce: 'l' },
      { to: 'FOREIGN', ciphertext: 'F', nonce: 'f' },
    ]);
    expect(s.emit).toHaveBeenCalledTimes(1);
    expect(s.emit).toHaveBeenCalledWith('group_call:channel', { callId: 'g', groupId: 'grp', media: 'audio', items: [{ to: 'LOCAL', ciphertext: 'L', nonce: 'l' }] });
    await settle();
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
