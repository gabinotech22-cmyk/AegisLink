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

import { initDb } from '../db/client.js';
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

function sendMb(socket: ClientSocket, payload: Record<string, unknown>): Promise<{ ok: boolean; delivered?: boolean; error?: string }> {
  return new Promise((resolve) => {
    socket.emit('envelope:mb', payload, (res: { ok: boolean; delivered?: boolean; error?: string }) => resolve(res));
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

  test('reports delivered:false when the recipient mailbox is offline (Slice 1: online only)', async () => {
    const carol = makeMailbox(90011);
    const daveMailboxId = makeMailbox(90012).mailboxId; // never connects

    const carolSock = await connectMailbox(carol);
    const ack = await sendMb(carolSock, makeMbWire(daveMailboxId, 'mb-off'));
    expect(ack.ok).toBe(true);
    expect(ack.delivered).toBe(false);

    carolSock.disconnect();
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
