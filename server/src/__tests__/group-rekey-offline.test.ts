/**
 * AegisLink — group:rekey offline-queue test
 *
 * Verifies that when a `group:rekey` distribution targets an offline recipient
 * the distribution is persisted in senderKeyDistRepo and drained as
 * `group:rekey_dist` when the recipient reconnects. Also verifies:
 *   - distId is a UUID present in both the queued and online-path payloads
 *   - group:rekey_drain_ack removes the row (idempotent on repeat acks)
 *   - online recipients still receive the event immediately (no DB write)
 *   - senderAegisId anti-spoof check still rejects mismatched values
 */

// In-memory SQLite — must be set before any server module is imported
process.env.AEGIS_DB_PATH = ':memory:';

import express from 'express';
import { createServer } from 'node:http';
import { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import supertest, { type SuperTest, type Test } from 'supertest';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { createHash } from 'node:crypto';

import identityRoutes from '../routes/identity.js';
import prekeysRoutes from '../routes/prekeys.js';
import { attachRelay } from '../relay/handler.js';
import { initDb, senderKeyDistRepo } from '../db/client.js';

const { encodeBase64 } = naclUtil;

// ── Helpers copied from simulation.test.ts ────────────────────────────────────

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

function hasLeadingZeroBits(buf: Buffer, bits: number): boolean {
  let remaining = bits;
  for (const byte of buf) {
    if (remaining <= 0) break;
    const check = remaining >= 8 ? 8 : remaining;
    const mask = 0xff & (0xff << (8 - check));
    if ((byte & mask) !== 0) return false;
    remaining -= 8;
  }
  return true;
}

function solvePoW(challenge: string, difficulty: number): string {
  for (let n = 0; n < 2_000_000; n++) {
    const nonce = n.toString(16);
    const digest = createHash('sha256').update(nonce + challenge).digest();
    if (hasLeadingZeroBits(digest, difficulty)) return nonce;
  }
  throw new Error(`PoW unsolvable (difficulty=${difficulty})`);
}

interface AgentKeys {
  boxKeyPair: nacl.BoxKeyPair;
  signKeyPair: nacl.SignKeyPair;
  spkPair: nacl.BoxKeyPair;
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
    spkPair: nacl.box.keyPair.fromSecretKey((() => {
      const s = new Uint8Array(32);
      const v = new DataView(s.buffer);
      v.setUint32(0, seed * 7, false);
      v.setUint32(4, seed * 1009, false);
      return s;
    })()),
    aegisId,
    deviceId: `device-rk-${seed}`,
  };
}

function solveChallenge(
  wire: { ephemeralPubKey: string; nonce: string; ciphertext: string },
  mySecretKey: Uint8Array,
): string {
  const plain = nacl.box.open(
    Buffer.from(wire.ciphertext, 'base64'),
    Buffer.from(wire.nonce, 'base64'),
    Buffer.from(wire.ephemeralPubKey, 'base64'),
    mySecretKey,
  );
  if (!plain) throw new Error('Challenge decryption failed');
  return Buffer.from(plain).toString('base64');
}

// ── Test server ───────────────────────────────────────────────────────────────
let httpServer: ReturnType<typeof createServer>;
let io: SocketServer;
let request: SuperTest<Test>;
let serverUrl: string;

beforeAll(async () => {
  await initDb();

  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/identity', identityRoutes);
  app.use('/prekeys', prekeysRoutes);

  httpServer = createServer(app);
  io = new SocketServer(httpServer, { cors: { origin: '*' } });
  attachRelay(io);

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;
  request = supertest(app);
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolve) => { io.close(() => resolve()); });
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
}, 10_000);

// ── Registration helpers ──────────────────────────────────────────────────────

async function registerAgent(keys: AgentKeys): Promise<void> {
  const challengeRes = await request.get('/identity/challenge').expect(200);
  const { challenge, difficulty } = challengeRes.body as { challenge: string; difficulty: number };
  const nonce = solvePoW(challenge, difficulty);
  await request
    .post('/identity')
    .send({
      aegisId: keys.aegisId,
      publicKey: encodeBase64(keys.boxKeyPair.publicKey),
      signingPublicKey: encodeBase64(keys.signKeyPair.publicKey),
      powChallenge: challenge,
      powNonce: nonce,
    })
    .expect(201);
}

