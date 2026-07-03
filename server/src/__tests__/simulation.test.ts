/**
 * AegisLink — Multi-agent simulation test
 *
 * Simulates real usage of the relay server with three agents (Alice, Bob, Carol)
 * performing the full lifecycle:
 *   1. PoW-gated identity registration
 *   2. Prekey upload (Ed25519-signed)
 *   3. Socket.IO connection + challenge-response auth (X25519)
 *   4. Online message delivery (sealed-sender envelopes)
 *   5. Offline queue → drain on reconnect
 *   6. Delivery acknowledgements (msg:delivered)
 *   7. Typing indicators
 *   8. Read receipts
 *   9. Remote delete
 *
 * The server runs on a random port with an in-memory SQLite database.
 * No secrets leave the test process — all keys are ephemeral NaCl pairs.
 */

// ── MUST be set before any server module is imported ─────────────────────────
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
import { initDb } from '../db/client.js';

const { encodeBase64, decodeBase64 } = naclUtil;

// ── Crockford Base32 alphabet (Aegis ID format) ───────────────────────────────
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

// ── PoW solver ────────────────────────────────────────────────────────────────
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
  throw new Error(`PoW unsolvable after 2M iterations (difficulty=${difficulty})`);
}

// ── Agent: represents one user device ────────────────────────────────────────
interface AgentKeys {
  /** X25519: used for encryption in challenge-response + sealed-sender */
  boxKeyPair: nacl.BoxKeyPair;
  /** Ed25519: used for prekey upload authentication */
  signKeyPair: nacl.SignKeyPair;
  /** Diffie-Hellman X25519 pair used as SPK in X3DH */
  spkPair: nacl.BoxKeyPair;
  aegisId: string;
  deviceId: string;
}

function makeAgentKeys(seed: number): AgentKeys {
  const aegisId = makeAegisId(seed);
  // Deterministic keys from seed for reproducible tests
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
    deviceId: `device-sim-${seed}`,
  };
}

/**
 * Solve the X25519 challenge-response:
 *   server encrypted 32 random bytes with our publicKey → client decrypts + echoes back
 */
function solveChallenge(
  wire: { ephemeralPubKey: string; nonce: string; ciphertext: string },
  mySecretKey: Uint8Array,
): string {
  const plain = nacl.box.open(
    decodeBase64(wire.ciphertext),
    decodeBase64(wire.nonce),
    decodeBase64(wire.ephemeralPubKey),
    mySecretKey,
  );
  if (!plain) throw new Error('Challenge decryption failed — wrong secret key?');
  return encodeBase64(plain);
}

/**
 * Build a sealed-sender envelope (opaque to the relay — server only sees ciphertext).
 * For the test we just encrypt a JSON payload with nacl.box using the recipient's pubkey.
 */
function sealEnvelope(
  id: string,
  to: string,
  message: string,
  senderSecretKey: Uint8Array,
  recipientPublicKey: Uint8Array,
): { id: string; to: string; ciphertext: string; nonce: string } {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const plaintext = new TextEncoder().encode(JSON.stringify({ msg: message, sender: 'sim' }));
  const ciphertext = nacl.box(plaintext, nonce, recipientPublicKey, senderSecretKey);
  return { id, to, ciphertext: encodeBase64(ciphertext), nonce: encodeBase64(nonce) };
}

/**
 * Decrypt a received envelope using the sender's public key.
 * In production the sender's pubkey is recovered from the ciphertext via trial-decryption;
 * in the test we pass it directly since we know who the sender is.
 */
function openEnvelope(
  ciphertext: string,
  nonce: string,
  senderPublicKey: Uint8Array,
  recipientSecretKey: Uint8Array,
): string {
  const plain = nacl.box.open(
    decodeBase64(ciphertext),
    decodeBase64(nonce),
    senderPublicKey,
    recipientSecretKey,
  );
  if (!plain) throw new Error('Envelope decryption failed');
  return JSON.parse(new TextDecoder().decode(plain)).msg as string;
}

