/**
 * ntfyMailboxPush.relay.test.ts
 *
 * Fase 4 · Slice 2b.1 — server-side wake-up publish on the mailbox path.
 * docs/FASE4-SLICE2B-PUSH-DESIGN.md §5.3, §9 (2b.1).
 *
 * Verifies end-to-end through the real relay that:
 *   - a `mailboxTopic()` unit test (base64 -> base64url, no padding)
 *   - an `envelope:mb` to an OFFLINE mailbox with the flag ON triggers exactly
 *     one ntfy publish to the topic derived from the recipient mailbox id
 *   - an `envelope:mb` delivered to an ONLINE mailbox triggers zero publishes
 *   - with the flag OFF, zero publishes even when the recipient is offline
 *
 * ESM note: the server jest config is ESM (ts-jest/presets/default-esm) and
 * does NOT inject globals — `jest` comes from '@jest/globals'. Module-scope
 * jest.mock() does not hoist under ESM, so instead of mocking '../push/ntfy.js'
 * we let the REAL notifyMailbox() run and spy on global fetch (the same seam
 * ntfy.unit.test.ts uses). Harness mirrors mailboxAuth.relay.test.ts.
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

import { initDb } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';
import { mailboxIdForSignPublicKey } from '../crypto/mailbox.js';
import { mailboxTopic } from '../push/ntfy.js';

const NTFY_URL = 'http://ntfy.test:80';

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

function connectMailbox(keys: MailboxKeys): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(serverUrl, {
      auth: {
        mailboxId: keys.mailboxId,
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
    socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(e.code)); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

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

/** Spy on global fetch; return only the publish calls aimed at our ntfy URL. */
type FetchSpy = ReturnType<typeof jest.spyOn>;
function ntfyCalls(spy: FetchSpy): string[] {
  return spy.mock.calls
    .map((c) => String((c as unknown[])[0]))
    .filter((url) => url.startsWith(NTFY_URL));
}

describe('mailboxTopic()', () => {
  test('converts standard base64 to unpadded base64url', () => {
    // '+', '/' and trailing '=' padding are the three chars ntfy topics reject.
    expect(mailboxTopic('ab+c/de==')).toBe('ab-c_de');
    expect(mailboxTopic('AAAA')).toBe('AAAA');
    expect(mailboxTopic('a+b/c=')).toBe('a-b_c');
    // A real mailbox id stays within the ntfy topic charset.
    const id = mailboxIdForSignPublicKey(makeMailbox(90099).signKeyPair.publicKey);
    expect(mailboxTopic(id)).toMatch(/^[-_A-Za-z0-9]+$/);
  });
});

describe('Slice 2b.1 — mailbox wake-up publish on offline enqueue', () => {
  let fetchSpy: FetchSpy;
  let prevFlag: string | undefined;
  let prevUrl: string | undefined;

  beforeEach(() => {
    prevFlag = process.env['PUSH_MAILBOX_ENABLED'];
    prevUrl = process.env['NTFY_URL'];
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (prevFlag === undefined) delete process.env['PUSH_MAILBOX_ENABLED']; else process.env['PUSH_MAILBOX_ENABLED'] = prevFlag;
    if (prevUrl === undefined) delete process.env['NTFY_URL']; else process.env['NTFY_URL'] = prevUrl;
  });

  test('offline recipient + flag ON -> exactly one publish to topic=mailboxTopic(id)', async () => {
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    process.env['NTFY_URL'] = NTFY_URL;

    const sender = makeMailbox(91001);
    const recipient = makeMailbox(91002); // offline at send time

    const senderSock = await connectMailbox(sender);
    const ack = await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'mb-w1'));
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(true);

    // notifyMailbox is fire-and-forget after enqueue; let the microtask settle.
    await new Promise((r) => setTimeout(r, 100));

    const calls = ntfyCalls(fetchSpy);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(`${NTFY_URL}/${mailboxTopic(recipient.mailboxId)}`);

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('online recipient -> zero publishes (delivered live, never queued)', async () => {
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    process.env['NTFY_URL'] = NTFY_URL;

    const sender = makeMailbox(91011);
    const recipient = makeMailbox(91012);

    const recSock = await connectMailbox(recipient); // ONLINE
    const senderSock = await connectMailbox(sender);
    const ack = await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'mb-w2'));
    expect(ack.delivered).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(ntfyCalls(fetchSpy)).toHaveLength(0);

    senderSock.disconnect();
    recSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('flag OFF -> zero publishes even for an offline recipient', async () => {
    delete process.env['PUSH_MAILBOX_ENABLED'];
    process.env['NTFY_URL'] = NTFY_URL;

    const sender = makeMailbox(91021);
    const recipient = makeMailbox(91022); // offline

    const senderSock = await connectMailbox(sender);
    const ack = await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'mb-w3'));
    expect(ack.queued).toBe(true);

    await new Promise((r) => setTimeout(r, 100));
    expect(ntfyCalls(fetchSpy)).toHaveLength(0);

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});
