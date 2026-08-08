/**
 * pushWhenUnconfirmed.relay.test.ts — audit 2026-08-08
 *
 * "Las notificaciones de grupo con la app minimizada o muerta no llegan."
 *
 * notifyRecipient fired only when the relay ALREADY believed the recipient was
 * offline. But iOS tears an app down without closing its TCP connection, so for
 * up to ~35s (pingInterval 15s + pingTimeout 20s) a killed or backgrounded phone
 * still looks connected. The message was emitted into nothing and no push was
 * sent: #423 made it survive in the queue, but it arrived silently, discoverable
 * only by opening the app. Group messages fan out as ordinary 1:1 envelopes, so
 * they land on exactly this path.
 *
 * The ack is the only honest signal that a device is really there — a queued row
 * is deleted when the recipient confirms it. So a row still queued a few seconds
 * after a supposedly live delivery means nobody got it: wake them for real.
 *
 * Pinned here:
 *   - live socket that never acks  → push fires (the ghost)
 *   - live socket that acks        → NO push (healthy delivery stays silent, so
 *                                    the push provider learns nothing about
 *                                    normal conversation frequency)
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

const mockNotifyRecipient = jest.fn(async () => undefined);
jest.mock('../push/expo.js', () => ({
  __esModule: true,
  notifyRecipient: (...args: unknown[]) => mockNotifyRecipient(...(args as [])),
  sendCallWakeUp: jest.fn(async () => undefined),
  sendGroupCallWakeUp: jest.fn(async () => undefined),
}));

import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

import { identityRepo, initDb } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';

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
    deviceId: `dev-push-${seed}`,
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

beforeEach(() => {
  mockNotifyRecipient.mockClear();
  jest.useRealTimers();
});

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

function sendEnvelope(socket: ClientSocket, to: string, id: string): Promise<{ ok: boolean; queued?: boolean }> {
  return new Promise((resolve) => {
    socket.emit(
      'envelope',
      {
        id,
        to,
        ciphertext: encodeBase64(nacl.randomBytes(48)),
        nonce: encodeBase64(nacl.randomBytes(24)),
      },
      (res: { ok: boolean; queued?: boolean }) => resolve(res),
    );
  });
}

// The handler's own fallback window is 8s; give it a little room.
const WAIT_PAST_FALLBACK_MS = 9_500;

describe('push wake-up when a "live" delivery is never confirmed', () => {
  test('a socket that looks connected but never acks still triggers the push', async () => {
    const alice = makeAgentKeys(93001);
    const bob = makeAgentKeys(93002);
    await registerAgent(alice);
    await registerAgent(bob);

    // Bob connects and stays registered, but never acks anything — exactly what
    // a force-quit iPhone looks like before the heartbeat notices.
    const bobSock = await connectAgent(bob);
    const aliceSock = await connectAgent(alice);

    const ack = await sendEnvelope(aliceSock, bob.aegisId, 'ghost-push-1');
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(false); // relay believed it delivered live

    expect(mockNotifyRecipient).not.toHaveBeenCalled(); // nothing yet — it waits

    await new Promise((r) => setTimeout(r, WAIT_PAST_FALLBACK_MS));
    expect(mockNotifyRecipient).toHaveBeenCalledWith(bob.aegisId);

    bobSock.disconnect();
    aliceSock.disconnect();
  }, 30_000);

  test('a recipient that acks is NOT pushed — a healthy delivery stays silent', async () => {
    const alice = makeAgentKeys(93003);
    const bob = makeAgentKeys(93004);
    await registerAgent(alice);
    await registerAgent(bob);

    const bobSock = await connectAgent(bob);
    const aliceSock = await connectAgent(alice);

    // A real client acks as soon as it has persisted the envelope.
    bobSock.on('envelope', (w: { id: string }) => bobSock.emit('envelope:ack', { id: w.id }));

    await sendEnvelope(aliceSock, bob.aegisId, 'healthy-push-1');
    await new Promise((r) => setTimeout(r, WAIT_PAST_FALLBACK_MS));

    // No push at all: the ack proved the device was really there, so the push
    // provider never learns this conversation happened.
    expect(mockNotifyRecipient).not.toHaveBeenCalled();

    bobSock.disconnect();
    aliceSock.disconnect();
  }, 30_000);

  test('an offline recipient is still pushed immediately, as before', async () => {
    const alice = makeAgentKeys(93005);
    const bob = makeAgentKeys(93006);
    await registerAgent(alice);
    await registerAgent(bob);

    const aliceSock = await connectAgent(alice); // bob never connects

    const ack = await sendEnvelope(aliceSock, bob.aegisId, 'offline-push-1');
    expect(ack.queued).toBe(true);
    // Immediate, not deferred — the offline path must not get slower.
    await new Promise((r) => setTimeout(r, 200));
    expect(mockNotifyRecipient).toHaveBeenCalledWith(bob.aegisId);

    aliceSock.disconnect();
  }, 20_000);
});
