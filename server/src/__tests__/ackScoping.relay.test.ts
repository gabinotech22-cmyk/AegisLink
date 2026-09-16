/**
 * ackScoping.relay.test.ts
 *
 * Regression for external audit 2026-09-16 AL-06: `envelope:ack` and
 * `group:rekey_drain_ack` used to call `repo.delete(id)` with no recipient
 * check, so ANY authenticated socket could delete ANY queued row (message or
 * SenderKey distribution) just by knowing its id — ids are client-chosen and
 * travel in delivery/receipt protocols. Acks now go through `repo.ack(id,
 * recipients)` and touch a row only if it belongs to an identity/mailbox the
 * acking socket authenticated as.
 *
 * Proves, with a real relay and two identities A and B:
 *   (a) A acking a message id queued FOR B is a no-op — B's row survives;
 *   (b) B acking its own id deletes it (the legitimate path still works);
 *   (c) the same pair for SenderKey distributions;
 *   (d) a mailbox socket acking an id queued for a mailbox it did NOT bind is a
 *       no-op (repo-level, same code path as the socket handler).
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

import { identityRepo, initDb, messageRepo, senderKeyDistRepo } from '../db/client.js';
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

interface AgentKeys { boxKeyPair: nacl.BoxKeyPair; signKeyPair: nacl.SignKeyPair; aegisId: string; deviceId: string }
function makeAgentKeys(seed: number): AgentKeys {
  const seedBytes = new Uint8Array(32);
  const view = new DataView(seedBytes.buffer);
  view.setUint32(0, seed, false);
  view.setUint32(4, seed * 31337, false);
  return {
    boxKeyPair: nacl.box.keyPair.fromSecretKey(seedBytes),
    signKeyPair: nacl.sign.keyPair.fromSeed(seedBytes),
    aegisId: makeAegisId(seed),
    deviceId: `dev-ack-${seed}`,
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
const open: ClientSocket[] = [];

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
  for (const s of open) s.disconnect();
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
    open.push(socket);
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error(`Auth timeout for ${keys.aegisId}`)); }, 8_000);
    socket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      socket.emit('auth:response', { plain: solveChallenge(wire, keys.boxKeyPair.secretKey) });
    });
    const onErr = (e: { code: string }) => { clearTimeout(timer); socket.disconnect(); reject(new Error(e.code)); };
    socket.on('error_msg', onErr);
    socket.on('auth:ok', () => { clearTimeout(timer); socket.off('error_msg', onErr); resolve(socket); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}

/** Give the relay time to process a fire-and-forget emit. */
const settle = () => new Promise((r) => setTimeout(r, 150));

async function queueMessageFor(recipient: string, id: string): Promise<void> {
  const r = await messageRepo.enqueue({
    id, recipient, ciphertext_b64: 'Y3Q=', nonce_b64: 'bm9uY2U=', created_at: Date.now(), expires_at: 0,
    sender_pub_b64: null, epk_b64: null,
  });
  expect(r.ok).toBe(true);
}

async function queueDistFor(recipient: string, id: string): Promise<void> {
  const r = await senderKeyDistRepo.enqueue({
    id, recipient, group_id: 'g-ack', sender_aegis_id: 'X', ciphertext_b64: 'Y3Q=', nonce_b64: 'bm9uY2U=',
    iteration: 0, created_at: Date.now(), expires_at: 0,
  });
  expect(r.ok).toBe(true);
}

describe('ack scoping (audit 2026-09-16 AL-06)', () => {
  const A = makeAgentKeys(9201);
  const B = makeAgentKeys(9202);
  let a: ClientSocket;
  let b: ClientSocket;

  beforeAll(async () => {
    await registerAgent(A);
    await registerAgent(B);
    // Connect BEFORE queuing so the connect-time drain finds nothing to hand out.
    a = await connectAgent(A);
    b = await connectAgent(B);
  }, 20_000);

  test("A acking B's message id is a no-op; B acking it deletes it", async () => {
    const id = '11111111-aaaa-4bbb-8ccc-000000000001';
    await queueMessageFor(B.aegisId, id);
    expect(await messageRepo.isStillQueued(id)).toBe(true);

    a.emit('envelope:ack', { id });
    await settle();
    expect(await messageRepo.isStillQueued(id)).toBe(true);

    b.emit('envelope:ack', { id });
    await settle();
    expect(await messageRepo.isStillQueued(id)).toBe(false);
  });

  test("A acking B's SenderKey distribution is a no-op; B acking it deletes it", async () => {
    const id = '22222222-aaaa-4bbb-8ccc-000000000002';
    await queueDistFor(B.aegisId, id);
    const before = await senderKeyDistRepo.drainFor(B.aegisId, 'probe-1');
    expect(before.map((r) => r.id)).toContain(id);

    a.emit('group:rekey_drain_ack', { distId: id });
    await settle();
    const afterA = await senderKeyDistRepo.drainFor(B.aegisId, 'probe-2');
    expect(afterA.map((r) => r.id)).toContain(id);

    b.emit('group:rekey_drain_ack', { distId: id });
    await settle();
    const afterB = await senderKeyDistRepo.drainFor(B.aegisId, 'probe-3');
    expect(afterB.map((r) => r.id)).not.toContain(id);
  });

  test('repo.ack ignores a row outside the bound recipient set (mailbox path)', async () => {
    const id = '33333333-aaaa-4bbb-8ccc-000000000003';
    await queueMessageFor('mailbox-of-someone-else', id);
    await messageRepo.ack(id, ['mailbox-mine', 'mailbox-mine-epoch-2']);
    expect(await messageRepo.isStillQueued(id)).toBe(true);
    await messageRepo.ack(id, ['mailbox-of-someone-else']);
    expect(await messageRepo.isStillQueued(id)).toBe(false);
  });

  test('repo.ack with an empty recipient set never touches anything', async () => {
    const id = '44444444-aaaa-4bbb-8ccc-000000000004';
    await queueMessageFor(B.aegisId, id);
    await messageRepo.ack(id, []);
    expect(await messageRepo.isStillQueued(id)).toBe(true);
  });
});
