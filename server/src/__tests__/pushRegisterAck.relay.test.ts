/**
 * pushRegisterAck.relay.test.ts
 *
 * Regression for the killed-app iOS wake failure (2026-07-25). `push:register`
 * used to be fire-and-forget: the relay stored the token but sent NO ack, and the
 * client cached the token as "registered" the instant it emitted. A single lost
 * frame or a rate-limited emit therefore left the relay with ZERO push tokens for
 * the identity while the client never retried — so `notifyRecipient` had nothing
 * to send to and a killed iOS app never woke (its aegisId had 0 tokens in the
 * relay, verified in production). The handler now acks AFTER the write resolves
 * (mirroring voip:register) so the client only caches on confirmation and re-tries
 * until then. This proves:
 *   (a) push:register acks {ok:true} and the token is actually persisted;
 *   (b) a malformed payload acks {ok:false} and stores nothing.
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

import { identityRepo, initDb, pushRepo } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';

// ── Crockford Base32 helpers (aegisId shape) ──────────────────────────────────
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

interface AgentKeys { boxKeyPair: nacl.BoxKeyPair; signKeyPair: nacl.SignKeyPair; aegisId: string; deviceId: string }
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
    deviceId: `dev-pra-${seed}`,
  };
}

function solveChallenge(wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }, secretKey: Uint8Array): string {
  const plain = nacl.box.open(decodeBase64(wire.ciphertext), decodeBase64(wire.nonce), decodeBase64(wire.ephemeralPubKey), secretKey);
  if (!plain) throw new Error('Challenge decryption failed');
  return encodeBase64(plain);
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

/** Emit push:register and resolve with the server ack (or a timeout sentinel). */
function registerPush(socket: ClientSocket, payload: Record<string, unknown>): Promise<{ ok?: boolean } | 'no_ack'> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve('no_ack'), 4_000);
    socket.emit('push:register', payload, (res: { ok?: boolean }) => { clearTimeout(t); resolve(res); });
  });
}

describe('push:register acks and persists (audit 2026-07-25)', () => {
  test('valid payload acks ok and the token is stored for the identity', async () => {
    const a = makeAgentKeys(90001);
    await registerAgent(a);
    const sock = await connectAgent(a);

    const token = 'ExponentPushToken[pra-valid-0001]';
    const ack = await registerPush(sock, { token, platform: 'ios' });

    // CORE of the fix: the client MUST receive an ack (was fire-and-forget), and
    // it must be ok only after the write resolved.
    expect(ack).not.toBe('no_ack');
    expect((ack as { ok?: boolean }).ok).toBe(true);

    const rows = await pushRepo.forRecipient(a.aegisId);
    expect(rows.map((r) => r.expo_token)).toContain(token);
    expect(rows.find((r) => r.expo_token === token)?.platform).toBe('ios');

    sock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('malformed payload acks false and stores nothing', async () => {
    const a = makeAgentKeys(90002);
    await registerAgent(a);
    const sock = await connectAgent(a);

    // Missing token → schema rejects → ack false, nothing persisted.
    const ack = await registerPush(sock, { platform: 'ios' });
    expect(ack).not.toBe('no_ack');
    expect((ack as { ok?: boolean }).ok).toBe(false);

    const rows = await pushRepo.forRecipient(a.aegisId);
    expect(rows).toHaveLength(0);

    sock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});