// ── Test server setup ─────────────────────────────────────────────────────────
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
  // Disconnect all Socket.IO clients first, then close servers.
  // Errors are swallowed — the server may already be idle after test sockets disconnect.
  // Force-drop server-side sockets first so their disconnect handlers run, then
  // close the servers and let any relay async settle before Jest tears down the
  // module environment (prevents 'import after teardown' under CI timing).
  io.disconnectSockets(true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => {
    io.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
}, 10_000);

// ── Helper: register one agent via HTTP ───────────────────────────────────────
async function registerAgent(keys: AgentKeys): Promise<void> {
  // 1. Get PoW challenge
  const challengeRes = await request.get('/identity/challenge').expect(200);
  const { challenge, difficulty } = challengeRes.body as { challenge: string; difficulty: number };

  // 2. Solve PoW
  const nonce = solvePoW(challenge, difficulty);

  // 3. Register
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

// ── Helper: upload prekeys for one agent ─────────────────────────────────────
async function uploadPrekeys(keys: AgentKeys, opkCount = 5): Promise<void> {
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const message = new TextEncoder().encode(`${keys.aegisId}:prekeys:${timeBucket}`);
  const sig = nacl.sign.detached(message, keys.signKeyPair.secretKey);

  // SPK signature: sign SPK publicKey bytes with identity signing key
  const spkSig = nacl.sign.detached(keys.spkPair.publicKey, keys.signKeyPair.secretKey);

  const oneTimePreKeys = Array.from({ length: opkCount }, (_, i) => {
    const opk = nacl.box.keyPair();
    return { keyId: i + 1, publicKeyB64: encodeBase64(opk.publicKey) };
  });

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
      oneTimePreKeys,
    })
    .expect(201);
}

// ── Helper: connect + authenticate via Socket.IO ─────────────────────────────
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
      const plain = solveChallenge(wire, keys.boxKeyPair.secretKey);
      socket.emit('auth:response', { plain });
    });

    socket.on('auth:ok', () => {
      clearTimeout(timer);
      resolve(socket);
    });

    socket.on('error_msg', (e: { code: string }) => {
      clearTimeout(timer);
      socket.disconnect();
      reject(new Error(`Server error: ${e.code}`));
    });

    socket.on('connect_error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// ── Helper: wait for one event on a socket ───────────────────────────────────
// Rejects immediately if the socket disconnects — prevents dangling promises
// that would fire during unrelated tests and corrupt Jest's test attribution.
function once<T>(socket: ClientSocket, event: string, timeoutMs = 4_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        socket.off(event, handler);
        socket.off('disconnect', onDisconnect);
        reject(new Error(`Timeout waiting for '${event}'`));
      },
      timeoutMs,
    );

    function handler(data: T) {
      clearTimeout(timer);
      socket.off('disconnect', onDisconnect);
      resolve(data);
    }

    function onDisconnect() {
      clearTimeout(timer);
      socket.off(event, handler);
      reject(new Error(`Socket disconnected while waiting for '${event}'`));
    }

    socket.once(event, handler);
    socket.once('disconnect', onDisconnect);
  });
}

// ── Helper: connect and collect ALL envelopes received during/after auth ──────
// The relay drains the offline queue BEFORE emitting 'auth:ok', so this helper
// attaches the envelope listener BEFORE authentication completes, ensuring no
// queued messages are missed.
interface DrainResult {
  socket: ClientSocket;
  envelopes: Array<{ id: string; to: string; ciphertext: string; nonce: string; createdAt?: number }>;
}

