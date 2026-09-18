/**
 * relay.federation.test.ts — federation F2 (docs/FEDERATION-DESIGN.md D2).
 *
 * Two relays, R1 and R2, in one process. B's mailbox binds on R2 (its home);
 * A's identity lives on R1 and is NEVER presented to R2. A reaches B by opening
 * a mailbox socket on R2 with a DISPOSABLE mailbox (random key, no identity,
 * receives nothing) and sending a sealed envelope to B's mailbox id — exactly
 * what the client relay pool does. Proves:
 *   (a) live delivery through R2 with zero identity on the wire;
 *   (b) R2 learns only two opaque mailbox ids; the disposable one never appears
 *       as a recipient anywhere;
 *   (c) the same envelope sent to R1 (where B is not bound) is only queued —
 *       relays do not talk to each other; the CLIENT chose the right relay;
 *   (d) a disposable mailbox needs no registration: R2 has no identity table
 *       entry for A and still accepts the possession proof.
 *
 * Caveat: both relays share the process-wide in-memory DB module, so the
 * offline queue is common. Live routing (`mailboxSockets`) is per relay
 * instance, which is what these assertions exercise.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import { jest } from '@jest/globals';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

import { initDb, identityRepo } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';
import { mailboxIdForSignPublicKey } from '../crypto/mailbox.js';
import { mailboxTopic } from '../push/ntfy.js';

interface Relay { httpServer: ReturnType<typeof createServer>; io: SocketServer; url: string; name: string }

async function startRelay(name: string): Promise<Relay> {
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketServer(httpServer, { cors: { origin: '*' } });
  attachRelay(io);
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = httpServer.address() as AddressInfo;
  return { httpServer, io, url: `http://127.0.0.1:${port}`, name };
}

async function stopRelay(r: Relay): Promise<void> {
  r.io.disconnectSockets(true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => { r.io.close(() => resolve()); });
  await new Promise<void>((resolve) => { r.httpServer.close(() => resolve()); });
}

interface MailboxKeys { signKeyPair: nacl.SignKeyPair; mailboxId: string }
function makeMailbox(seed: number): MailboxKeys {
  const seedBytes = new Uint8Array(32);
  new DataView(seedBytes.buffer).setUint32(0, seed, false);
  const signKeyPair = nacl.sign.keyPair.fromSeed(seedBytes);
  return { signKeyPair, mailboxId: mailboxIdForSignPublicKey(signKeyPair.publicKey) };
}
/** What the client pool does per foreign connection: a random root, never persisted. */
function disposableMailbox(): MailboxKeys {
  const signKeyPair = nacl.sign.keyPair();
  return { signKeyPair, mailboxId: mailboxIdForSignPublicKey(signKeyPair.publicKey) };
}

