/**
 * upEndpointBinding.relay.test.ts
 *
 * Fase 4 · Slice 2b.3b — UnifiedPush endpoint binding on the mailbox path.
 * docs/FASE4-SLICE2B-PUSH-DESIGN.md §9 (2b.3b).
 *
 * Verifies end-to-end through the real relay that:
 *   - isSafeUpEndpoint() rejects SSRF-shaped endpoints (unit)
 *   - `mailbox:push:endpoint` on an AUTHENTICATED socket binds an endpoint,
 *     and a subsequent offline enqueue publishes to the ENDPOINT, not the topic
 *   - a socket cannot bind an endpoint for a mailbox it did not authenticate
 *     (golden rule #3: knowing an id is not owning it)
 *   - endpoint = null unbinds → offline enqueue falls back to the topic publish
 *   - a 410 from the endpoint drops the dead binding (next wake uses the topic)
 *
 * Harness mirrors ntfyMailboxPush.relay.test.ts (real relay, fetch spy seam).
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
import { mailboxTopic, isSafeUpEndpoint } from '../push/ntfy.js';

const NTFY_URL = 'http://ntfy.test:80';
const UP_ENDPOINT = 'https://push.example.org/UP-abcdef123456';

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

type Ack = { ok: boolean; error?: string };
function setEndpoint(socket: ClientSocket, mailboxId: string, endpoint: string | null): Promise<Ack> {
  return new Promise((resolve) => {
    socket.emit('mailbox:push:endpoint', { mailboxId, endpoint }, (res: Ack) => resolve(res));
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

type FetchSpy = ReturnType<typeof jest.spyOn>;
function publishCalls(spy: FetchSpy): string[] {
  return spy.mock.calls.map((c) => String((c as unknown[])[0]));
}

describe('isSafeUpEndpoint()', () => {
  test('accepts a normal https UnifiedPush endpoint', () => {
    expect(isSafeUpEndpoint(UP_ENDPOINT)).toBe(true);
    expect(isSafeUpEndpoint('https://ntfy.example.com:8443/upAbC123?up=1')).toBe(true);
  });
  test('rejects SSRF-shaped endpoints', () => {
    expect(isSafeUpEndpoint('http://push.example.org/up1')).toBe(false); // plain http
    expect(isSafeUpEndpoint('https://localhost/up1')).toBe(false);
    expect(isSafeUpEndpoint('https://relay.localhost/up1')).toBe(false);
    expect(isSafeUpEndpoint('https://127.0.0.1/up1')).toBe(false); // IPv4 literal
    expect(isSafeUpEndpoint('https://[::1]/up1')).toBe(false); // IPv6 literal
    expect(isSafeUpEndpoint('https://intranet/up1')).toBe(false); // single label
    expect(isSafeUpEndpoint('https://db.internal/up1')).toBe(false);
    expect(isSafeUpEndpoint('https://svc.local/up1')).toBe(false);
    expect(isSafeUpEndpoint('https://x.onion/up1')).toBe(false);
    expect(isSafeUpEndpoint('https://user:pw@push.example.org/up1')).toBe(false); // creds
    expect(isSafeUpEndpoint('not-a-url')).toBe(false);
    expect(isSafeUpEndpoint('')).toBe(false);
    expect(isSafeUpEndpoint(`https://push.example.org/${'a'.repeat(600)}`)).toBe(false); // too long
  });
});

describe('Slice 2b.3b — UnifiedPush endpoint binding', () => {
  let fetchSpy: FetchSpy;
  let prevFlag: string | undefined;
  let prevUrl: string | undefined;

  beforeEach(() => {
    prevFlag = process.env['PUSH_MAILBOX_ENABLED'];
    prevUrl = process.env['NTFY_URL'];
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    process.env['NTFY_URL'] = NTFY_URL;
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 200 }));
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    if (prevFlag === undefined) delete process.env['PUSH_MAILBOX_ENABLED']; else process.env['PUSH_MAILBOX_ENABLED'] = prevFlag;
    if (prevUrl === undefined) delete process.env['NTFY_URL']; else process.env['NTFY_URL'] = prevUrl;
  });

  test('bound endpoint -> offline wake goes to the ENDPOINT, not the topic', async () => {
    const sender = makeMailbox(92001);
    const recipient = makeMailbox(92002);

    // Recipient authenticates and binds its endpoint, then goes offline.
    const recSock = await connectMailbox(recipient);
    const bindAck = await setEndpoint(recSock, recipient.mailboxId, UP_ENDPOINT);
    expect(bindAck.ok).toBe(true);
    recSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const senderSock = await connectMailbox(sender);
    const ack = await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'up-w1'));
    expect(ack.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    const calls = publishCalls(fetchSpy);
    expect(calls).toContain(UP_ENDPOINT);
    expect(calls).not.toContain(`${NTFY_URL}/${mailboxTopic(recipient.mailboxId)}`);

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('cannot bind an endpoint for a mailbox the socket did not authenticate', async () => {
    const attacker = makeMailbox(92011);
    const victim = makeMailbox(92012);

    const attackerSock = await connectMailbox(attacker);
    // Attacker KNOWS the victim's mailbox id (it routes envelopes with it) but
    // never proved possession of the victim's signing key.
    const ack = await setEndpoint(attackerSock, victim.mailboxId, 'https://evil.example.org/steal');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('not_authenticated_for_mailbox');

    attackerSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('invalid endpoint is rejected with invalid_endpoint', async () => {
    const keys = makeMailbox(92021);
    const sock = await connectMailbox(keys);
    const ack = await setEndpoint(sock, keys.mailboxId, 'http://127.0.0.1:3001/internal');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid_endpoint');
    sock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('endpoint=null unbinds -> wake falls back to the topic publish', async () => {
    const sender = makeMailbox(92031);
    const recipient = makeMailbox(92032);

    const recSock = await connectMailbox(recipient);
    expect((await setEndpoint(recSock, recipient.mailboxId, UP_ENDPOINT)).ok).toBe(true);
    expect((await setEndpoint(recSock, recipient.mailboxId, null)).ok).toBe(true);
    recSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const senderSock = await connectMailbox(sender);
    await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'up-w2'));
    await new Promise((r) => setTimeout(r, 100));

    const calls = publishCalls(fetchSpy);
    expect(calls).not.toContain(UP_ENDPOINT);
    expect(calls).toContain(`${NTFY_URL}/${mailboxTopic(recipient.mailboxId)}`);

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('410 Gone from the endpoint drops the binding (next wake uses the topic)', async () => {
    const sender = makeMailbox(92041);
    const recipient = makeMailbox(92042);

    const recSock = await connectMailbox(recipient);
    expect((await setEndpoint(recSock, recipient.mailboxId, UP_ENDPOINT)).ok).toBe(true);
    recSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    // First wake: distributor says the registration is gone.
    fetchSpy.mockResolvedValueOnce(new Response(null, { status: 410 }));

    const senderSock = await connectMailbox(sender);
    await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'up-w3'));
    await new Promise((r) => setTimeout(r, 100));
    expect(publishCalls(fetchSpy)).toContain(UP_ENDPOINT);

    // Second wake: binding was dropped -> topic publish.
    fetchSpy.mockClear();
    await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'up-w4'));
    await new Promise((r) => setTimeout(r, 100));
    const calls = publishCalls(fetchSpy);
    expect(calls).not.toContain(UP_ENDPOINT);
    expect(calls).toContain(`${NTFY_URL}/${mailboxTopic(recipient.mailboxId)}`);

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});