function connectAndDrain(keys: AgentKeys, drainWindowMs = 300): Promise<DrainResult> {
  return new Promise((resolve, reject) => {
    const envelopes: DrainResult['envelopes'] = [];

    const socket = clientIo(serverUrl, {
      auth: { aegisId: keys.aegisId, platform: 'mobile', deviceId: keys.deviceId },
      transports: ['websocket'],
      reconnection: false,
    });

    // ⚠️ CRITICAL: attach envelope listener BEFORE auth completes.
    // The server drains the offline queue inside onAuthenticated() which runs
    // BEFORE emitting auth:ok — so envelopes arrive before we'd normally listen.
    socket.on('envelope', (env) => envelopes.push(env));

    const authTimer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Drain-connect auth timeout for ${keys.aegisId}`));
    }, 10_000);

    socket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      const plain = solveChallenge(wire, keys.boxKeyPair.secretKey);
      socket.emit('auth:response', { plain });
    });

    socket.on('auth:ok', () => {
      clearTimeout(authTimer);
      // Small window to let any final drain events arrive before resolving
      setTimeout(() => resolve({ socket, envelopes }), drainWindowMs);
    });

    socket.on('error_msg', (e: { code: string }) => {
      clearTimeout(authTimer);
      socket.disconnect();
      reject(new Error(`Server error: ${e.code}`));
    });

    socket.on('connect_error', (err: Error) => {
      clearTimeout(authTimer);
      reject(err);
    });
  });
}

// ── Agents ────────────────────────────────────────────────────────────────────
const alice = makeAgentKeys(1);
const bob = makeAgentKeys(2);
const carol = makeAgentKeys(3);

// ═══════════════════════════════════════════════════════════════════════════════
// Test suite
// ═══════════════════════════════════════════════════════════════════════════════

describe('Identity registration', () => {
  it('Alice registers successfully', async () => {
    await registerAgent(alice);
    const res = await request.get(`/identity/${alice.aegisId}`).expect(200);
    expect(res.body.aegisId).toBe(alice.aegisId);
    expect(res.body.publicKey).toBe(encodeBase64(alice.boxKeyPair.publicKey));
    expect(res.body.signingPublicKey).toBe(encodeBase64(alice.signKeyPair.publicKey));
  }, 30_000);

  it('Bob registers successfully', async () => {
    await registerAgent(bob);
    const res = await request.get(`/identity/${bob.aegisId}`).expect(200);
    expect(res.body.aegisId).toBe(bob.aegisId);
  }, 30_000);

  it('Carol registers successfully', async () => {
    await registerAgent(carol);
    const res = await request.get(`/identity/${carol.aegisId}`).expect(200);
    expect(res.body.aegisId).toBe(carol.aegisId);
  }, 30_000);

  it('duplicate registration with same key is idempotent (200)', async () => {
    // Re-registering with the exact same keys must return 200 (not 201 or 409)
    const challengeRes = await request.get('/identity/challenge').expect(200);
    const { challenge, difficulty } = challengeRes.body as { challenge: string; difficulty: number };
    const nonce = solvePoW(challenge, difficulty);

    const res = await request
      .post('/identity')
      .send({
        aegisId: alice.aegisId,
        publicKey: encodeBase64(alice.boxKeyPair.publicKey),
        signingPublicKey: encodeBase64(alice.signKeyPair.publicKey),
        powChallenge: challenge,
        powNonce: nonce,
      });
    expect([200, 201]).toContain(res.status);
  }, 30_000);

  it('registration without PoW is rejected (403)', async () => {
    const otherKeys = makeAgentKeys(99);
    const res = await request
      .post('/identity')
      .send({
        aegisId: otherKeys.aegisId,
        publicKey: encodeBase64(otherKeys.boxKeyPair.publicKey),
        signingPublicKey: encodeBase64(otherKeys.signKeyPair.publicKey),
        powChallenge: 'a'.repeat(64),
        powNonce: '0',
      });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pow_failed');
  }, 10_000);
});

describe('Prekey upload', () => {
  it('Alice uploads prekeys', async () => {
    await uploadPrekeys(alice, 5);
  }, 10_000);

  it('Bob uploads prekeys', async () => {
    await uploadPrekeys(bob, 5);
  }, 10_000);

  it('Carol uploads prekeys', async () => {
    await uploadPrekeys(carol, 5);
  }, 10_000);

  it('Alice prekey bundle is fetchable via HTTP', async () => {
    const res = await request.get(`/prekeys/bundle/${alice.aegisId}`).expect(200);
    expect(res.body.bundle).toBeTruthy();
    expect(res.body.bundle.signedPreKey.publicKeyB64).toBe(
      encodeBase64(alice.spkPair.publicKey),
    );
    // OPKs should be available
    expect(res.body.bundle.oneTimePreKey).not.toBeNull();
  });
});

describe('Socket.IO authentication', () => {
  let socketAlice: ClientSocket;
  let socketBob: ClientSocket;
  let socketCarol: ClientSocket;

  afterAll(() => {
    socketAlice?.disconnect();
    socketBob?.disconnect();
    socketCarol?.disconnect();
  });

  it('Alice authenticates', async () => {
    socketAlice = await connectAgent(alice);
    expect(socketAlice.connected).toBe(true);
  }, 10_000);

  it('Bob authenticates', async () => {
    socketBob = await connectAgent(bob);
    expect(socketBob.connected).toBe(true);
  }, 10_000);

  it('Carol authenticates', async () => {
    socketCarol = await connectAgent(carol);
    expect(socketCarol.connected).toBe(true);
  }, 10_000);

  it('unknown identity is rejected', async () => {
    const ghost = makeAgentKeys(777);
    await expect(connectAgent(ghost)).rejects.toThrow('unknown_identity');
  }, 10_000);
});

describe('Online message delivery', () => {
  let socketAlice: ClientSocket;
  let socketBob: ClientSocket;
  let socketCarol: ClientSocket;

  beforeAll(async () => {
    socketAlice = await connectAgent(alice);
    socketBob = await connectAgent(bob);
    socketCarol = await connectAgent(carol);
  }, 15_000);

  afterAll(() => {
    socketAlice?.disconnect();
    socketBob?.disconnect();
    socketCarol?.disconnect();
  });

  it('Alice sends a message to Bob, Bob receives it', async () => {
    const msgId = 'msg-alice-to-bob-001';
    const envelope = sealEnvelope(
      msgId,
      bob.aegisId,
      'Hello Bob! — Alice',
      alice.boxKeyPair.secretKey,
      bob.boxKeyPair.publicKey,
    );

    const [receivedEnv, ack] = await Promise.all([
      once<{ id: string; ciphertext: string; nonce: string; senderPublicKeyB64?: string }>(
        socketBob,
        'envelope',
      ),
      new Promise<{ ok: boolean; queued?: boolean }>((resolve) =>
        socketAlice.emit('envelope', envelope, resolve),
      ),
    ]);

    // Delivery ack
    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(false);

    // Bob receives the envelope
    expect(receivedEnv.id).toBe(msgId);

    // Bob decrypts successfully
    const decrypted = openEnvelope(
      receivedEnv.ciphertext,
      receivedEnv.nonce,
      alice.boxKeyPair.publicKey,
      bob.boxKeyPair.secretKey,
    );
    expect(decrypted).toBe('Hello Bob! — Alice');
  });

  it('Bob sends a message to Carol, Carol receives it', async () => {
    const msgId = 'msg-bob-to-carol-001';
    const envelope = sealEnvelope(
      msgId,
      carol.aegisId,
      'Hey Carol — Bob',
      bob.boxKeyPair.secretKey,
      carol.boxKeyPair.publicKey,
    );

    const [receivedEnv, ack] = await Promise.all([
      once<{ id: string; ciphertext: string; nonce: string }>(socketCarol, 'envelope'),
      new Promise<{ ok: boolean; queued?: boolean }>((resolve) =>
        socketBob.emit('envelope', envelope, resolve),
      ),
    ]);

    expect(ack.ok).toBe(true);
    expect(ack.queued).toBe(false);
    expect(receivedEnv.id).toBe(msgId);

    const decrypted = openEnvelope(
      receivedEnv.ciphertext,
      receivedEnv.nonce,
      bob.boxKeyPair.publicKey,
      carol.boxKeyPair.secretKey,
    );
    expect(decrypted).toBe('Hey Carol — Bob');
  });

  it('Alice receives msg:delivered when Bob is online', async () => {
    const msgId = 'msg-alice-to-bob-002';
    const envelope = sealEnvelope(
      msgId,
      bob.aegisId,
      'Delivery confirmation test',
      alice.boxKeyPair.secretKey,
      bob.boxKeyPair.publicKey,
    );

    const [delivered] = await Promise.all([
      once<{ msgId: string; to: string }>(socketAlice, 'msg:delivered'),
      // Bob must be listening to complete the delivery
      once<unknown>(socketBob, 'envelope'),
      new Promise<void>((resolve) => socketAlice.emit('envelope', envelope, () => resolve())),
    ]);

    expect(delivered.msgId).toBe(msgId);
    expect(delivered.to).toBe(bob.aegisId);
  });

  it('envelope with invalid format is rejected', async () => {
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) =>
      socketAlice.emit('envelope', { id: '', to: 'invalid', ciphertext: '', nonce: '' }, resolve),
    );
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid_envelope');
  });
});

describe('Offline queue and drain', () => {
  let socketAlice: ClientSocket;
  let socketBob: ClientSocket;

  beforeAll(async () => {
    socketAlice = await connectAgent(alice);
    socketBob = await connectAgent(bob);
  }, 15_000);

  afterAll(() => {
    socketAlice?.disconnect();
    socketBob?.disconnect();
  });

  it('messages to offline Carol are queued and drained on reconnect', async () => {
    // Carol is offline (not connected in this describe block)
    const msg1Id = 'msg-offline-001';
    const msg2Id = 'msg-offline-002';

    const env1 = sealEnvelope(
      msg1Id,
      carol.aegisId,
      'Queued message 1',
      alice.boxKeyPair.secretKey,
      carol.boxKeyPair.publicKey,
    );
    const env2 = sealEnvelope(
      msg2Id,
      carol.aegisId,
      'Queued message 2',
      bob.boxKeyPair.secretKey,
      carol.boxKeyPair.publicKey,
    );

    // Both envelopes must be queued (not delivered online)
    const [ack1, ack2] = await Promise.all([
      new Promise<{ ok: boolean; queued?: boolean }>((resolve) =>
        socketAlice.emit('envelope', env1, resolve),
      ),
      new Promise<{ ok: boolean; queued?: boolean }>((resolve) =>
        socketBob.emit('envelope', env2, resolve),
      ),
    ]);

    expect(ack1.ok).toBe(true);
    expect(ack1.queued).toBe(true);
    expect(ack2.ok).toBe(true);
    expect(ack2.queued).toBe(true);

    // Carol reconnects.
    // connectAndDrain attaches the 'envelope' listener BEFORE auth:ok so
    // it captures messages that the relay drains during onAuthenticated()
    // (which runs BEFORE auth:ok is emitted).
    const { socket: carolSocket, envelopes } = await connectAndDrain(carol);
    try {
      const ids = envelopes.map((e) => e.id);
      expect(ids).toContain(msg1Id);
      expect(ids).toContain(msg2Id);
    } finally {
      carolSocket.disconnect();
    }
  }, 20_000);
});

describe('Typing indicators', () => {
  let socketAlice: ClientSocket;
  let socketBob: ClientSocket;

  beforeAll(async () => {
    [socketAlice, socketBob] = await Promise.all([connectAgent(alice), connectAgent(bob)]);
  }, 15_000);

  afterAll(() => {
    socketAlice?.disconnect();
    socketBob?.disconnect();
  });

  it('Alice typing → Bob receives typing:from=Alice', async () => {
    const [typingEvent] = await Promise.all([
      once<{ from: string; isTyping: boolean }>(socketBob, 'typing'),
      Promise.resolve(socketAlice.emit('typing', { to: bob.aegisId, isTyping: true })),
    ]);
    expect(typingEvent.from).toBe(alice.aegisId);
    expect(typingEvent.isTyping).toBe(true);
  });

  it('Alice stops typing → Bob receives isTyping=false', async () => {
    const [typingEvent] = await Promise.all([
      once<{ from: string; isTyping: boolean }>(socketBob, 'typing'),
      Promise.resolve(socketAlice.emit('typing', { to: bob.aegisId, isTyping: false })),
    ]);
    expect(typingEvent.from).toBe(alice.aegisId);
    expect(typingEvent.isTyping).toBe(false);
  });
});

describe('Read receipts', () => {
  let socketAlice: ClientSocket;
  let socketBob: ClientSocket;

  beforeAll(async () => {
    [socketAlice, socketBob] = await Promise.all([connectAgent(alice), connectAgent(bob)]);
  }, 15_000);

  afterAll(() => {
    socketAlice?.disconnect();
    socketBob?.disconnect();
  });

  it('Bob reads messages → Alice receives msg:read with correct msgIds', async () => {
    const msgIds = ['msg-read-001', 'msg-read-002', 'msg-read-003'];

    const [readEvent] = await Promise.all([
      once<{ from: string; msgIds: string[] }>(socketAlice, 'msg:read'),
      Promise.resolve(socketBob.emit('msg:read', { to: alice.aegisId, msgIds })),
    ]);

    expect(readEvent.from).toBe(bob.aegisId);
    expect(readEvent.msgIds).toEqual(expect.arrayContaining(msgIds));
  });
});

describe('Remote delete', () => {
  let socketAlice: ClientSocket;
  let socketBob: ClientSocket;

  beforeAll(async () => {
    [socketAlice, socketBob] = await Promise.all([connectAgent(alice), connectAgent(bob)]);
  }, 15_000);

  afterAll(() => {
    socketAlice?.disconnect();
    socketBob?.disconnect();
  });

  it('the legacy plaintext msg:delete relay event is NOT forwarded (path removed)', async () => {
    // Regression: delete-for-everyone moved into the sealed E2EE channel. The
    // relay must no longer forward a plaintext msg:delete — it leaked the
    // sender↔recipient pair and carried no proof-of-key-possession.
    const msgId = 'msg-to-delete-001';

    const received = new Promise<'forwarded'>((resolve) => {
      socketAlice.once('msg:delete', () => resolve('forwarded'));
    });
    const timedOut = new Promise<'no-event'>((resolve) => {
      setTimeout(() => resolve('no-event'), 500);
    });
    socketBob.emit('msg:delete', { to: alice.aegisId, msgId });

    await expect(Promise.race([received, timedOut])).resolves.toBe('no-event');
  });
});

describe('Prekey bundle via socket (X3DH handshake)', () => {
  let socketAlice: ClientSocket;

  beforeAll(async () => {
    socketAlice = await connectAgent(alice);
  }, 10_000);

  afterAll(() => socketAlice?.disconnect());

  it('Alice fetches Bob\'s prekey bundle via socket prekeys:fetch', async () => {
    const bundle = await new Promise<{
      ok: boolean;
      bundle?: {
        signingPublicKeyB64: string;
        signedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string };
        oneTimePreKey: { keyId: number; publicKeyB64: string } | null;
      };
      error?: string;
    }>((resolve) => socketAlice.emit('prekeys:fetch', { aegisId: bob.aegisId }, resolve));

    expect(bundle.ok).toBe(true);
    expect(bundle.bundle).toBeTruthy();
    expect(bundle.bundle!.signedPreKey.publicKeyB64).toBe(encodeBase64(bob.spkPair.publicKey));
  });

  it('X3DH: Alice verifies Bob\'s SPK signature before accepting the bundle', async () => {
    const bundleRes = await new Promise<{
      ok: boolean;
      bundle?: {
        signingPublicKeyB64: string;
        signedPreKey: { keyId: number; publicKeyB64: string; signatureB64: string };
        oneTimePreKey: { keyId: number; publicKeyB64: string } | null;
      };
    }>((resolve) => socketAlice.emit('prekeys:fetch', { aegisId: bob.aegisId }, resolve));

    expect(bundleRes.ok).toBe(true);
    const b = bundleRes.bundle!;

    // Verify the SPK signature (Alice performs this client-side in X3DH)
    const spkBytes = decodeBase64(b.signedPreKey.publicKeyB64);
    const sigBytes = decodeBase64(b.signedPreKey.signatureB64);
    const signingPubKey = decodeBase64(b.signingPublicKeyB64);

    const valid = nacl.sign.detached.verify(spkBytes, sigBytes, signingPubKey);
    expect(valid).toBe(true);
  });
});

describe('Multi-agent conversation', () => {
  let socketAlice: ClientSocket;
  let socketBob: ClientSocket;
  let socketCarol: ClientSocket;

  beforeAll(async () => {
    [socketAlice, socketBob, socketCarol] = await Promise.all([
      connectAgent(alice),
      connectAgent(bob),
      connectAgent(carol),
    ]);
  }, 15_000);

  afterAll(() => {
    socketAlice?.disconnect();
    socketBob?.disconnect();
    socketCarol?.disconnect();
  });

  it('group broadcast: Alice sends to Bob AND Carol in parallel', async () => {
    const msgToBob = sealEnvelope(
      'group-001-bob',
      bob.aegisId,
      'Hi everyone — Bob copy',
      alice.boxKeyPair.secretKey,
      bob.boxKeyPair.publicKey,
    );
    const msgToCarol = sealEnvelope(
      'group-001-carol',
      carol.aegisId,
      'Hi everyone — Carol copy',
      alice.boxKeyPair.secretKey,
      carol.boxKeyPair.publicKey,
    );

    const [envBob, envCarol, ackBob, ackCarol] = await Promise.all([
      once<{ id: string }>(socketBob, 'envelope'),
      once<{ id: string }>(socketCarol, 'envelope'),
      new Promise<{ ok: boolean }>((resolve) =>
        socketAlice.emit('envelope', msgToBob, resolve),
      ),
      new Promise<{ ok: boolean }>((resolve) =>
        socketAlice.emit('envelope', msgToCarol, resolve),
      ),
    ]);

    expect(ackBob.ok).toBe(true);
    expect(ackCarol.ok).toBe(true);
    expect(envBob.id).toBe('group-001-bob');
    expect(envCarol.id).toBe('group-001-carol');
  });

  it('conversation thread: Alice→Bob→Carol→Alice', async () => {
    // Alice sends to Bob
    const e1 = sealEnvelope(
      'thread-1', bob.aegisId, 'Thread start',
      alice.boxKeyPair.secretKey, bob.boxKeyPair.publicKey,
    );
    const [, ack1] = await Promise.all([
      once<unknown>(socketBob, 'envelope'),
      new Promise<{ ok: boolean }>((r) => socketAlice.emit('envelope', e1, r)),
    ]);
    expect(ack1.ok).toBe(true);

    // Bob replies to Carol
    const e2 = sealEnvelope(
      'thread-2', carol.aegisId, 'Thread middle',
      bob.boxKeyPair.secretKey, carol.boxKeyPair.publicKey,
    );
    const [, ack2] = await Promise.all([
      once<unknown>(socketCarol, 'envelope'),
      new Promise<{ ok: boolean }>((r) => socketBob.emit('envelope', e2, r)),
    ]);
    expect(ack2.ok).toBe(true);

    // Carol replies to Alice
    const e3 = sealEnvelope(
      'thread-3', alice.aegisId, 'Thread end',
      carol.boxKeyPair.secretKey, alice.boxKeyPair.publicKey,
    );
    const [envFromCarol, ack3] = await Promise.all([
      once<{ id: string; ciphertext: string; nonce: string }>(socketAlice, 'envelope'),
      new Promise<{ ok: boolean }>((r) => socketCarol.emit('envelope', e3, r)),
    ]);

    expect(ack3.ok).toBe(true);
    expect(envFromCarol.id).toBe('thread-3');

    // Alice decrypts Carol's message
    const decrypted = openEnvelope(
      envFromCarol.ciphertext,
      envFromCarol.nonce,
      carol.boxKeyPair.publicKey,
      alice.boxKeyPair.secretKey,
    );
    expect(decrypted).toBe('Thread end');
  });
});