const open: ClientSocket[] = [];
function connectMailbox(relay: Relay, keys: MailboxKeys): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(relay.url, {
      auth: { mailboxId: keys.mailboxId, mailboxSignPubKey: encodeBase64(keys.signKeyPair.publicKey), ackDelivery: true },
      transports: ['websocket'],
      reconnection: false,
    });
    open.push(socket);
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('mailbox auth timeout')); }, 8_000);
    socket.on('mailbox:challenge', (c: { nonce: string }) => {
      const nonce = decodeBase64(c.nonce);
      if (nonce.length !== 32) { reject(new Error('bad challenge')); return; }
      socket.emit('mailbox:auth:response', { sig: encodeBase64(nacl.sign.detached(nonce, keys.signKeyPair.secretKey)) });
    });
    socket.on('auth:ok', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Server error: ${e.code}`)); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

type MbAck = { ok: boolean; delivered?: boolean; queued?: boolean; error?: string };
function sendMb(socket: ClientSocket, payload: Record<string, unknown>): Promise<MbAck> {
  return new Promise((resolve) => { socket.emit('envelope:mb', payload, (res: MbAck) => resolve(res)); });
}

let R1: Relay;
let R2: Relay;

beforeAll(async () => {
  await initDb();
  R1 = await startRelay('R1');
  R2 = await startRelay('R2');
  // A's identity is registered on R1 only (its home). R2 never sees it.
  await identityRepo.insert({ aegis_id: 'AAA-FEDR-0001', public_key_b64: encodeBase64(nacl.box.keyPair().publicKey), signing_public_key_b64: encodeBase64(nacl.sign.keyPair().publicKey), created_at: Date.now() });
}, 30_000);

afterAll(async () => {
  for (const s of open) s.disconnect();
  await stopRelay(R1);
  await stopRelay(R2);
  await new Promise((resolve) => setTimeout(resolve, 50));
}, 10_000);

describe('federation: A (home R1) delivers to B (home R2) through a disposable mailbox on R2', () => {
  const bMailbox = makeMailbox(7001);

  test('live delivery through R2 with no identity anywhere on the wire', async () => {
    const bSock = await connectMailbox(R2, bMailbox);
    const received = new Promise<Record<string, unknown>>((resolve) => bSock.once('envelope:mb', resolve));

    const disposable = disposableMailbox();
    const aOnR2 = await connectMailbox(R2, disposable); // no registration, no aegisId

    const ack = await sendMb(aOnR2, {
      id: 'fed-msg-1', to: bMailbox.mailboxId,
      ciphertext: encodeBase64(nacl.randomBytes(48)), nonce: encodeBase64(nacl.randomBytes(24)), epk: encodeBase64(nacl.randomBytes(32)),
    });
    expect(ack).toEqual({ ok: true, delivered: true });

    const wire = await received;
    expect(wire['id']).toBe('fed-msg-1');
    expect(wire['to']).toBe(bMailbox.mailboxId);
    // Nothing identifies the sender: no from, no source mailbox, no aegisId.
    expect(wire).not.toHaveProperty('from');
    expect(wire).not.toHaveProperty('mailboxFrom');
    expect(JSON.stringify(wire)).not.toContain(disposable.mailboxId);
    expect(JSON.stringify(wire)).not.toContain('AAA-FEDR-0001');
    bSock.emit('envelope:ack', { id: 'fed-msg-1' });
  });

  test('the same envelope through R1 is only queued: relays never forward to each other', async () => {
    const disposable = disposableMailbox();
    const aOnR1 = await connectMailbox(R1, disposable);
    const ack = await sendMb(aOnR1, {
      id: 'fed-msg-2', to: bMailbox.mailboxId,
      ciphertext: encodeBase64(nacl.randomBytes(48)), nonce: encodeBase64(nacl.randomBytes(24)), epk: encodeBase64(nacl.randomBytes(32)),
    });
    expect(ack.ok).toBe(true);
    expect(ack.delivered).not.toBe(true); // B is bound on R2, not R1
  });

  test('a fresh disposable mailbox per connection: two sends, two ids, both accepted by R2 without registration', async () => {
    const bSock = await connectMailbox(R2, bMailbox);
    const got: string[] = [];
    bSock.on('envelope:mb', (env: { id: string }) => { got.push(env.id); bSock.emit('envelope:ack', { id: env.id }); });

    const d1 = disposableMailbox();
    const d2 = disposableMailbox();
    expect(d1.mailboxId).not.toBe(d2.mailboxId);
    const s1 = await connectMailbox(R2, d1);
    const s2 = await connectMailbox(R2, d2);
    const base = { to: bMailbox.mailboxId, ciphertext: encodeBase64(nacl.randomBytes(48)), nonce: encodeBase64(nacl.randomBytes(24)), epk: encodeBase64(nacl.randomBytes(32)) };
    expect((await sendMb(s1, { ...base, id: 'fed-msg-3' })).delivered).toBe(true);
    expect((await sendMb(s2, { ...base, id: 'fed-msg-4' })).delivered).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(expect.arrayContaining(['fed-msg-3', 'fed-msg-4']));
  });

  test('F4: `wakeHint: call` to an OFFLINE foreign mailbox publishes a call-class (urgent) wake — and the hint never reaches a live recipient', async () => {
    const offline = makeMailbox(7002); // never binds a socket on R2
    const prevFlag = process.env['PUSH_MAILBOX_ENABLED'];
    const prevUrl = process.env['NTFY_URL'];
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    process.env['NTFY_URL'] = 'http://ntfy.test:80';
    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
    try {
      const d = disposableMailbox();
      const aOnR2 = await connectMailbox(R2, d);
      const base = { ciphertext: encodeBase64(nacl.randomBytes(48)), nonce: encodeBase64(nacl.randomBytes(24)), epk: encodeBase64(nacl.randomBytes(32)) };

      // Offline callee: queued + urgent wake on THEIR home relay's ntfy topic.
      const ack = await sendMb(aOnR2, { ...base, id: 'fed-call-1', to: offline.mailboxId, wakeHint: 'call' });
      expect(ack).toEqual({ ok: true, delivered: false, queued: true });
      await new Promise((r) => setTimeout(r, 50));
      const wake = fetchSpy.mock.calls.find((c) => String(c[0]) === `http://ntfy.test:80/${mailboxTopic(offline.mailboxId)}`);
      expect(wake).toBeDefined();
      expect((wake![1] as RequestInit).headers).toMatchObject({ Priority: 'urgent' });
      expect((wake![1] as RequestInit).body).toBe(''); // still nothing readable

      // A plain message to the same offline mailbox stays a message-class wake.
      fetchSpy.mockClear();
      await sendMb(aOnR2, { ...base, id: 'fed-call-2', to: offline.mailboxId });
      await new Promise((r) => setTimeout(r, 50));
      const plain = fetchSpy.mock.calls.find((c) => String(c[0]) === `http://ntfy.test:80/${mailboxTopic(offline.mailboxId)}`);
      expect((plain![1] as RequestInit).headers).toMatchObject({ Priority: 'high' });

      // Live callee: delivered, and the wire it receives carries NO wakeHint.
      const bSock = await connectMailbox(R2, bMailbox);
      const received = new Promise<Record<string, unknown>>((resolve) => bSock.once('envelope:mb', resolve));
      expect((await sendMb(aOnR2, { ...base, id: 'fed-call-3', to: bMailbox.mailboxId, wakeHint: 'call' })).delivered).toBe(true);
      const wire = await received;
      expect(wire).not.toHaveProperty('wakeHint');
      bSock.emit('envelope:ack', { id: 'fed-call-3' });

      // Anything but 'call' is rejected by the schema — no free-form metadata slot.
      expect((await sendMb(aOnR2, { ...base, id: 'fed-call-4', to: bMailbox.mailboxId, wakeHint: 'urgent-please' })).ok).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      if (prevFlag === undefined) delete process.env['PUSH_MAILBOX_ENABLED']; else process.env['PUSH_MAILBOX_ENABLED'] = prevFlag;
      if (prevUrl === undefined) delete process.env['NTFY_URL']; else process.env['NTFY_URL'] = prevUrl;
    }
  });

  test('a disposable mailbox must still PROVE possession: a wrong signature is refused', async () => {
    const d = disposableMailbox();
    const other = nacl.sign.keyPair();
    await expect(new Promise((resolve, reject) => {
      const socket = clientIo(R2.url, {
        auth: { mailboxId: d.mailboxId, mailboxSignPubKey: encodeBase64(d.signKeyPair.publicKey) },
        transports: ['websocket'], reconnection: false,
      });
      open.push(socket);
      socket.on('mailbox:challenge', (c: { nonce: string }) => {
        socket.emit('mailbox:auth:response', { sig: encodeBase64(nacl.sign.detached(decodeBase64(c.nonce), other.secretKey)) });
      });
      socket.on('auth:ok', () => resolve('auth:ok'));
      socket.on('error_msg', (e: { code: string }) => reject(new Error(e.code)));
    })).rejects.toThrow(/auth/);
  });
});
