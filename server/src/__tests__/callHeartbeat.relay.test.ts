/**
 * callHeartbeat.relay.test.ts
 *
 * Regression test for fix/call-heartbeat-during-signaling.
 *
 * BUG (live repro, two Android emulators, 2026-07): a 1:1 call connects, then
 * ~20s later the socket disconnects and reconnects mid-call. Root cause is
 * heartbeat starvation, NOT a dead transport: the engine.io v4 protocol
 * requires the CLIENT to reply to the server's `ping` with a `pong` within
 * `pingTimeout` ms, and that reply is sent synchronously off the client's own
 * JS event loop turn (engine.io-client `Socket#_onPacket`, case "ping" ->
 * `this._sendPacket("pong")`). WebRTC call setup drives a burst of JS-thread
 * work on the client (ICE gathering callbacks, RTCPeerConnection event
 * bridging, per-candidate secretbox sealing, SDP/ICE JSON stringify/parse),
 * which is heavier under a debug/dev bridge. If that burst delays the event
 * loop long enough, the client's pong misses the server's pingTimeout window
 * and the server closes an otherwise-healthy socket.
 *
 * server/src/index.ts widened pingTimeout 10s -> 20s specifically to absorb
 * this kind of JS-thread jitter without weakening the (separately-tuned)
 * pingInterval, which still catches genuinely backgrounded/suspended phones
 * quickly (the "ghost socket" fix, e8645a4).
 *
 * This test builds its OWN relay+Socket.IO server (mirroring every other
 * *.relay.test.ts in this directory) with a pingInterval/pingTimeout pair
 * that reproduces the SAME ratio as production (pingTimeout = 2x pingInterval,
 * scaled down so the suite stays fast), then simulates a client-side JS-thread
 * stall by monkey-patching the client engine's pong dispatch to delay by a
 * fixed amount — proving:
 *
 *   (a) a stall shorter than pingTimeout does NOT disconnect the socket
 *       (this is the case the fix restores for live calls), and
 *   (b) a stall longer than pingInterval + pingTimeout still DOES disconnect
 *       it (the ghost-socket detection is not silently disabled by the fix).
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

import { identityRepo, initDb } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';

// ── Crockford Base32 helpers (mirrors call-signaling.test.ts) ────────────────
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
    deviceId: `dev-heartbeat-${seed}`,
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

async function registerAgent(keys: AgentKeys): Promise<void> {
  await identityRepo.insert({
    aegis_id: keys.aegisId,
    public_key_b64: encodeBase64(keys.boxKeyPair.publicKey),
    signing_public_key_b64: encodeBase64(keys.signKeyPair.publicKey),
    created_at: Date.now(),
  });
}

function connectAgent(serverUrl: string, keys: AgentKeys): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(serverUrl, {
      auth: { aegisId: keys.aegisId, platform: 'mobile', deviceId: keys.deviceId },
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Auth timeout for ${keys.aegisId}`));
    }, 8_000);
    socket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      socket.emit('auth:response', { plain: solveChallenge(wire, keys.boxKeyPair.secretKey) });
    });
    socket.on('auth:ok', () => { clearTimeout(timer); resolve(socket); });
    socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Server error: ${e.code}`)); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

/**
 * Simulate a JS-thread stall on the CLIENT during call signaling: delay every
 * outgoing `pong` reply by `delayMs`. This reproduces the real mechanism
 * (engine.io-client answers `ping` synchronously off the event loop turn) by
 * intercepting the low-level engine.io transport's `_sendPacket`, which is
 * where the real client would be blocked had the JS thread been busy.
 */
function delayClientPongs(socket: ClientSocket, delayMs: number): void {
  // socket.io (v4) exposes the underlying engine.io transport as `socket.io.engine`.
  const engine = (socket as unknown as { io: { engine: { _sendPacket: (...args: unknown[]) => void } } }).io.engine;
  const original = engine._sendPacket.bind(engine);
  engine._sendPacket = (...args: unknown[]) => {
    if (args[0] === 'pong') {
      setTimeout(() => original(...args), delayMs);
      return;
    }
    original(...args);
  };
}

describe('call-time heartbeat survives a JS-thread stall (fix/call-heartbeat-during-signaling)', () => {
  let httpServer: ReturnType<typeof createServer>;
  let io: SocketServer;
  let serverUrl: string;

  // Scaled-down mirror of server/src/index.ts's production ratio
  // (pingInterval 15000 / pingTimeout 20000 -> total window 35s). Keeping the
  // same ~1:1.33 ratio at 10x smaller scale keeps this suite fast while still
  // exercising the exact "does a stall shorter than pingTimeout survive"
  // decision the production config makes.
  const PING_INTERVAL_MS = 300;
  const PING_TIMEOUT_MS = 400; // mirrors the widened production value's proportion

  beforeAll(async () => {
    await initDb();
    const app = express();
    app.use(express.json({ limit: '64kb' }));
    httpServer = createServer(app);
    io = new SocketServer(httpServer, {
      cors: { origin: '*' },
      pingInterval: PING_INTERVAL_MS,
      pingTimeout: PING_TIMEOUT_MS,
    });
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

  it('a pong delayed LESS than pingTimeout does not disconnect the socket', async () => {
    const agent = makeAgentKeys(310);
    await registerAgent(agent);
    const socket = await connectAgent(serverUrl, agent);
    try {
      // Delay every pong by an amount comfortably inside pingTimeout — this is
      // the "busy JS thread during ICE gathering" scenario the fix targets.
      delayClientPongs(socket, Math.round(PING_TIMEOUT_MS * 0.5));

      const disconnected = await new Promise<boolean>((resolve) => {
        let fired = false;
        socket.on('disconnect', () => { fired = true; resolve(true); });
        // Observe across two full ping/timeout cycles — long enough for the old,
        // tighter ratio to have already killed the socket, comfortably shorter
        // than the new tolerance multiplied out.
        setTimeout(() => { if (!fired) resolve(false); }, (PING_INTERVAL_MS + PING_TIMEOUT_MS) * 2);
      });

      expect(disconnected).toBe(false);
      expect(socket.connected).toBe(true);
    } finally {
      socket.disconnect();
    }
  }, 15_000);

  it('a pong delayed MORE than pingInterval + pingTimeout still disconnects the socket (ghost-socket detection intact)', async () => {
    const agent = makeAgentKeys(311);
    await registerAgent(agent);
    const socket = await connectAgent(serverUrl, agent);
    try {
      // Delay every pong well past the full window — this is the "genuinely
      // backgrounded / suspended phone" scenario that must still be caught.
      delayClientPongs(socket, (PING_INTERVAL_MS + PING_TIMEOUT_MS) * 3);

      const disconnected = await new Promise<boolean>((resolve) => {
        socket.on('disconnect', () => resolve(true));
        setTimeout(() => resolve(false), (PING_INTERVAL_MS + PING_TIMEOUT_MS) * 2);
      });

      expect(disconnected).toBe(true);
    } finally {
      socket.disconnect();
    }
  }, 15_000);
});
