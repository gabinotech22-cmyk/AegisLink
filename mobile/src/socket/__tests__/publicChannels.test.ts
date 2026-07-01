/**
 * socket/publicChannels — pubchannel:* transport client (Phase 2c)
 *
 * Verifies the thin transport layer: emits carry the right event + payload,
 * acks resolve/reject correctly, the socket-down path rejects, and subscriptions
 * register/unregister handlers. The relay is mocked — this is the client contract,
 * not an integration test (that lives in server/__tests__/publicChannels.relay).
 */

// A minimal fake socket.io client that records emits and lets tests drive acks/events.
class FakeSocket {
  public emits: Array<{ event: string; payload: unknown }> = [];
  public handlers = new Map<string, Set<(p: unknown) => void>>();
  private ackFor = new Map<string, unknown>();

  /** Pre-stage the ack a given event will resolve with. */
  setAck(event: string, ack: unknown): void { this.ackFor.set(event, ack); }

  emit(event: string, payload: unknown, cb?: (res: unknown) => void): void {
    this.emits.push({ event, payload });
    if (cb && this.ackFor.has(event)) cb(this.ackFor.get(event));
  }
  on(event: string, cb: (p: unknown) => void): void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(cb);
  }
  off(event: string, cb: (p: unknown) => void): void {
    this.handlers.get(event)?.delete(cb);
  }
  fire(event: string, payload: unknown): void {
    this.handlers.get(event)?.forEach((cb) => cb(payload));
  }
}

let mockSocket: FakeSocket | null = null;
jest.mock('../client', () => ({
  getSocket: () => mockSocket,
}));

import {
  pubchannelJoin,
  pubchannelApply,
  pubchannelPost,
  pubchannelPull,
  pubchannelDelete,
  onPubchannelMsg,
  onPubchannelTombstone,
} from '../publicChannels';

beforeEach(() => { mockSocket = new FakeSocket(); });

describe('emit + ack', () => {
  it('pubchannelJoin emits the right event/payload and returns the manifest', async () => {
    mockSocket!.setAck('pubchannel:join', { ok: true, manifest: '{"channelId":"X"}' });
    const ack = await pubchannelJoin('chan-1', 'tok-abc');

    expect(mockSocket!.emits[0]).toEqual({
      event: 'pubchannel:join',
      payload: { channelId: 'chan-1', deliveryToken: 'tok-abc' },
    });
    expect(ack.ok).toBe(true);
    expect(ack.manifest).toBe('{"channelId":"X"}');
  });

  it('pubchannelPost forwards ciphertext/nonce/deliveryToken and never a `from`', async () => {
    mockSocket!.setAck('pubchannel:msg', { ok: true });
    await pubchannelPost('chan-1', 'CIPHER', 'NONCE', 'tok');

    const sent = mockSocket!.emits[0];
    expect(sent.event).toBe('pubchannel:msg');
    expect(sent.payload).toEqual({ channelId: 'chan-1', ciphertext: 'CIPHER', nonce: 'NONCE', deliveryToken: 'tok' });
    expect(JSON.stringify(sent.payload)).not.toContain('from');
  });

  it('pubchannelPull passes sinceSeqNum and returns posts', async () => {
    mockSocket!.setAck('pubchannel:pull', { ok: true, posts: [{ seqNum: 3, ciphertext_b64: 'c', nonce_b64: 'n' }] });
    const ack = await pubchannelPull('chan-1', 2);
    expect(mockSocket!.emits[0].payload).toEqual({ channelId: 'chan-1', sinceSeqNum: 2 });
    expect(ack.posts).toHaveLength(1);
  });

  it('pubchannelApply forwards the join ephemeral pubkey', async () => {
    mockSocket!.setAck('pubchannel:apply', { ok: true });
    await pubchannelApply('chan-1', 'EPK');
    expect(mockSocket!.emits[0]).toEqual({ event: 'pubchannel:apply', payload: { channelId: 'chan-1', joinEpk: 'EPK' } });
  });

  it('pubchannelDelete forwards the signature only (no client pubkey)', async () => {
    mockSocket!.setAck('pubchannel:delete', { ok: true });
    await pubchannelDelete('chan-1', 5, 'SIG');
    const payload = mockSocket!.emits[0].payload as Record<string, unknown>;
    expect(payload).toEqual({ channelId: 'chan-1', seqNum: 5, sig: 'SIG' });
    expect(payload.channelPub).toBeUndefined();
  });

  it('propagates a feature_disabled ack without throwing', async () => {
    mockSocket!.setAck('pubchannel:join', { ok: false, error: 'feature_disabled' });
    const ack = await pubchannelJoin('chan-1', 'tok');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('feature_disabled');
  });
});

describe('failure paths', () => {
  it('rejects when the socket is unavailable', async () => {
    mockSocket = null;
    await expect(pubchannelJoin('chan-1', 'tok')).rejects.toThrow('socket_unavailable');
  });
});

describe('subscriptions', () => {
  it('onPubchannelMsg receives fan-out and unsubscribes cleanly', () => {
    const received: unknown[] = [];
    const unsub = onPubchannelMsg((e) => received.push(e));

    mockSocket!.fire('pubchannel:msg', { channelId: 'c', seqNum: 0, ciphertext: 'x', nonce: 'y', createdAt: 1 });
    expect(received).toHaveLength(1);

    unsub();
    mockSocket!.fire('pubchannel:msg', { channelId: 'c', seqNum: 1, ciphertext: 'x', nonce: 'y', createdAt: 2 });
    expect(received).toHaveLength(1); // no longer listening
  });

  it('onPubchannelTombstone wires the tombstone event', () => {
    const received: unknown[] = [];
    onPubchannelTombstone((e) => received.push(e));
    mockSocket!.fire('pubchannel:tombstone', { channelId: 'c', ts: 123 });
    expect(received).toEqual([{ channelId: 'c', ts: 123 }]);
  });

  it('subscribe is a no-op when the socket is down', () => {
    mockSocket = null;
    const unsub = onPubchannelMsg(() => {});
    expect(typeof unsub).toBe('function');
    expect(() => unsub()).not.toThrow();
  });
});
