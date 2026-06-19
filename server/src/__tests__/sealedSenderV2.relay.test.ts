/**
 * sealedSenderV2.relay.test.ts
 *
 * Integration tests for the sealed-sender v2 transport (Phase 1,
 * docs/SEALED-SENDER-ARCHITECTURE.md §3). Verifies end-to-end through the real
 * relay that:
 *
 *   (a) deliveryToken:register stores the recipient's token hash (ack ok)
 *   (b) envelope:v2 with a VALID delivery token is delivered online to the
 *       recipient with NO `from` and NO `senderPublicKeyB64` — the relay never
 *       stamps a sender identity (the core Phase 1 property)
 *   (c) envelope:v2 with a WRONG/absent token is rejected (bad_delivery_token)
 *       and never reaches the recipient
 *   (d) envelope:v2 to an OFFLINE recipient is queued and drained on reconnect
 *       on the v2 channel with the ephemeral key (epk) intact and still no `from`
 *
 * Self-contained harness (mirrors call-signaling.test.ts) so it can run scoped
 * with --runInBand without sharing state with sibling suites.
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
import { generateDeliveryToken, hashDeliveryToken } from '../crypto/deliveryToken.js';

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
    deviceId: `dev-ssv2-${seed}`,
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

function registerToken(socket: ClientSocket, tokenHashB64: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    socket.emit('deliveryToken:register', { tokenHashB64 }, (res: { ok: boolean; error?: string }) => resolve(res));
  });
}

interface V2Wire { id: string; to: string; ciphertext: string; nonce: string; epk: string; createdAt: number; from?: unknown; senderPublicKeyB64?: unknown }

function sendV2(socket: ClientSocket, payload: Record<string, unknown>): Promise<{ ok: boolean; queued?: boolean; error?: string }> {
  return new Promise((resolve) => {
    socket.emit('envelope:v2', payload, (res: { ok: boolean; queued?: boolean; error?: string }) => resolve(res));
  });
}

/** Build a syntactically-valid opaque v2 wire (relay treats body as opaque). */
function makeWire(to: string, deliveryToken: string, id: string): Record<string, unknown> {
  return {
    id,
    to,
    ciphertext: encodeBase64(nacl.randomBytes(48)),
    nonce: encodeBase64(nacl.randomBytes(24)),
    epk: encodeBase64(nacl.randomBytes(32)),
    deliveryToken,
  };
}

describe('sealed-sender v2 relay transport', () => {
  test('registers token, delivers online with NO from, rejects bad token', async () => {
    const alice = makeAgentKeys(80001); // sender
    const bob = makeAgentKeys(80002);   // recipient
    await registerAgent(alice);
    await registerAgent(bob);

    const rawToken = generateDeliveryToken();
    const tokenHash = hashDeliveryToken(rawToken);

    const bobSock = await connectAgent(bob);
    const received: V2Wire[] = [];
    bobSock.on('envelope:v2', (w: V2Wire) => received.push(w));

    // (a) Bob registers his token hash
    const reg = await registerToken(bobSock, tokenHash);
    expect(reg.ok).toBe(true);

    const aliceSock = await connectAgent(alice);

    // (b) Alice sends with the valid token → delivered online
    const wire = makeWire(bob.aegisId, rawToken, 'm-1');
    const ack = await sendV2(aliceSock, wire);
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(false);

    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(1);
    const got = received[0]!;
    expect(got.id).toBe('m-1');
    expect(got.to).toBe(bob.aegisId);
    expect(got.epk).toBe(wire.epk);
    // CORE PROPERTY: relay never stamps a sender identity on v2.
    expect(got.from).toBeUndefined();
    expect(got.senderPublicKeyB64).toBeUndefined();

    // (c) Wrong token → rejected, nothing delivered
    const badAck = await sendV2(aliceSock, makeWire(bob.aegisId, 'not-the-token', 'm-2'));
    expect(badAck.ok).toBe(false);
    expect(badAck.error).toBe('bad_delivery_token');
    await new Promise((r) => setTimeout(r, 150));
    expect(received).toHaveLength(1); // still just m-1

    aliceSock.disconnect();
    bobSock.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);

  test('queues for offline recipient and drains on v2 channel with epk, no from', async () => {
    const carol = makeAgentKeys(80011); // sender
    const dave = makeAgentKeys(80012);  // recipient (stays offline at send time)
    await registerAgent(carol);
    await registerAgent(dave);

    const rawToken = generateDeliveryToken();
    const tokenHash = hashDeliveryToken(rawToken);

    // Dave connects once to register his token, then disconnects (goes offline).
    const daveSock1 = await connectAgent(dave);
    expect((await registerToken(daveSock1, tokenHash)).ok).toBe(true);
    daveSock1.disconnect();
    await new Promise((r) => setTimeout(r, 100));

    // Carol sends while Dave is offline → queued.
    const carolSock = await connectAgent(carol);
    const wire = makeWire(dave.aegisId, rawToken, 'm-off-1');
    const ack = await sendV2(carolSock, wire);
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(true);

    // Dave reconnects and drains — must arrive on envelope:v2 with epk and no from.
    const drained: V2Wire[] = [];
    const daveSock2 = clientIo(serverUrl, {
      auth: { aegisId: dave.aegisId, platform: 'mobile', deviceId: dave.deviceId },
      transports: ['websocket'], reconnection: false,
    });
    daveSock2.on('envelope:v2', (w: V2Wire) => drained.push(w));
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('drain auth timeout')), 8_000);
      daveSock2.on('auth:challenge', (cw: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
        daveSock2.emit('auth:response', { plain: solveChallenge(cw, dave.boxKeyPair.secretKey) });
      });
      daveSock2.on('auth:ok', () => { clearTimeout(t); setTimeout(resolve, 300); });
    });

    expect(drained).toHaveLength(1);
    const got = drained[0]!;
    expect(got.id).toBe('m-off-1');
    expect(got.epk).toBe(wire.epk);
    expect(got.from).toBeUndefined();
    expect(got.senderPublicKeyB64).toBeUndefined();

    carolSock.disconnect();
    daveSock2.disconnect();
    await new Promise((r) => setTimeout(r, 50));
  }, 30_000);
});
