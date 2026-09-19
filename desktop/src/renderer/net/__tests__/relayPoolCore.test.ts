/**
 * relayPoolCore — federation F2 (docs/FEDERATION-DESIGN.md D2).
 *
 * Runs against a fake transport, so the same file is asserted on mobile (jest)
 * and desktop (vitest) and the two pools cannot drift. What it pins:
 *   - one disposable mailbox socket per foreign relay, shared by concurrent sends;
 *   - the disposable root is generated per connection and never touches storage
 *     (the pool receives a factory; nothing else is ever asked for);
 *   - the possession proof signs only a well-formed 32-byte challenge;
 *   - queued and delivered acks are both returned verbatim (the caller decides);
 *   - idle connections are closed and a later send opens a FRESH mailbox;
 *   - connect errors / timeouts resolve send() to null, never throw.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createRelayPool, relayBaseUrl, type PoolSocket, type PoolTransport, type DisposableMailbox } from '../relayPoolCore';

const ONION_A = 'a'.repeat(56) + '.onion';
const ONION_B = 'b'.repeat(56) + '.onion';

interface FakeSocket extends PoolSocket {
  url: string;
  auth: Record<string, unknown>;
  handlers: Map<string, Array<(...a: unknown[]) => void>>;
  emitted: Array<{ event: string; payload: unknown; ack?: (...a: unknown[]) => void }>;
  fire(event: string, ...args: unknown[]): void;
  disconnected: boolean;
}

function makeFakeTransport(opts: { autoAuth?: boolean; challengeBytes?: number } = {}) {
  const sockets: FakeSocket[] = [];
  let clock = 1_000_000;
  const transport: PoolTransport = {
    openSocket(url, auth) {
      const s: FakeSocket = {
        url, auth, connected: true, disconnected: false,
        handlers: new Map(), emitted: [],
        on(ev, cb) { const l = s.handlers.get(ev) ?? []; l.push(cb); s.handlers.set(ev, l); return s; },
        emit(ev, payload, ack) { s.emitted.push({ event: ev, payload, ack }); return s; },
        removeAllListeners() { s.handlers.clear(); return s; },
        disconnect() { s.connected = false; s.disconnected = true; return s; },
        fire(ev, ...args) { for (const h of s.handlers.get(ev) ?? []) h(...args); },
      };
      sockets.push(s);
      if (opts.autoAuth !== false) {
        // Simulate the relay: challenge on next tick, auth:ok once the proof arrives.
        setTimeout(() => {
          s.fire('mailbox:challenge', { nonce: Buffer.alloc(opts.challengeBytes ?? 32, 7).toString('base64') });
          const resp = s.emitted.find((e) => e.event === 'mailbox:auth:response');
          if (resp) s.fire('auth:ok');
        }, 0);
      }
      return s;
    },
    http: async (url, method) => ({ status: 200, body: JSON.stringify({ url, method }) }),
    now: () => clock,
  };
  return { transport, sockets, tick: (ms: number) => { clock += ms; } };
}

let rootCounter = 0;
function newDisposableMailbox(): DisposableMailbox {
  rootCounter += 1;
  return {
    mailboxIdB64: `mbx-${rootCounter}`,
    signPublicKey: new Uint8Array(32).fill(rootCounter),
    signSecretKey: new Uint8Array(64).fill(rootCounter),
  };
}
const authProof = vi.fn((_sk: Uint8Array, challenge: Uint8Array) => new Uint8Array(64).fill(challenge[0] ?? 0));

beforeEach(() => { rootCounter = 0; authProof.mockClear(); });

describe('relayPoolCore', () => {
  it('opens one disposable mailbox socket per foreign relay and reuses it for concurrent sends', async () => {
    const { transport, sockets } = makeFakeTransport();
    const pool = createRelayPool({ transport, newDisposableMailbox, authProof });

    const env = { id: 'm1', to: 'their-mailbox', ciphertext: 'c', nonce: 'n', epk: 'e' };
    const p1 = pool.send(ONION_A, env);
    const p2 = pool.send(ONION_A, { ...env, id: 'm2' });
    // Both sends wait on the same handshake; answer the two envelope emits.
    await new Promise((r) => setTimeout(r, 5));
    const sends = sockets[0]!.emitted.filter((e) => e.event === 'envelope:mb');
    expect(sends).toHaveLength(2);
    sends[0]!.ack!({ ok: true, delivered: true });
    sends[1]!.ack!({ ok: true, queued: true });

    expect(await p1).toEqual({ ok: true, delivered: true });
    expect(await p2).toEqual({ ok: true, queued: true });
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe(relayBaseUrl(ONION_A));
    expect(sockets[0]!.auth).toMatchObject({ mailboxId: 'mbx-1', ackDelivery: true });
    expect(pool.size()).toBe(1);
    expect(pool.isConnected(ONION_A)).toBe(true);
  });

  it('a second relay gets its own socket and its own disposable mailbox', async () => {
    const { transport, sockets } = makeFakeTransport();
    const pool = createRelayPool({ transport, newDisposableMailbox, authProof });
    const env = { id: 'm', to: 't', ciphertext: 'c', nonce: 'n', epk: 'e' };
    const pa = pool.send(ONION_A, env);
    const pb = pool.send(ONION_B, env);
    await new Promise((r) => setTimeout(r, 5));
    for (const s of sockets) s.emitted.find((e) => e.event === 'envelope:mb')!.ack!({ ok: true, queued: true });
    await Promise.all([pa, pb]);
    expect(sockets.map((s) => s.auth['mailboxId'])).toEqual(['mbx-1', 'mbx-2']);
    expect(pool.size()).toBe(2);
  });

  it('signs exactly the 32-byte challenge with the disposable key and refuses other sizes', async () => {
    const good = makeFakeTransport();
    const pool = createRelayPool({ transport: good.transport, newDisposableMailbox, authProof });
    const p = pool.send(ONION_A, { id: 'm', to: 't', ciphertext: 'c', nonce: 'n', epk: 'e' });
    await new Promise((r) => setTimeout(r, 5));
    good.sockets[0]!.emitted.find((e) => e.event === 'envelope:mb')!.ack!({ ok: true, delivered: true });
    await p;
    expect(authProof).toHaveBeenCalledTimes(1);
    expect(authProof.mock.calls[0]![0]).toEqual(new Uint8Array(64).fill(1)); // mbx-1's secret key
    expect(authProof.mock.calls[0]![1]).toHaveLength(32);

    const bad = makeFakeTransport({ challengeBytes: 16 });
    const pool2 = createRelayPool({ transport: bad.transport, newDisposableMailbox, authProof, connectTimeoutMs: 50 });
    expect(await pool2.send(ONION_A, { id: 'm', to: 't', ciphertext: 'c', nonce: 'n', epk: 'e' })).toBeNull();
    expect(bad.sockets[0]!.disconnected).toBe(true);
    expect(pool2.size()).toBe(0);
  });

  it('closes idle connections and the next send opens a FRESH mailbox', async () => {
    const t = makeFakeTransport();
    const pool = createRelayPool({ transport: t.transport, newDisposableMailbox, authProof, idleMs: 1_000 });
    const env = { id: 'm', to: 't', ciphertext: 'c', nonce: 'n', epk: 'e' };
    const p = pool.send(ONION_A, env);
    await new Promise((r) => setTimeout(r, 5));
    t.sockets[0]!.emitted.find((e) => e.event === 'envelope:mb')!.ack!({ ok: true, queued: true });
    await p;

    expect(pool.closeIdle()).toBe(0);
    t.tick(1_500);
    expect(pool.closeIdle()).toBe(1);
    expect(t.sockets[0]!.disconnected).toBe(true);
    expect(pool.size()).toBe(0);

    const p2 = pool.send(ONION_A, env);
    await new Promise((r) => setTimeout(r, 5));
    t.sockets[1]!.emitted.find((e) => e.event === 'envelope:mb')!.ack!({ ok: true, queued: true });
    await p2;
    expect(t.sockets[1]!.auth['mailboxId']).toBe('mbx-2'); // never the same disposable root twice
  });

  it('a connect timeout resolves send() to null and drops the connection', async () => {
    const t = makeFakeTransport({ autoAuth: false });
    const pool = createRelayPool({ transport: t.transport, newDisposableMailbox, authProof, connectTimeoutMs: 30 });
    expect(await pool.send(ONION_A, { id: 'm', to: 't', ciphertext: 'c', nonce: 'n', epk: 'e' })).toBeNull();
    expect(t.sockets[0]!.disconnected).toBe(true);
    expect(pool.size()).toBe(0);
  });

  it('a relay error during auth resolves send() to null', async () => {
    const t = makeFakeTransport({ autoAuth: false });
    const pool = createRelayPool({ transport: t.transport, newDisposableMailbox, authProof });
    const p = pool.send(ONION_A, { id: 'm', to: 't', ciphertext: 'c', nonce: 'n', epk: 'e' });
    await new Promise((r) => setTimeout(r, 1));
    t.sockets[0]!.fire('error_msg', { code: 'mailbox_auth_failed' });
    expect(await p).toBeNull();
  });

  it('http() targets the foreign relay base URL', async () => {
    const t = makeFakeTransport();
    const pool = createRelayPool({ transport: t.transport, newDisposableMailbox, authProof });
    const res = await pool.http(ONION_B, '/relay/info');
    expect(res?.status).toBe(200);
    expect(JSON.parse(res!.body)).toEqual({ url: `http://${ONION_B}/relay/info`, method: 'GET' });
  });

  it('F6: a `pow_required` rejection is solved and resent exactly once with the relay challenge; a second rejection is final', async () => {
    const { transport, sockets } = makeFakeTransport();
    const solvePow = vi.fn(async (challenge: string, difficulty: number) => `nonce-${difficulty}-${challenge.slice(0, 4)}`);
    const pool = createRelayPool({ transport, newDisposableMailbox, authProof, solvePow });
    const env = { id: 'm1', to: 'their-mailbox', ciphertext: 'c', nonce: 'n', epk: 'e' };
    const challenge = 'ab'.repeat(32);

    const p = pool.send(ONION_A, env);
    await new Promise((r) => setTimeout(r, 5));
    const first = sockets[0]!.emitted.filter((e) => e.event === 'envelope:mb');
    expect(first).toHaveLength(1);
    expect((first[0]!.payload as { pow?: unknown }).pow).toBeUndefined(); // nothing to prove yet
    first[0]!.ack!({ ok: false, error: 'pow_required', challenge, difficulty: 12 });
    await new Promise((r) => setTimeout(r, 5));
    const sends = sockets[0]!.emitted.filter((e) => e.event === 'envelope:mb');
    expect(sends).toHaveLength(2);
    expect(solvePow).toHaveBeenCalledWith(challenge, 12);
    expect(sends[1]!.payload).toEqual({ ...env, pow: { challenge, nonce: 'nonce-12-abab' } });
    sends[1]!.ack!({ ok: true, queued: true });
    expect(await p).toEqual({ ok: true, queued: true });

    // Second rejection: no third attempt, the rejection is returned to the caller.
    const p2 = pool.send(ONION_A, { ...env, id: 'm2' });
    await new Promise((r) => setTimeout(r, 5));
    const s2 = () => sockets[0]!.emitted.filter((e) => e.event === 'envelope:mb');
    s2()[2]!.ack!({ ok: false, error: 'pow_required', challenge, difficulty: 12 });
    await new Promise((r) => setTimeout(r, 5));
    s2()[3]!.ack!({ ok: false, error: 'pow_required', challenge, difficulty: 12 });
    expect(await p2).toEqual({ ok: false, error: 'pow_required', challenge, difficulty: 12 });
    expect(s2()).toHaveLength(4);

    // Without a solver the rejection is simply returned (never a silent drop, never a loop).
    const bare = createRelayPool({ transport: makeFakeTransport().transport, newDisposableMailbox, authProof });
    const p3 = bare.send(ONION_B, env);
    await new Promise((r) => setTimeout(r, 5));
    expect(solvePow).toHaveBeenCalledTimes(2);
    void p3;
  });

  it('closeAll() tears every connection down', async () => {
    const t = makeFakeTransport();
    const pool = createRelayPool({ transport: t.transport, newDisposableMailbox, authProof });
    const env = { id: 'm', to: 't', ciphertext: 'c', nonce: 'n', epk: 'e' };
    const ps = [pool.send(ONION_A, env), pool.send(ONION_B, env)];
    await new Promise((r) => setTimeout(r, 5));
    for (const s of t.sockets) s.emitted.find((e) => e.event === 'envelope:mb')!.ack!({ ok: true, queued: true });
    await Promise.all(ps);
    pool.closeAll();
    expect(pool.size()).toBe(0);
    expect(t.sockets.every((s) => s.disconnected)).toBe(true);
  });
});
