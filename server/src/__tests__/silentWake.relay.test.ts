/**
 * silentWake.relay.test.ts — phantom notifications (2026-09-20).
 *
 * Every envelope queued for an offline recipient used to raise the generic
 * visible push — including typing indicators, read receipts, profile updates
 * and other protocol traffic that renders nothing, so the user opened the app
 * to nothing. The SENDER now marks such envelopes `wakeHint: 'silent'`: the
 * relay queues them exactly as before but never pushes. Ordinary envelopes
 * (no hint) still push. Same harness as pushWhenUnconfirmed.relay.test.ts.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import { jest } from '@jest/globals';
import { Expo } from 'expo-server-sdk';
import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

import { identityRepo, pushRepo, messageRepo, initDb } from '../db/client.js';
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

afterEach(() => {
  // Restore AFTER assertions — mockRestore clears spy.mock.calls.
  jest.restoreAllMocks();
});

/**
 * Spy on the Expo SDK rather than mocking ../push/expo.js: the server package is
 * native ESM, where `jest.mock` does not hoist and `jest` is not a global. This
 * is the pattern the other push suites use (notifyRecipientPayload.test.ts), and
 * it exercises the real notifyRecipient path end to end instead of a stub.
 */
function spyOnPush(): jest.SpiedFunction<typeof Expo.prototype.sendPushNotificationsAsync> {
  return jest.spyOn(Expo.prototype, 'sendPushNotificationsAsync').mockResolvedValue([]);
}

async function registerAgent(keys: AgentKeys): Promise<void> {
  await identityRepo.insert({
    aegis_id: keys.aegisId,
    public_key_b64: encodeBase64(keys.boxKeyPair.publicKey),
    signing_public_key_b64: encodeBase64(keys.signKeyPair.publicKey),
    created_at: Date.now(),
  });
  // notifyRecipient is a no-op without a token, so every recipient here needs
  // one for "was a push attempted?" to mean anything.
  await pushRepo.upsert({
    aegis_id: keys.aegisId,
    expo_token: `ExponentPushToken[${keys.deviceId}]`,
    platform: 'ios',
    updated_at: Date.now(),
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

function sendEnvelope(socket: ClientSocket, to: string, id: string, extra: Record<string, unknown> = {}): Promise<{ ok: boolean; queued?: boolean }> {
  return new Promise((resolve) => {
    socket.emit(
      'envelope',
      {
        id,
        to,
        ciphertext: encodeBase64(nacl.randomBytes(48)),
        nonce: encodeBase64(nacl.randomBytes(24)),
        ...extra,
      },
      (res: { ok: boolean; queued?: boolean }) => resolve(res),
    );
  });
}

describe('wakeHint: silent — protocol traffic never raises a push', () => {
  test('a silent envelope to an offline recipient is queued but NOT pushed', async () => {
    const alice = makeAgentKeys(94001);
    const bob = makeAgentKeys(94002);
    await registerAgent(alice);
    await registerAgent(bob);
    const aliceSock = await connectAgent(alice); // bob offline
    const spy = spyOnPush();

    const ack = await sendEnvelope(aliceSock, bob.aegisId, 'silent-1', { wakeHint: 'silent' });
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(true);
    await new Promise((r) => setTimeout(r, 500));
    expect(spy).not.toHaveBeenCalled();

    // The queued envelope is still there for bob to drain.
    const queued = await messageRepo.drainFor(bob.aegisId);
    expect(queued.some((m) => m.id === 'silent-1')).toBe(true);

    aliceSock.disconnect();
  }, 20_000);

  test('an ordinary envelope (no hint) still pushes', async () => {
    const alice = makeAgentKeys(94003);
    const bob = makeAgentKeys(94004);
    await registerAgent(alice);
    await registerAgent(bob);
    const aliceSock = await connectAgent(alice);
    const spy = spyOnPush();
    await sendEnvelope(aliceSock, bob.aegisId, 'loud-1');
    await new Promise((r) => setTimeout(r, 500));
    expect(spy).toHaveBeenCalledTimes(1);
    aliceSock.disconnect();
  }, 20_000);

  test('an unknown hint value is rejected by the schema', async () => {
    const alice = makeAgentKeys(94005);
    const bob = makeAgentKeys(94006);
    await registerAgent(alice);
    await registerAgent(bob);
    const aliceSock = await connectAgent(alice);
    const ack = await sendEnvelope(aliceSock, bob.aegisId, 'bad-1', { wakeHint: 'loud' });
    expect(ack.ok).toBe(false);
    aliceSock.disconnect();
  }, 20_000);
});
