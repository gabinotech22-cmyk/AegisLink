/**
 * callSignalingV2.relay.test.ts
 *
 * Integration tests for sealed-sender v2 CALL signaling (Phase 2,
 * docs/SEALED-SENDER-ARCHITECTURE.md §5, Fase 2). Verifies end-to-end through the
 * real relay that:
 *
 *   (a) call:invite:v2 is delivered online to the callee with NO `from` — the
 *       relay never stamps a caller identity (the core Phase 2 property). The
 *       per-call ephemeral key (epk) survives verbatim.
 *   (b) call:answer:v2 and call:ice:v2 are forwarded with NO `from`.
 *   (c) call:invite:v2 to an OFFLINE callee is queued and drained on reconnect on
 *       the v2 channel, still with epk and still no `from`; buffered v2 ICE drains
 *       after it.
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

import { identityRepo, pushRepo, initDb } from '../db/client.js';
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
    deviceId: `dev-callv2-${seed}`,
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

function once<T>(socket: ClientSocket, event: string, timeoutMs = 4000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
    socket.once(event, (data: T) => { clearTimeout(timer); resolve(data); });
  });
}

/**
 * Connect an agent while buffering drained call:* events that arrive DURING the
 * reconnect/auth handshake. The relay drains a queued invite (and trickle ICE)
 * inside onAuthenticated, i.e. right after auth:ok — a listener attached only
 * after connectAgent() resolves would miss it. Listeners are attached up-front;
 * resolves a short window after auth:ok so the drain has flushed.
 */
function connectAndCollect(
  keys: AgentKeys,
  windowMs = 400,
): Promise<{ socket: ClientSocket; invites: Record<string, unknown>[]; ices: Record<string, unknown>[] }> {
  return new Promise((resolve, reject) => {
    const invites: Record<string, unknown>[] = [];
    const ices: Record<string, unknown>[] = [];
    const socket = clientIo(serverUrl, {
      auth: { aegisId: keys.aegisId, platform: 'mobile', deviceId: keys.deviceId },
      transports: ['websocket'],
      reconnection: false,
    });
    socket.on('call:invite:v2', (d: Record<string, unknown>) => invites.push(d));
    socket.on('call:ice:v2', (d: Record<string, unknown>) => ices.push(d));
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error(`Auth timeout for ${keys.aegisId}`)); }, 8_000);
    socket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      socket.emit('auth:response', { plain: solveChallenge(wire, keys.boxKeyPair.secretKey) });
    });
    socket.on('auth:ok', () => { clearTimeout(timer); setTimeout(() => resolve({ socket, invites, ices }), windowMs); });
    socket.on('error_msg', (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(`Server error: ${e.code}`)); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

function sealedInviteWire(to: string, callId: string) {
  return {
    to,
    callId,
    media: 'audio' as const,
    ciphertext: encodeBase64(nacl.randomBytes(64)),
    nonce: encodeBase64(nacl.randomBytes(24)),
    epk: encodeBase64(nacl.randomBytes(32)),
  };
}

describe('sealed-sender v2 call signaling (relay)', () => {
  let caller: AgentKeys;
  let callee: AgentKeys;
  let seed = 7001;
  beforeAll(async () => {
    caller = makeAgentKeys(seed++);
    callee = makeAgentKeys(seed++);
    await registerAgent(caller);
    await registerAgent(callee);
  });

  test('call:invite:v2 reaches the callee online with NO from and epk intact', async () => {
    const callerSock = await connectAgent(caller);
    const calleeSock = await connectAgent(callee);
    try {
      const wire = sealedInviteWire(callee.aegisId, 'call-online-1');
      const received = once<Record<string, unknown>>(calleeSock, 'call:invite:v2');
      callerSock.emit('call:invite:v2', wire);
      const got = await received;
      expect(got.from).toBeUndefined();
      expect(got.callId).toBe('call-online-1');
      expect(got.epk).toBe(wire.epk);
      expect(got.ciphertext).toBe(wire.ciphertext);
      expect((got as { to?: unknown }).to).toBeUndefined();
    } finally {
      callerSock.disconnect();
      calleeSock.disconnect();
    }
  });

  test('call:answer:v2 and call:ice:v2 forward with NO from', async () => {
    const callerSock = await connectAgent(caller);
    const calleeSock = await connectAgent(callee);
    try {
      const answer = { to: caller.aegisId, callId: 'c2', ciphertext: encodeBase64(nacl.randomBytes(40)), nonce: encodeBase64(nacl.randomBytes(24)) };
      const gotAnswer = once<Record<string, unknown>>(callerSock, 'call:answer:v2');
      calleeSock.emit('call:answer:v2', answer);
      const a = await gotAnswer;
      expect(a.from).toBeUndefined();
      expect(a.callId).toBe('c2');

      const ice = { to: callee.aegisId, callId: 'c2', ciphertext: encodeBase64(nacl.randomBytes(40)), nonce: encodeBase64(nacl.randomBytes(24)) };
      const gotIce = once<Record<string, unknown>>(calleeSock, 'call:ice:v2');
      callerSock.emit('call:ice:v2', ice);
      const i = await gotIce;
      expect(i.from).toBeUndefined();
      expect(i.ciphertext).toBe(ice.ciphertext);
    } finally {
      callerSock.disconnect();
      calleeSock.disconnect();
    }
  });

  test('offline call:invite:v2 is queued and drained on reconnect (epk intact, no from)', async () => {
    // Register a push token for the offline callee so sendCallWakeUp (mocked in
    // jest.config.cjs) returns true and the relay does NOT cancel the queued
    // invite before the callee reconnects. Without this the invite is dropped as
    // peer_offline (no push target) — same pattern as the v1 call-signaling test.
    await pushRepo.upsert({
      aegis_id: callee.aegisId,
      expo_token: 'ExponentPushToken[ssv2-offline-callee]',
      platform: 'android',
      updated_at: Date.now(),
    });

    const callerSock = await connectAgent(caller);
    try {
      // Callee is offline. Send invite + a trickle ICE candidate.
      const wire = sealedInviteWire(callee.aegisId, 'call-offline-1');
      callerSock.emit('call:invite:v2', wire);
      const ice = { to: callee.aegisId, callId: 'call-offline-1', ciphertext: encodeBase64(nacl.randomBytes(40)), nonce: encodeBase64(nacl.randomBytes(24)) };
      callerSock.emit('call:ice:v2', ice);
      // Give the relay a tick to queue.
      await new Promise((r) => setTimeout(r, 100));

      // Callee comes online → drains the invite then the buffered ICE. Listeners
      // are attached before auth:ok so the drain (emitted inside onAuthenticated)
      // is not missed.
      const { socket: calleeSock, invites, ices } = await connectAndCollect(callee);
      try {
        expect(invites).toHaveLength(1);
        const drainedInvite = invites[0]!;
        expect(drainedInvite.from).toBeUndefined();
        expect(drainedInvite.callId).toBe('call-offline-1');
        expect(drainedInvite.epk).toBe(wire.epk);
        expect(ices).toHaveLength(1);
        expect(ices[0]!.from).toBeUndefined();
        expect(ices[0]!.ciphertext).toBe(ice.ciphertext);
      } finally {
        calleeSock.disconnect();
      }
    } finally {
      callerSock.disconnect();
    }
  });
});
