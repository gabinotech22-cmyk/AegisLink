/**
 * atLeastOnceDelivery.relay.test.ts
 *
 * Regression for the at-least-once delivery fix (security audit 2026-07-24). The
 * relay used to `messageRepo.delete()` a queued mailbox message the instant it
 * emitted it during a drain. Over Tor an emit is routinely lost mid-drain, so the
 * message was deleted but never received — the root cause of "some messages never
 * arrive / no drenan". The relay now deletes ONLY when the client confirms receipt
 * via 'envelope:ack'. This proves:
 *   (a) a drained message stays queued until the client acks, then is deleted;
 *   (b) an un-acked message re-drains on reconnect (no loss on a dropped delivery).
 *
 * Self-contained harness (mirrors mailboxAuth.relay.test.ts).
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

import { initDb, messageRepo } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';
import { mailboxIdForSignPublicKey } from '../crypto/mailbox.js';

interface MailboxKeys { signKeyPair: nacl.SignKeyPair; mailboxId: string }
function makeMailbox(seed: number): MailboxKeys {
  const seedBytes = new Uint8Array(32);
  new DataView(seedBytes.buffer).setUint32(0, seed, false);
  const signKeyPair = nacl.sign.keyPair.fromSeed(seedBytes);
  return { signKeyPair, mailboxId: mailboxIdForSignPublicKey(signKeyPair.publicKey) };
}

let httpServer: ReturnType<typeof createServer>;
let io: SocketServer;
let serverUrl: string;

beforeAll(async () => {
  await initDb();
  const app = express();
  httpServer = createServer(app);
  io = new SocketServer(httpServer, { cors: { origin: '*' } });
  attachRelay(io);
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  io.disconnectSockets(true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => { io.close(() => resolve()); });
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
  await new Promise((resolve) => setTimeout(resolve, 50));
}, 10_000);

interface MbConn { socket: ClientSocket; received: { id: string }[] }

/**
 * Connect + authenticate a mailbox. The 'envelope:mb' collector is attached at
 * socket-creation time (BEFORE auth:ok), because the relay drains the offline
 * queue and emits those envelopes just before auth:ok — exactly like the real
 * client (mailboxSocket.ts registers its handler before auth). Resolves once the
 * queue has been drained (auth:ok).
 */
function connectMailbox(keys: MailboxKeys, ackCapable = true): Promise<MbConn> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(serverUrl, {
      auth: {
        mailboxId: keys.mailboxId,
        mailboxSignPubKey: encodeBase64(keys.signKeyPair.publicKey),
        platform: 'mobile',
        // New clients advertise this so the relay defers deletion to the ack.
        // Legacy clients omit it → relay keeps delete-on-emit (backward compat).
        ...(ackCapable ? { ackDelivery: true } : {}),
      },
      transports: ['websocket'],
      reconnection: false,
    });
    const received: { id: string }[] = [];
    socket.on('envelope:mb', (w: { id: string }) => received.push(w));
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('mailbox auth timeout')); }, 8_000);
    socket.on('mailbox:challenge', (c: { nonce: string }) => {
      const sig = nacl.sign.detached(decodeBase64(c.nonce), keys.signKeyPair.secretKey);
      socket.emit('mailbox:auth:response', { sig: encodeBase64(sig) });
    });
    socket.on('auth:ok', () => { clearTimeout(timer); resolve({ socket, received }); });
    socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Server error: ${e.code}`)); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

async function enqueueFor(mailboxId: string, id: string): Promise<void> {
  const r = await messageRepo.enqueue({
    id,
    recipient: mailboxId,
    ciphertext_b64: encodeBase64(nacl.randomBytes(48)),
    nonce_b64: encodeBase64(nacl.randomBytes(24)),
    created_at: Date.now(),
    expires_at: 0,
    sender_pub_b64: null,
    epk_b64: encodeBase64(nacl.randomBytes(32)),
  });
  if (!r.ok) throw new Error('enqueue failed: ' + (r.reason ?? '?'));
}

async function queuedIds(mailboxId: string): Promise<string[]> {
  return (await messageRepo.drainFor(mailboxId)).map((r) => r.id);
}

describe('at-least-once mailbox delivery (audit 2026-07-24)', () => {
  test('keeps a drained message queued until the client acks, then deletes it', async () => {
    const box = makeMailbox(70001);
    await enqueueFor(box.mailboxId, 'alo-1');
    expect(await queuedIds(box.mailboxId)).toContain('alo-1');

    const { socket, received } = await connectMailbox(box);
    expect(received.map((w) => w.id)).toContain('alo-1');

    // CORE: the emit must NOT have deleted the row — it survives a lost delivery.
    await new Promise((r) => setTimeout(r, 120));
    expect(await queuedIds(box.mailboxId)).toContain('alo-1');

    // Client confirms receipt → now (and only now) the relay deletes it.
    socket.emit('envelope:ack', { id: 'alo-1' });
    await new Promise((r) => setTimeout(r, 200));
    expect(await queuedIds(box.mailboxId)).toHaveLength(0);

    socket.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('re-drains an un-acked message on reconnect (no loss on a dropped delivery)', async () => {
    const box = makeMailbox(70002);
    await enqueueFor(box.mailboxId, 'alo-2');

    const c1 = await connectMailbox(box);
    expect(c1.received.map((w) => w.id)).toContain('alo-2');
    // Deliberately do NOT ack — simulate a lost emit / crash before persist.
    c1.socket.disconnect();
    await new Promise((r) => setTimeout(r, 120));

    // The message must still be queued (was never acked).
    expect(await queuedIds(box.mailboxId)).toContain('alo-2');

    // Reconnect → the relay re-drains it instead of having lost it.
    const c2 = await connectMailbox(box);
    expect(c2.received.map((w) => w.id)).toContain('alo-2');
    c2.socket.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('legacy client (no ackDelivery) keeps delete-on-emit — no backlog storm', async () => {
    const box = makeMailbox(70003);
    await enqueueFor(box.mailboxId, 'alo-3');

    // Connect WITHOUT advertising the ackDelivery capability (an old client).
    const { socket, received } = await connectMailbox(box, false);
    expect(received.map((w) => w.id)).toContain('alo-3');

    // Backward-compat: the relay must have deleted on emit (legacy at-most-once),
    // so the queue drains and the old client never re-downloads the backlog.
    await new Promise((r) => setTimeout(r, 150));
    expect(await queuedIds(box.mailboxId)).toHaveLength(0);

    socket.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});
