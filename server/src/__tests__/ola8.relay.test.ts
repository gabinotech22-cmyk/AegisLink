/**
 * ola8.relay.test.ts — security roadmap Ola 8 regressions
 *
 *   A-3: an ephemeral (disappearing) message carries `ephemeralTtl`; when the
 *        recipient is offline the relay clamps the queue lifetime to that TTL so
 *        it is purged at its intended expiry instead of the 30-day default.
 *        Control: a message WITHOUT ephemeralTtl survives the same purge.
 *
 *   M-6: a Work `channel:msg` whose body is not E2EE (encrypted !== true or no
 *        nonce) is rejected (`encryption_required`) — the relay never persists a
 *        cleartext channel body.
 *
 * Self-contained harness (mirrors sealedSenderV2.relay.test.ts) so it runs scoped
 * under --runInBand without sharing state with sibling suites.
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

import { identityRepo, initDb, messageRepo } from '../db/client.js';
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
    deviceId: `dev-ola8-${seed}`,
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

function sendChannelMsg(socket: ClientSocket, payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    socket.emit('channel:msg', payload, (res: { ok: boolean; error?: string }) => resolve(res));
  });
}

function v1Wire(to: string, id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    to,
    ciphertext: encodeBase64(nacl.randomBytes(48)),
    nonce: encodeBase64(nacl.randomBytes(24)),
    ...extra,
  };
}

describe('Ola 8 — A-3 ephemeral queue TTL', () => {
  test('ephemeral message is purged from the offline queue at its TTL; a normal one survives', async () => {
    const sender = makeAgentKeys(90001);
    const recipient = makeAgentKeys(90002); // offline at send time
    await registerAgent(sender);
    await registerAgent(recipient);

    const senderSock = await connectAgent(sender);

    // Ephemeral: 1 ms TTL → expires_at ≈ now, purgeable immediately.
    const ephAck = await sendEnvelope(senderSock, v1Wire(recipient.aegisId, 'eph-1', { ephemeralTtl: 1 }));
    expect(ephAck.ok).toBe(true);
    expect(ephAck.queued).toBe(true);

    // Normal: no ephemeralTtl → default 30-day TTL, not purgeable.
    const normAck = await sendEnvelope(senderSock, v1Wire(recipient.aegisId, 'norm-1'));
    expect(normAck.ok).toBe(true);
    expect(normAck.queued).toBe(true);

    // Let the 1 ms ephemeral TTL elapse, then run the purge the cron normally runs.
    await new Promise((r) => setTimeout(r, 25));
    const purged = await messageRepo.purgeExpired();
    expect(purged).toBeGreaterThanOrEqual(1);

    // Recipient comes online and drains: only the normal message remains.
    const drained = await messageRepo.drainFor(recipient.aegisId, recipient.deviceId);
    const ids = drained.map((r) => r.id);
    expect(ids).toContain('norm-1');
    expect(ids).not.toContain('eph-1');

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('rejects an ephemeralTtl above the default message TTL (schema bound)', async () => {
    const sender = makeAgentKeys(90003);
    const recipient = makeAgentKeys(90004);
    await registerAgent(sender);
    await registerAgent(recipient);
    const senderSock = await connectAgent(sender);

    // 1e15 ms ≫ 30-day MESSAGE_TTL_MS → schema rejects the whole envelope.
    const ack = await sendEnvelope(senderSock, v1Wire(recipient.aegisId, 'eph-big', { ephemeralTtl: 1_000_000_000_000_000 }));
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid_envelope');

    senderSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});

describe('Ola 8 — M-6 Work channel encryption required', () => {
  const ORG = '11111111-1111-1111-1111-111111111111';
  const CHAN = '22222222-2222-2222-2222-222222222222';

  test('rejects a channel:msg with a cleartext (unencrypted) body', async () => {
    const sender = makeAgentKeys(90011);
    await registerAgent(sender);
    const sock = await connectAgent(sender);

    // No `encrypted` flag → must be rejected before any persistence.
    const ack = await sendChannelMsg(sock, {
      id: '33333333-3333-3333-3333-333333333333',
      channelId: CHAN,
      orgId: ORG,
      body: 'hello in cleartext',
      type: 'text',
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('encryption_required');

    sock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('rejects a channel:msg marked encrypted but missing the nonce', async () => {
    const sender = makeAgentKeys(90012);
    await registerAgent(sender);
    const sock = await connectAgent(sender);

    const ack = await sendChannelMsg(sock, {
      id: '44444444-4444-4444-4444-444444444444',
      channelId: CHAN,
      orgId: ORG,
      body: encodeBase64(nacl.randomBytes(32)),
      type: 'text',
      encrypted: true,
      // nonce intentionally omitted
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('encryption_required');

    sock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});
