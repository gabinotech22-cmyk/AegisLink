/**
 * callZombieSocket.relay.test.ts
 *
 * Regression for the audit delta 2026-07-03 finding: PR #209's zombie-socket
 * fix (`liveSockets`) covered the messaging paths (deliver / envelope:v2 /
 * envelope:mb) but NOT call signaling. `callSignaling.ts`'s forwardSealed()
 * still gated delivery on `Set.size`, so a zombie recipient socket (transport
 * dead, `disconnect` not fired yet — the exact race after a relay restart)
 * made `call:invite:v2` report delivered and SKIP the offline push wake-up:
 * the callee never rings. Silent call loss.
 *
 * Fix: forwardSealed()/fwdSealed()/group_call:* all route through the shared
 * `liveSockets()` helper. With a zombie callee, call:invite:v2 must fall into
 * the offline path (push wake-up); with no push token registered in the test
 * env, that surfaces as a `peer_offline` error_msg back to the caller — which
 * is the observable proof the invite did NOT get silently swallowed.
 *
 * Mirrors zombieSocket.relay.test.ts: real attachRelay Socket.IO server, real
 * authenticated recipient, server-side socket monkey-patched to
 * connected = false.
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
    deviceId: `dev-call-zombie-${seed}`,
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
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

describe('call-signaling zombie-socket regression (audit delta 2026-07-03)', () => {
  test('call:invite:v2 to a zombie callee falls back to offline path, not silent-delivered', async () => {
    const alice = makeAgentKeys(91001); // caller
    const bob = makeAgentKeys(91002);   // callee
    await registerAgent(alice);
    await registerAgent(bob);

    const bobSock = await connectAgent(bob);
    const aliceSock = await connectAgent(alice);

    // Zombie state: bob's server socket transport is dead but the map entry
    // (and `connected` getter) hasn't updated — the post-restart race.
    const bobServerSocket = [...io.sockets.sockets.values()].find(
      (s: ServerSocket) => s.handshake.auth && (s.handshake.auth as { aegisId?: string }).aegisId === bob.aegisId,
    );
    expect(bobServerSocket).toBeDefined();
    Object.defineProperty(bobServerSocket, 'connected', { value: false, configurable: true });

    // Bob's live client must NOT receive the invite (it went into a dead transport
    // in the buggy code); Alice must be told the peer is offline (push wake-up
    // failed → no token in test env), proving the invite was not swallowed.
    const bobInvites: unknown[] = [];
    bobSock.on('call:invite:v2', (w: unknown) => bobInvites.push(w));

    const offline = new Promise<string>((resolve) => {
      aliceSock.on('error_msg', (e: { code: string; for?: string }) => {
        if (e.for === 'call:invite') resolve(e.code);
      });
    });

    aliceSock.emit('call:invite:v2', {
      to: bob.aegisId,
      callId: 'call-zombie-1',
      media: 'audio',
      epk: encodeBase64(nacl.randomBytes(32)),
      ciphertext: encodeBase64(nacl.randomBytes(48)),
      nonce: encodeBase64(nacl.randomBytes(24)),
    });

    const code = await Promise.race([
      offline,
      new Promise<string>((resolve) => setTimeout(() => resolve('__timeout__'), 3000)),
    ]);

    expect(code).toBe('peer_offline');
    expect(bobInvites).toHaveLength(0);

    bobSock.disconnect();
    aliceSock.disconnect();
  }, 20_000);
});
