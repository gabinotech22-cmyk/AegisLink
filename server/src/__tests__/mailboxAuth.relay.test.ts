/**
 * mailboxAuth.relay.test.ts
 *
 * Integration tests for sealed-sender Fase 4 Slice 1 (mailbox-mode transport,
 * docs/SEALED-SENDER-ARCHITECTURE.md §3.4). Verifies end-to-end through the real
 * relay that:
 *
 *   (a) a socket authenticates as a MAILBOX via an Ed25519 possession proof —
 *       the relay never receives an aegisId
 *   (b) a mailbox-addressed envelope (envelope:mb) is delivered online to the
 *       recipient mailbox with NO sender identity of any kind
 *   (c) a handshake whose mailboxId != SHA256(signPubKey)[0:16] is rejected
 *       (hijack attempt) before any challenge is answered
 *   (d) a wrong possession proof is rejected (auth_failed)
 *
 * Self-contained harness (mirrors sealedSenderV2.relay.test.ts).
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

interface MailboxKeys {
  signKeyPair: nacl.SignKeyPair;
  mailboxId: string;
}
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

/** Connect with a valid mailbox possession proof; resolves the socket on auth:ok. */
function connectMailbox(keys: MailboxKeys, overrideMailboxId?: string): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(serverUrl, {
      auth: {
        mailboxId: overrideMailboxId ?? keys.mailboxId,
        mailboxSignPubKey: encodeBase64(keys.signKeyPair.publicKey),
        platform: 'mobile',
      },
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('mailbox auth timeout')); }, 8_000);
    socket.on('mailbox:challenge', (c: { nonce: string }) => {
      const sig = nacl.sign.detached(decodeBase64(c.nonce), keys.signKeyPair.secretKey);
      socket.emit('mailbox:auth:response', { sig: encodeBase64(sig) });
    });
    socket.on('auth:ok', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Server error: ${e.code}`)); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

interface MbWire { id: string; to: string; ciphertext: string; nonce: string; epk: string; createdAt: number; from?: unknown; mailboxFrom?: unknown }

type MbAck = { ok: boolean; delivered?: boolean; queued?: boolean; error?: string };
function sendMb(socket: ClientSocket, payload: Record<string, unknown>): Promise<MbAck> {
  return new Promise((resolve) => {
    socket.emit('envelope:mb', payload, (res: MbAck) => resolve(res));
  });
}

function makeMbWire(toMailboxId: string, id: string): Record<string, unknown> {
  return {
    id, to: toMailboxId,
    ciphertext: encodeBase64(nacl.randomBytes(48)),
    nonce: encodeBase64(nacl.randomBytes(24)),
    epk: encodeBase64(nacl.randomBytes(32)),
  };
}

describe('sealed-sender Fase 4 — mailbox auth + addressed delivery', () => {
  test('authenticates by possession proof and delivers online with NO sender identity', async () => {
    const alice = makeMailbox(90001);
    const bob = makeMailbox(90002);

    const bobSock = await connectMailbox(bob);
    const received: MbWire[] = [];
    bobSock.on('envelope:mb', (w: MbWire) => received.push(w));

    const aliceSock = await connectMailbox(alice);

    const wire = makeMbWire(bob.mailboxId, 'mb-1');
    const ack = await sendMb(aliceSock, wire);
    expect(ack.ok).toBe(true);
    expect(ack.delivered).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.id).toBe('mb-1');
    expect(got.to).toBe(bob.mailboxId);
    expect(got.epk).toBe(wire.epk);
    // CORE: no sender identity of any kind — not aegisId, not source mailbox.
    expect(got.from).toBeUndefined();
    expect(got.mailboxFrom).toBeUndefined();

    aliceSock.disconnect();
    bobSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('queues for an offline mailbox and drains it on reconnect, no sender (Slice 2)', async () => {
    const sender = makeMailbox(90011);
    const recipient = makeMailbox(90012); // offline at send time

    // Recipient offline → message is queued under the opaque mailbox id.
    const senderSock = await connectMailbox(sender);
    const ack = await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'mb-q1'));
    expect(ack.ok).toBe(true);
    expect(ack.delivered).toBe(false);
    expect(ack.queued).toBe(true);

    // Recipient connects and drains — attach the receive listener BEFORE auth:ok
    // (the drain emits before auth:ok, mirroring the aegisId path).
    const drained: MbWire[] = [];
    const recSock = clientIo(serverUrl, {
      auth: {
        mailboxId: recipient.mailboxId,
        mailboxSignPubKey: encodeBase64(recipient.signKeyPair.publicKey),
        platform: 'mobile',
      },
      transports: ['websocket'], reconnection: false,
    });
    recSock.on('envelope:mb', (w: MbWire) => drained.push(w));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('drain auth timeout')), 8_000);
      recSock.on('mailbox:challenge', (c: { nonce: string }) => {
        recSock.emit('mailbox:auth:response', {
          sig: encodeBase64(nacl.sign.detached(decodeBase64(c.nonce), recipient.signKeyPair.secretKey)),
        });
      });
      recSock.on('auth:ok', () => { clearTimeout(t); setTimeout(resolve, 250); });
      recSock.on('error_msg', (e: { code: string }) => { clearTimeout(t); reject(new Error(e.code)); });
    });

    expect(drained).toHaveLength(1);
    expect(drained[0]!.id).toBe('mb-q1');
    expect(drained[0]!.epk).toBeTruthy();
    expect(drained[0]!.from).toBeUndefined();
    expect(drained[0]!.mailboxFrom).toBeUndefined();

    senderSock.disconnect();
    recSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('an ephemeral mailbox envelope bounds the offline-queue expiry to createdAt+ttl (Slice 5)', async () => {
    const sender = makeMailbox(90041);
    const recipient = makeMailbox(90042); // offline → message is queued

    const senderSock = await connectMailbox(sender);
    const ttl = 60_000; // 1 minute
    const before = Date.now();
    const ack = await sendMb(senderSock, { ...makeMbWire(recipient.mailboxId, 'mb-ttl1'), ephemeralTtl: ttl });
    const after = Date.now();
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(true);

    // drainFor (no deviceId) is non-destructive and surfaces the stored expiry.
    const rows = await messageRepo.drainFor(recipient.mailboxId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    // expires_at MUST be createdAt+ttl, not 0 (which would default to 30-day TTL).
    // createdAt is the relay's send-time stamp → bound by our before/after window.
    expect(row.expires_at).toBeGreaterThanOrEqual(before + ttl);
    expect(row.expires_at).toBeLessThanOrEqual(after + ttl);
    // sanity: nowhere near the 30-day default it would otherwise inherit.
    expect(row.expires_at).toBeLessThan(before + 24 * 60 * 60 * 1000);

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('rejects a handshake whose mailboxId is not bound to the signing key (hijack)', async () => {
    const real = makeMailbox(90021);
    const victimId = makeMailbox(90022).mailboxId; // a different mailbox's id
    // Present the victim's id with our own key → id != SHA256(ourKey).
    await expect(connectMailbox(real, victimId)).rejects.toThrow(/bad_handshake/);
  }, 30_000);

  test('rejects a wrong possession proof (auth_failed)', async () => {
    const keys = makeMailbox(90031);
    await expect(new Promise<ClientSocket>((resolve, reject) => {
      const socket = clientIo(serverUrl, {
        auth: { mailboxId: keys.mailboxId, mailboxSignPubKey: encodeBase64(keys.signKeyPair.publicKey), platform: 'mobile' },
        transports: ['websocket'], reconnection: false,
      });
      const timer = setTimeout(() => { socket.disconnect(); reject(new Error('timeout')); }, 8_000);
      socket.on('mailbox:challenge', () => {
        // Sign random bytes instead of the challenge → invalid proof.
        const badSig = nacl.sign.detached(nacl.randomBytes(32), keys.signKeyPair.secretKey);
        socket.emit('mailbox:auth:response', { sig: encodeBase64(badSig) });
      });
      socket.on('auth:ok', () => { clearTimeout(timer); resolve(socket); });
      socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(e.code)); });
    })).rejects.toThrow(/auth_failed/);
  }, 30_000);
});
