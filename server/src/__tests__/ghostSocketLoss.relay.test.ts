/**
 * ghostSocketLoss.relay.test.ts — audit 2026-08-08
 *
 * zombieSocket.relay.test.ts covers the DETECTABLE case: a socket still in the
 * map whose `connected` is already false. liveSockets prunes those.
 *
 * This covers the case that cannot be detected at all. iOS tears an app down
 * without closing the TCP connection, so the server-side socket stays
 * `connected === true` until the heartbeat gives up — pingInterval 15s +
 * pingTimeout 20s, so up to ~35 seconds. There is no flag to test: from the
 * relay's point of view the phone is simply there.
 *
 * The aegisId paths used to emit into that window and call it delivery, so the
 * message was neither queued nor pushed, and the sender dropped it from its
 * outbox on `queued:false`. Measured live on 2026-08-08: a message sent to a
 * force-quit iPhone left NO row in the relay queue at all.
 *
 * Fix: enqueue FIRST, unconditionally, then attempt live delivery — the order
 * envelope:mb has used since the 2026-07-24 audit. The row is freed by the
 * recipient's own 'envelope:ack', so a genuinely live delivery costs nothing.
 * These tests pin that the row EXISTS right after a "delivered" send, which is
 * the only thing that survives a phone that was never really there.
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

import { identityRepo, messageRepo, initDb } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';
import { generateDeliveryToken, hashDeliveryToken } from '../crypto/deliveryToken.js';

const BASE32_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function base32Segment(len: number, seed: number): string {
  let s = '';
  let n = seed;
  for (let i = 0; i < len; i++) {
    s += BASE32_ALPHABET[n % 32];
    n = Math.floor(n / 32);
    if (n === 0) n = seed + i + 1;
  }
  return s;
}
function makeAegisId(seed: number): string {
  return `${base32Segment(3, seed)}-${base32Segment(4, seed * 7)}-${base32Segment(4, seed * 13)}`;
}

interface AgentKeys {
  boxKeyPair: nacl.BoxKeyPair;
  signKeyPair: nacl.SignKeyPair;
  aegisId: string;
  deviceId: string;
}
function makeAgentKeys(seed: number): AgentKeys {
  const aegisId = makeAegisId(seed);
  const seedBytes = new Uint8Array(32);
  const view = new DataView(seedBytes.buffer);
  view.setUint32(0, seed, false);
  view.setUint32(4, seed * 31337, false);
  return {
    boxKeyPair: nacl.box.keyPair.fromSecretKey(seedBytes),
    signKeyPair: nacl.sign.keyPair.fromSeed(seedBytes),
    aegisId,
    deviceId: `dev-ghost-${seed}`,
  };
}

function solveChallenge(
  wire: { ephemeralPubKey: string; nonce: string; ciphertext: string },
  secretKey: Uint8Array,
): string {
  const plain = nacl.box.open(
    decodeBase64(wire.ciphertext),
    decodeBase64(wire.nonce),
    decodeBase64(wire.ephemeralPubKey),
    secretKey,
  );
  if (!plain) throw new Error('Challenge decryption failed');
  return encodeBase64(plain);
}

let httpServer: ReturnType<typeof createServer>;
let io: SocketServer;
let serverUrl: string;

beforeAll(async () => {
  await initDb();
  const app = express();
  app.use(express.json({ limit: '64kb' }));
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

async function registerAgent(keys: AgentKeys): Promise<void> {
  await identityRepo.insert({
    aegis_id: keys.aegisId,
    public_key_b64: encodeBase64(keys.boxKeyPair.publicKey),
    signing_public_key_b64: encodeBase64(keys.signKeyPair.publicKey),
    created_at: Date.now(),
  });
}

function connectAgent(keys: AgentKeys): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(serverUrl, {
      auth: { aegisId: keys.aegisId, platform: 'mobile', deviceId: keys.deviceId, ackDelivery: true },
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error(`Auth timeout for ${keys.aegisId}`)); }, 8_000);
    socket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      socket.emit('auth:response', { plain: solveChallenge(wire, keys.boxKeyPair.secretKey) });
    });
    socket.on('auth:ok', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Server error: ${e.code}`)); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

function send(
  socket: ClientSocket,
  event: 'envelope' | 'envelope:v2',
  payload: Record<string, unknown>,
): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  return new Promise((resolve) => {
    socket.emit(event, payload, (res: { ok: boolean; queued?: boolean; error?: string }) => resolve(res));
  });
}

function baseWire(to: string, id: string): Record<string, unknown> {
  return {
    id,
    to,
    ciphertext: encodeBase64(nacl.randomBytes(48)),
    nonce: encodeBase64(nacl.randomBytes(24)),
  };
}

async function queuedIds(recipient: string): Promise<string[]> {
  // No deviceId → the raw queue contents, regardless of who has drained what.
  return (await messageRepo.drainFor(recipient)).map((r) => r.id);
}

describe('ghost socket — a live-looking socket must not swallow the message', () => {
  test('envelope (v1) is queued even when the recipient looks connected', async () => {
    const alice = makeAgentKeys(91001);
    const bob = makeAgentKeys(91002);
    await registerAgent(alice);
    await registerAgent(bob);

    const bobSock = await connectAgent(bob);
    const aliceSock = await connectAgent(alice);

    const received: unknown[] = [];
    bobSock.on('envelope', (w: unknown) => received.push(w));

    const ack = await send(aliceSock, 'envelope', baseWire(bob.aegisId, 'ghost-v1'));
    expect(ack.ok).toBe(true);
    // Bob really is live here, so the ack still reports a live delivery — the
    // sender-facing contract does not change.
    expect(ack.queued).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1); // live emit still happens

    // ...and the durable copy exists anyway. This is the whole fix: had Bob's
    // phone actually been gone, the message would still be recoverable.
    expect(await queuedIds(bob.aegisId)).toContain('ghost-v1');

    bobSock.disconnect();
    aliceSock.disconnect();
  }, 15_000);

  test('envelope:v2 (sealed sender) is queued even when the recipient looks connected', async () => {
    const alice = makeAgentKeys(91003);
    const bob = makeAgentKeys(91004);
    await registerAgent(alice);
    await registerAgent(bob);

    const bobSock = await connectAgent(bob);
    const aliceSock = await connectAgent(alice);

    const received: unknown[] = [];
    bobSock.on('envelope:v2', (w: unknown) => received.push(w));

    // Sealed-sender's anti-abuse gate: Bob registers only the HASH of his
    // delivery token; Alice must present the raw token to send to him.
    const rawToken = generateDeliveryToken();
    await new Promise<void>((resolve, reject) => {
      bobSock.emit(
        'deliveryToken:register',
        { tokenHashB64: hashDeliveryToken(rawToken) },
        (res: { ok: boolean; error?: string }) => (res.ok ? resolve() : reject(new Error(res.error ?? 'register failed'))),
      );
    });

    const wire = {
      ...baseWire(bob.aegisId, 'ghost-v2'),
      epk: encodeBase64(nacl.randomBytes(32)),
      deliveryToken: rawToken,
    };
    const ack = await send(aliceSock, 'envelope:v2', wire);
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(false);

    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(1);

    const queued = await queuedIds(bob.aegisId);
    expect(queued).toContain('ghost-v2');

    bobSock.disconnect();
    aliceSock.disconnect();
  }, 15_000);

  test("the recipient's ack frees the row, so a healthy delivery leaves nothing behind", async () => {
    const alice = makeAgentKeys(91005);
    const bob = makeAgentKeys(91006);
    await registerAgent(alice);
    await registerAgent(bob);

    const bobSock = await connectAgent(bob);
    const aliceSock = await connectAgent(alice);

    // Mirror the real client: ack once the envelope has been persisted.
    const acked = new Promise<void>((resolve) => {
      bobSock.on('envelope', (w: { id: string }) => {
        bobSock.emit('envelope:ack', { id: w.id });
        setTimeout(resolve, 150);
      });
    });

    await send(aliceSock, 'envelope', baseWire(bob.aegisId, 'ghost-acked'));
    await acked;

    expect(await queuedIds(bob.aegisId)).not.toContain('ghost-acked');

    bobSock.disconnect();
    aliceSock.disconnect();
  }, 15_000);
});
