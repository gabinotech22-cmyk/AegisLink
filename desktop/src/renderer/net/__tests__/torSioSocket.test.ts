/**
 * TorSioSocket — the renderer half of the socket.io-over-Tor dumb pipe. Drives
 * it with a fake `window.aegis.tor` preload bridge and asserts the contract that
 * mailboxSocket.ts relies on: listeners declared before connect() are forwarded
 * to main, events dispatch by id, acks round-trip, `connected` tracks
 * connect/disconnect, and a disconnected socket stops receiving.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

type SioCb = (msg: unknown) => void;
type StatusCb = (s: unknown) => void;

const bridge = {
  sioListeners: [] as SioCb[],
  statusListeners: [] as StatusCb[],
  connects: [] as Array<{ id: string; url: string; auth: unknown; events: string[] }>,
  emits: [] as Array<{ id: string; event: string; payload: unknown; ackId: string | null }>,
  disconnects: [] as string[],
  status: { state: 'starting', progress: 10, summary: 'x', controlSocksPort: 1, mailboxSocksPort: 2 },
};

(globalThis as unknown as { window: unknown }).window = {
  aegis: {
    tor: {
      status: () => Promise.resolve(bridge.status),
      onStatus: (cb: StatusCb) => { bridge.statusListeners.push(cb); return () => {}; },
      sioConnect: (id: string, url: string, authJson: string, eventsJson: string) => {
        bridge.connects.push({ id, url, auth: JSON.parse(authJson), events: JSON.parse(eventsJson) });
        return Promise.resolve(true);
      },
      sioEmit: (id: string, event: string, payloadJson: string, ackId: string | null) => {
        bridge.emits.push({ id, event, payload: JSON.parse(payloadJson), ackId });
        return Promise.resolve(true);
      },
      sioDisconnect: (id: string) => { bridge.disconnects.push(id); return Promise.resolve(true); },
      onSioEvent: (cb: SioCb) => { bridge.sioListeners.push(cb); return () => {}; },
    },
  },
};

const { TorSioSocket, useTor, isTorOn, whenTorReady } = await import('../tor');

function push(msg: unknown): void { for (const cb of bridge.sioListeners) cb(msg); }

beforeEach(() => {
  bridge.connects.length = 0; bridge.emits.length = 0; bridge.disconnects.length = 0;
});

describe('TorSioSocket', () => {
  it('forwards the declared event list and auth to main on connect()', () => {
    const s = new TorSioSocket('http://abc.onion', { auth: { mailboxId: 'm1' } });
    s.on('mailbox:challenge', () => {}).on('envelope:mb', () => {});
    s.connect();
    expect(bridge.connects).toHaveLength(1);
    expect(bridge.connects[0]).toMatchObject({ id: s.id, url: 'http://abc.onion', auth: { mailboxId: 'm1' }, events: ['mailbox:challenge', 'envelope:mb'] });
    s.connect(); // idempotent
    expect(bridge.connects).toHaveLength(1);
  });

  it('dispatches events by id and tracks connected', () => {
    const a = new TorSioSocket('http://abc.onion', { auth: {} });
    const b = new TorSioSocket('http://abc.onion', { auth: {} });
    const gotA = vi.fn(); const gotB = vi.fn();
    a.on('mailbox:challenge', gotA); b.on('mailbox:challenge', gotB);
    a.connect(); b.connect();
    expect(a.connected).toBe(false);
    push({ id: a.id, event: 'connect', args: [] });
    expect(a.connected).toBe(true);
    expect(b.connected).toBe(false);
    push({ id: a.id, event: 'mailbox:challenge', args: [{ nonce: 'n' }] });
    expect(gotA).toHaveBeenCalledWith({ nonce: 'n' });
    expect(gotB).not.toHaveBeenCalled();
    push({ id: a.id, event: 'disconnect', args: ['transport close'] });
    expect(a.connected).toBe(false);
  });

  it('round-trips an ack through main', () => {
    const s = new TorSioSocket('http://abc.onion', { auth: {} });
    s.connect();
    const ack = vi.fn();
    s.emit('envelope:mb', { id: 'e1' }, ack);
    expect(bridge.emits).toHaveLength(1);
    const { ackId } = bridge.emits[0];
    expect(typeof ackId).toBe('string');
    push({ id: s.id, event: '__ack', args: [{ delivered: true }], ackId });
    expect(ack).toHaveBeenCalledWith({ delivered: true });
    // second delivery of the same ack is ignored (one-shot)
    push({ id: s.id, event: '__ack', args: [{ delivered: true }], ackId });
    expect(ack).toHaveBeenCalledTimes(1);
  });

  it('emit without ack sends ackId null', () => {
    const s = new TorSioSocket('http://abc.onion', { auth: {} });
    s.connect();
    s.emit('envelope:ack', { id: 'x' });
    expect(bridge.emits[0]).toMatchObject({ event: 'envelope:ack', payload: { id: 'x' }, ackId: null });
  });

  it('disconnect() tears down in main and stops dispatch', () => {
    const s = new TorSioSocket('http://abc.onion', { auth: {} });
    const got = vi.fn();
    s.on('envelope:mb', got);
    s.connect();
    push({ id: s.id, event: 'connect', args: [] });
    s.disconnect();
    expect(bridge.disconnects).toEqual([s.id]);
    expect(s.connected).toBe(false);
    push({ id: s.id, event: 'envelope:mb', args: [{}] });
    expect(got).not.toHaveBeenCalled();
  });

  it('a throwing listener does not break the pipe for the next listener', () => {
    const s = new TorSioSocket('http://abc.onion', { auth: {} });
    const second = vi.fn();
    s.on('auth:ok', () => { throw new Error('boom'); }).on('auth:ok', second);
    s.connect();
    push({ id: s.id, event: 'auth:ok', args: [] });
    expect(second).toHaveBeenCalled();
  });
});

describe('useTor / whenTorReady', () => {
  it('reflects status pushed from main and resolves whenTorReady only on "on"', async () => {
    useTor.getState().init();
    await Promise.resolve();
    expect(isTorOn()).toBe(false);
    let resolved = false;
    const p = whenTorReady().then(() => { resolved = true; });
    for (const cb of bridge.statusListeners) cb({ state: 'starting', progress: 80, summary: 'Loading', controlSocksPort: 1, mailboxSocksPort: 2 });
    await Promise.resolve();
    expect(resolved).toBe(false);
    for (const cb of bridge.statusListeners) cb({ state: 'on', progress: 100, summary: 'Done', controlSocksPort: 1, mailboxSocksPort: 2 });
    await p;
    expect(isTorOn()).toBe(true);
  });
});
