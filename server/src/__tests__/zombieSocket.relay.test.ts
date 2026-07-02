/**
 * zombieSocket.relay.test.ts
 *
 * Regression test for the zombie-socket delivery bug: after a relay restart
 * (or any transport-level death that hasn't fired the `disconnect` event yet),
 * a recipient's registered socket can be `connected === false` while still
 * present in the `sockets` / `mailboxSockets` maps. The old `deliver()` /
 * inline delivery checks only tested `Set.size > 0`, so a zombie socket made
 * the relay believe the message was delivered live — it emitted into a dead
 * transport and NEVER queued the message. Silent, permanent message loss.
 *
 * Fix: `deliver()` (and the `envelope:v2` / `envelope:mb` live-delivery
 * branches) now filter to `s.connected` sockets before deciding "delivered",
 * and prune dead entries from the map as a side effect (self-healing).
 *
 * This test verifies the fix directly against `attachRelay`'s real Socket.IO
 * server, using a real authenticated recipient connection whose *server-side*
 * socket is then monkey-patched to `connected = false` (simulating the zombie
 * state) without going through an actual TCP disconnect — reproducing exactly
 * the race the bug report describes.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer, type Socket as ServerSocket } from 'socket.io';
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
    deviceId: `dev-zombie-${seed}`,
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
      auth: { aegisId: keys.aegisId, platform: 'mobile', deviceId: keys.deviceId },
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

function sendEnvelope(socket: ClientSocket, payload: Record<string, unknown>): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  return new Promise((resolve) => {
    socket.emit('envelope', payload, (res: { ok: boolean; queued?: boolean; error?: string }) => resolve(res));
  });
}

function makeWire(to: string, id: string): Record<string, unknown> {
  return {
    id,
    to,
    ciphertext: encodeBase64(nacl.randomBytes(48)),
    nonce: encodeBase64(nacl.randomBytes(24)),
  };
}

describe('zombie-socket delivery regression', () => {
  test('a registered but disconnected (zombie) recipient socket does NOT swallow the message — it gets queued', async () => {
    const alice = makeAgentKeys(90001); // sender
    const bob = makeAgentKeys(90002);   // recipient
    await registerAgent(alice);
    await registerAgent(bob);

    const bobSock = await connectAgent(bob);
    const aliceSock = await connectAgent(alice);

    // Find bob's server-side socket instance and simulate the zombie state:
    // transport already dead but the map entry (and `connected` getter) not
    // yet updated to reflect it (the exact race after a relay restart).
    const bobServerSocket = [...io.sockets.sockets.values()].find(
      (s: ServerSocket) => s.handshake.auth && (s.handshake.auth as { aegisId?: string }).aegisId === bob.aegisId,
    );
    expect(bobServerSocket).toBeDefined();
    Object.defineProperty(bobServerSocket, 'connected', { value: false, configurable: true });

    const received: unknown[] = [];
    bobSock.on('envelope', (w: unknown) => received.push(w));

    const wire = makeWire(bob.aegisId, 'zombie-msg-1');
    const ack = await sendEnvelope(aliceSock, wire);

    // Must be queued, NOT declared delivered — the old code returned
    // `delivered=true` here because `recipientSockets.size > 0`, discarding
    // the message forever (never emitted, never persisted).
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(true);

    // Nothing was emitted into the dead transport.
    await new Promise((r) => setTimeout(r, 100));
    expect(received).toHaveLength(0);

    bobSock.disconnect();
    aliceSock.disconnect();
  }, 15_000);
});
