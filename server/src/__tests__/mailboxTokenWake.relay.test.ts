/**
 * mailboxTokenWake.relay.test.ts
 *
 * Fase 4 · Slice 2b.4 — iOS app-killed wake via flag-gated Expo/APNs token
 * binding on the mailbox path. docs/FASE4-SLICE2B-PUSH-DESIGN.md §7.3, §9.
 *
 * Verifies end-to-end through the real relay that:
 *   - isExpoWakeToken() accepts Expo tokens and rejects junk (unit)
 *   - `mailbox:push:token` binds only on an AUTHENTICATED socket for ids it
 *     proved (golden rule #3), and rejects malformed tokens
 *   - with PUSH_MAILBOX_TOKEN_WAKE=on, an offline enqueue for a bound mailbox
 *     POSTs the generic zero-metadata wake to the Expo push API, not the topic
 *   - with the flag OFF, the binding is ignored → topic publish (fail-closed:
 *     the reduct never activates silently)
 *   - DeviceNotRegistered drops the dead binding (next wake → topic)
 *
 * Harness mirrors upEndpointBinding.relay.test.ts (real relay, fetch spy seam).
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
import { mailboxTopic, isExpoWakeToken } from '../push/ntfy.js';

const NTFY_URL = 'http://ntfy.test:80';
const EXPO_API = 'https://exp.host/--/api/v2/push/send';
const TOKEN = 'ExponentPushToken[abc123DEF456]';

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
function setToken(socket: ClientSocket, mailboxId: string, expoToken: string | null): Promise<Ack> {
  return new Promise((resolve) => {
    socket.emit('mailbox:push:token', { mailboxId, expoToken }, (res: Ack) => resolve(res));
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

describe('isExpoWakeToken()', () => {
  test('accepts Expo push token shapes', () => {
    expect(isExpoWakeToken(TOKEN)).toBe(true);
    expect(isExpoWakeToken('ExpoPushToken[xyz-789_A]')).toBe(true);
  });
  test('rejects junk', () => {
    expect(isExpoWakeToken('')).toBe(false);
    expect(isExpoWakeToken('not-a-token')).toBe(false);
    expect(isExpoWakeToken('ExponentPushToken[]')).toBe(false);
    expect(isExpoWakeToken('https://evil.example.org/x')).toBe(false);
    expect(isExpoWakeToken(`ExponentPushToken[${'a'.repeat(200)}]`)).toBe(false);
  });
});

describe('Slice 2b.4 — flag-gated Expo token wake on the mailbox path', () => {
  let fetchSpy: FetchSpy;
  const prevEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ['PUSH_MAILBOX_ENABLED', 'NTFY_URL', 'PUSH_MAILBOX_TOKEN_WAKE']) {
      prevEnv[k] = process.env[k];
    }
    process.env['PUSH_MAILBOX_ENABLED'] = 'on';
    process.env['NTFY_URL'] = NTFY_URL;
    fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ data: { status: 'ok' } }), { status: 200 }),
    );
  });
  afterEach(() => {
    fetchSpy.mockRestore();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  });

  test('flag ON + bound token -> wake POSTs to the Expo API, not the topic', async () => {
    process.env['PUSH_MAILBOX_TOKEN_WAKE'] = 'on';
    const sender = makeMailbox(93001);
    const recipient = makeMailbox(93002);

    const recSock = await connectMailbox(recipient);
    expect((await setToken(recSock, recipient.mailboxId, TOKEN)).ok).toBe(true);
    recSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const senderSock = await connectMailbox(sender);
    const ack = await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'tk-w1'));
    expect(ack.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 100));

    const calls = publishCalls(fetchSpy);
    expect(calls).toContain(EXPO_API);
    expect(calls).not.toContain(`${NTFY_URL}/${mailboxTopic(recipient.mailboxId)}`);
    // R2: the wake body is generic — no mailbox id, no sender, no content.
    const body = String((fetchSpy.mock.calls.find((c) => String((c as unknown[])[0]) === EXPO_API) as unknown[])[1] &&
      ((fetchSpy.mock.calls.find((c) => String((c as unknown[])[0]) === EXPO_API) as unknown[])[1] as { body: string }).body);
    expect(body).toContain(TOKEN);
    expect(body).not.toContain(recipient.mailboxId.slice(0, 8));

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('flag OFF -> binding ignored, wake falls back to the topic (fail-closed)', async () => {
    delete process.env['PUSH_MAILBOX_TOKEN_WAKE'];
    const sender = makeMailbox(93011);
    const recipient = makeMailbox(93012);

    const recSock = await connectMailbox(recipient);
    expect((await setToken(recSock, recipient.mailboxId, TOKEN)).ok).toBe(true);
    recSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    const senderSock = await connectMailbox(sender);
    await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'tk-w2'));
    await new Promise((r) => setTimeout(r, 100));

    const calls = publishCalls(fetchSpy);
    expect(calls).not.toContain(EXPO_API);
    expect(calls).toContain(`${NTFY_URL}/${mailboxTopic(recipient.mailboxId)}`);

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('cannot bind a token for a mailbox the socket did not authenticate', async () => {
    const attacker = makeMailbox(93021);
    const victim = makeMailbox(93022);
    const attackerSock = await connectMailbox(attacker);
    const ack = await setToken(attackerSock, victim.mailboxId, TOKEN);
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('not_authenticated_for_mailbox');
    attackerSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('malformed token rejected with invalid_token', async () => {
    const keys = makeMailbox(93031);
    const sock = await connectMailbox(keys);
    const ack = await setToken(sock, keys.mailboxId, 'https://not-a-token.example.org');
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid_token');
    sock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('DeviceNotRegistered drops the binding (next wake -> topic)', async () => {
    process.env['PUSH_MAILBOX_TOKEN_WAKE'] = 'on';
    const sender = makeMailbox(93041);
    const recipient = makeMailbox(93042);

    const recSock = await connectMailbox(recipient);
    expect((await setToken(recSock, recipient.mailboxId, TOKEN)).ok).toBe(true);
    recSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));

    fetchSpy.mockResolvedValueOnce(new Response(
      JSON.stringify({ data: { status: 'error', details: { error: 'DeviceNotRegistered' } } }),
      { status: 200 },
    ));

    const senderSock = await connectMailbox(sender);
    await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'tk-w3'));
    await new Promise((r) => setTimeout(r, 100));
    expect(publishCalls(fetchSpy)).toContain(EXPO_API);

    fetchSpy.mockClear();
    await sendMb(senderSock, makeMbWire(recipient.mailboxId, 'tk-w4'));
    await new Promise((r) => setTimeout(r, 100));
    const calls = publishCalls(fetchSpy);
    expect(calls).not.toContain(EXPO_API);
    expect(calls).toContain(`${NTFY_URL}/${mailboxTopic(recipient.mailboxId)}`);

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});