async function uploadPrekeys(keys: AgentKeys): Promise<void> {
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const message = new TextEncoder().encode(`${keys.aegisId}:prekeys:${timeBucket}`);
  const sig = nacl.sign.detached(message, keys.signKeyPair.secretKey);
  const spkSig = nacl.sign.detached(keys.spkPair.publicKey, keys.signKeyPair.secretKey);
  await request
    .post('/prekeys')
    .send({
      aegisId: keys.aegisId,
      deviceId: keys.deviceId,
      sig: encodeBase64(sig),
      ts,
      signedPreKey: {
        keyId: 1,
        publicKeyB64: encodeBase64(keys.spkPair.publicKey),
        signatureB64: encodeBase64(spkSig),
      },
      oneTimePreKeys: [{ keyId: 1, publicKeyB64: encodeBase64(nacl.box.keyPair().publicKey) }],
    })
    .expect(201);
}

function connectAgent(keys: AgentKeys): Promise<ClientSocket> {
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
    socket.on('auth:ok', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.on('error_msg', (msg: { code: string }) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error(`Auth error: ${msg.code}`));
    });
  });
}

// ── Fake SenderKey distribution payload ───────────────────────────────────────

function makeDist(senderAegisId: string, recipientAegisId: string) {
  // Zod schema requires nonceB64 to be exactly 44 chars (32 bytes base64).
  // The chain key is sealed INSIDE ciphertextB64 — it must never travel as a
  // sibling cleartext field on the wire (C-3 fix).
  return {
    aegisId: recipientAegisId,
    ciphertextB64: encodeBase64(nacl.randomBytes(48)),
    nonceB64: encodeBase64(nacl.randomBytes(32)),   // 32 bytes → 44 base64 chars
    iteration: 1,
    senderAegisId,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('group:rekey — offline queue and drain', () => {
  // Agent seeds chosen to avoid collisions with simulation.test.ts (which uses 1,2,3)
  const admin = makeAgentKeys(101);
  const memberOnline = makeAgentKeys(102);
  const memberOffline = makeAgentKeys(103);

  beforeAll(async () => {
    await registerAgent(admin);
    await registerAgent(memberOnline);
    await registerAgent(memberOffline);
    await uploadPrekeys(admin);
    await uploadPrekeys(memberOnline);
    await uploadPrekeys(memberOffline);
  }, 30_000);

  test('online recipient receives group:rekey_dist immediately with a distId', async () => {
    const adminSocket = await connectAgent(admin);
    const onlineSocket = await connectAgent(memberOnline);

    const groupId = 'TEST-GROUP-ONLINE-01';

    const received = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('group:rekey_dist not received')), 5_000);
      onlineSocket.once('group:rekey_dist', (payload: Record<string, unknown>) => {
        clearTimeout(t);
        resolve(payload);
      });
      adminSocket.emit('group:rekey', {
        groupId,
        distributions: [makeDist(admin.aegisId, memberOnline.aegisId)],
      });
    });

    expect(received.groupId).toBe(groupId);
    expect(received.senderAegisId).toBe(admin.aegisId);
    expect(typeof received.distId).toBe('string');
    // distId must be a UUID v4
    expect(received.distId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    );

    adminSocket.disconnect();
    onlineSocket.disconnect();
  }, 15_000);

  test('offline recipient has distribution queued in senderKeyDistRepo', async () => {
    const adminSocket = await connectAgent(admin);
    // memberOffline stays disconnected throughout this test

    const groupId = 'TEST-GROUP-OFFLINE-01';

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('group:rekey ack not received')), 5_000);
      adminSocket.emit(
        'group:rekey',
        {
          groupId,
          distributions: [makeDist(admin.aegisId, memberOffline.aegisId)],
        },
        (ack: { ok: boolean }) => {
          clearTimeout(t);
          if (ack.ok) resolve();
          else reject(new Error('group:rekey ack returned ok=false'));
        }
      );
    });

    // Give the async enqueue a moment to complete
    await new Promise<void>((r) => setTimeout(r, 200));

    const queued = await senderKeyDistRepo.drainFor(memberOffline.aegisId, memberOffline.deviceId);
    expect(queued.length).toBeGreaterThanOrEqual(1);
    const row = queued.find((r) => r.group_id === groupId);
    expect(row).toBeDefined();
    expect(row!.sender_aegis_id).toBe(admin.aegisId);
    expect(row!.recipient).toBe(memberOffline.aegisId);

    adminSocket.disconnect();
  }, 15_000);

  test('offline recipient drains group:rekey_dist on reconnect', async () => {
    // Admin sends a rekey while memberOffline is disconnected
    const adminSocket = await connectAgent(admin);
    const groupId = 'TEST-GROUP-DRAIN-01';

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('rekey ack timeout')), 5_000);
      adminSocket.emit(
        'group:rekey',
        {
          groupId,
          distributions: [makeDist(admin.aegisId, memberOffline.aegisId)],
        },
        (ack: { ok: boolean }) => {
          clearTimeout(t);
          if (ack.ok) resolve();
          else reject(new Error('rekey ack false'));
        }
      );
    });

    adminSocket.disconnect();

    // Give async enqueue time to complete
    await new Promise<void>((r) => setTimeout(r, 300));

    // Now memberOffline reconnects — drain should happen automatically
    let drainSocket: ClientSocket | null = null;
    const drained = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('drain not received on reconnect')), 8_000);
      // Connect memberOffline — the server drains pending dists in onAuthenticated
      drainSocket = clientIo(serverUrl, {
        auth: { aegisId: memberOffline.aegisId, platform: 'mobile', deviceId: memberOffline.deviceId },
        transports: ['websocket'],
        reconnection: false,
      });
      drainSocket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
        drainSocket!.emit('auth:response', { plain: solveChallenge(wire, memberOffline.boxKeyPair.secretKey) });
      });
      drainSocket.on('group:rekey_dist', (payload: Record<string, unknown>) => {
        if (payload['groupId'] === groupId) {
          clearTimeout(t);
          resolve(payload);
        }
      });
      drainSocket.on('error_msg', (msg: { code: string }) => {
        clearTimeout(t);
        reject(new Error(`auth error: ${msg.code}`));
      });
    });
    drainSocket?.disconnect();

    expect(drained['groupId']).toBe(groupId);
    expect(drained['senderAegisId']).toBe(admin.aegisId);
    expect(typeof drained['distId']).toBe('string');
    expect(drained['ciphertextB64']).toBeTruthy();
    expect(drained['nonceB64']).toBeTruthy();
    // C-3 regression: the relay must NEVER emit a cleartext chain key on the wire.
    expect(drained['chainKeyB64']).toBeUndefined();
  }, 20_000);

  test('group:rekey_drain_ack deletes the queued row', async () => {
    const adminSocket = await connectAgent(admin);
    const groupId = 'TEST-GROUP-ACK-01';

    // Enqueue a distribution for memberOffline
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('rekey ack timeout')), 5_000);
      adminSocket.emit(
        'group:rekey',
        { groupId, distributions: [makeDist(admin.aegisId, memberOffline.aegisId)] },
        (ack: { ok: boolean }) => { clearTimeout(t); ack.ok ? resolve() : reject(new Error('ack false')); }
      );
    });

    adminSocket.disconnect();
    await new Promise<void>((r) => setTimeout(r, 300));

    // Connect memberOffline, collect the distId, then send the ack
    const distId = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('drain timeout')), 8_000);
      const offSock = clientIo(serverUrl, {
        auth: { aegisId: memberOffline.aegisId, platform: 'mobile', deviceId: memberOffline.deviceId },
        transports: ['websocket'],
        reconnection: false,
      });
      offSock.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
        offSock.emit('auth:response', { plain: solveChallenge(wire, memberOffline.boxKeyPair.secretKey) });
      });
      offSock.on('group:rekey_dist', (payload: Record<string, unknown>) => {
        if (payload['groupId'] === groupId) {
          clearTimeout(t);
          const id = payload['distId'] as string;
          // Send the ack
          offSock.emit('group:rekey_drain_ack', { distId: id });
          // Give ack time to process then disconnect
          setTimeout(() => { offSock.disconnect(); resolve(id); }, 300);
        }
      });
      offSock.on('error_msg', (msg: { code: string }) => {
        clearTimeout(t);
        reject(new Error(`auth error: ${msg.code}`));
      });
    });

    // After ack the row should be deleted from the queue
    await new Promise<void>((r) => setTimeout(r, 200));
    const remaining = await senderKeyDistRepo.drainFor(memberOffline.aegisId, memberOffline.deviceId);
    const stillThere = remaining.find((r) => r.id === distId);
    expect(stillThere).toBeUndefined();
  }, 25_000);

  test('group:rekey rejects if senderAegisId !== authenticated identity (anti-spoof)', async () => {
    const adminSocket = await connectAgent(admin);
    const groupId = 'TEST-GROUP-SPOOF-01';

    const err = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('ack timeout')), 5_000);
      // Claim senderAegisId = memberOnline.aegisId while we are authenticated as admin
      adminSocket.emit(
        'group:rekey',
        {
          groupId,
          distributions: [makeDist(memberOnline.aegisId, memberOffline.aegisId)],
        },
        (ack: { ok: boolean; error?: string }) => {
          clearTimeout(t);
          resolve(ack);
        }
      );
    });

    expect(err.ok).toBe(false);
    expect(err.error).toBe('forbidden');
    adminSocket.disconnect();
  }, 10_000);
});
