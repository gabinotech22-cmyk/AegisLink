/**
 * call-signaling.test.ts
 *
 * Integration tests for the call:invite / call:ice offline handling:
 *
 *   (a) invite offline with push tokens → NO peer_offline + invite re-delivered
 *       at reconnect (with buffered ICE drained after it)
 *   (b) invite offline without push tokens → peer_offline + queue cancelled
 *   (c) ICE buffered while callee offline, drained in order after invite on reconnect
 *   (d) ICE buffer cap: candidates beyond 32 are silently discarded
 *
 * Each test group uses its own caller/callee agent pair (unique seeds) to avoid
 * sharing rate-limit buckets (max 5 call:invite/min per aegisId).
 * Push tokens are written to / deleted from the in-memory SQLite DB per test.
 * The expo-server-sdk is replaced by the test mock in jest.config.cjs.
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

import { pushRepo, identityRepo, initDb } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';

// ── Crockford Base32 helpers ──────────────────────────────────────────────────
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

// ── Agent builder ─────────────────────────────────────────────────────────────
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
    deviceId: `dev-call-${seed}`,
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

// ── Test server ───────────────────────────────────────────────────────────────
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

  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });

  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;
}, 30_000);

afterAll(async () => {
  // Force-drop server-side sockets first so their disconnect handlers (timer
  // cleanup) run, then close the servers and let any relay async settle before
  // Jest tears down the module environment — otherwise a late socket event can
  // trigger 'import after teardown' under CI timing and cascade to sibling
  // suites sharing the worker.
  io.disconnectSockets(true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => { io.close(() => resolve()); });
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
  await new Promise((resolve) => setTimeout(resolve, 50));
}, 10_000);

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Register an agent directly in the SQLite DB — bypasses the HTTP /identity
 * route (which has a strict 5/15min rate limit per IP). The relay's
 * challenge-response auth calls identityRepo.get() internally, so direct
 * insertion is sufficient for socket authentication tests.
 */
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

/**
 * Connect and collect call:invite + call:ice events that arrive during and
 * after authentication (including the drain phase).
 * Listeners are attached BEFORE auth:ok so drain events are captured.
 */
interface CallDrainResult {
  socket: ClientSocket;
  invites: Record<string, unknown>[];
  iceEvents: Record<string, unknown>[];
}

function connectAndCollectCalls(keys: AgentKeys, windowMs = 500): Promise<CallDrainResult> {
  return new Promise((resolve, reject) => {
    const invites: Record<string, unknown>[] = [];
    const iceEvents: Record<string, unknown>[] = [];

    const socket = clientIo(serverUrl, {
      auth: { aegisId: keys.aegisId, platform: 'mobile', deviceId: keys.deviceId },
      transports: ['websocket'],
      reconnection: false,
    });

    socket.on('call:invite', (data: Record<string, unknown>) => invites.push(data));
    socket.on('call:ice', (data: Record<string, unknown>) => iceEvents.push(data));

    const authTimer = setTimeout(() => {
      socket.disconnect();
      reject(new Error(`Auth timeout for ${keys.aegisId}`));
    }, 10_000);

    socket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      socket.emit('auth:response', { plain: solveChallenge(wire, keys.boxKeyPair.secretKey) });
    });

    socket.on('auth:ok', () => {
      clearTimeout(authTimer);
      setTimeout(() => resolve({ socket, invites, iceEvents }), windowMs);
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

function once<T>(socket: ClientSocket, event: string, timeoutMs = 5_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for '${event}'`));
    }, timeoutMs);
    function handler(data: T) {
      clearTimeout(timer);
      resolve(data);
    }
    socket.once(event, handler);
  });
}

/** Collect all `event` payloads that arrive within `windowMs` after `emitFn()`. */
function collectWithin<T>(
  socket: ClientSocket,
  event: string,
  emitFn: () => void,
  windowMs = 400,
): Promise<T[]> {
  return new Promise((resolve) => {
    const results: T[] = [];
    const handler = (data: T) => results.push(data);
    socket.on(event, handler);
    emitFn();
    setTimeout(() => { socket.off(event, handler); resolve(results); }, windowMs);
  });
}

function makeInvitePayload(to: string, callId: string, media: 'audio' | 'video' = 'audio'): Record<string, unknown> {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return { to, callId, media, ciphertext: encodeBase64(nacl.randomBytes(64)), nonce: encodeBase64(nonce) };
}

function makeIcePayload(to: string, callId: string): Record<string, unknown> {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  return { to, callId, ciphertext: encodeBase64(nacl.randomBytes(32)), nonce: encodeBase64(nonce) };
}

// Valid Expo push token (mock checks for this prefix)
const EXPO_TOKEN = 'ExponentPushToken[aegislink-test-xxx]';

// ─────────────────────────────────────────────────────────────────────────────
// Register agents ahead of their describe block.
// Each describe uses UNIQUE seeds so rate-limit buckets (5/min per aegisId)
// are never shared between test groups.
// ─────────────────────────────────────────────────────────────────────────────

// (a) group: seeds 210 / 211
const callerA = makeAgentKeys(210);
const calleeA = makeAgentKeys(211);

// (b) group: seeds 220 / 221
const callerB = makeAgentKeys(220);
const calleeB = makeAgentKeys(221);

// (c) group: seeds 230 / 231
const callerC = makeAgentKeys(230);
const calleeC = makeAgentKeys(231);

// (d) group: seeds 240 / 241
const callerD = makeAgentKeys(240);
const calleeD = makeAgentKeys(241);

// (e) group: seeds 250 / 251 — group_call:channel fanout
const initiatorE = makeAgentKeys(250);
const memberE = makeAgentKeys(251);

beforeAll(async () => {
  // Direct DB insertion — bypasses HTTP rate limiting.
  await Promise.all([
    registerAgent(callerA), registerAgent(calleeA),
    registerAgent(callerB), registerAgent(calleeB),
    registerAgent(callerC), registerAgent(calleeC),
    registerAgent(callerD), registerAgent(calleeD),
    registerAgent(initiatorE), registerAgent(memberE),
  ]);
}, 30_000);

// ═════════════════════════════════════════════════════════════════════════════
// (a) invite offline WITH push tokens → no peer_offline + re-delivered
// ═════════════════════════════════════════════════════════════════════════════

describe('(a) call:invite offline — callee HAS push tokens', () => {
  let callerSocket: ClientSocket;

  beforeEach(async () => {
    await pushRepo.upsert({
      aegis_id: calleeA.aegisId,
      expo_token: EXPO_TOKEN,
      platform: 'android',
      updated_at: Date.now(),
    });
    callerSocket = await connectAgent(callerA);
  });

  afterEach(async () => {
    callerSocket?.disconnect();
    await pushRepo.delete(EXPO_TOKEN);
  });

  it('no peer_offline emitted to caller when callee is reachable via push', async () => {
    const callId = `ca-npo-${Date.now()}`;
    const errors = await collectWithin<{ code: string; for?: string }>(
      callerSocket,
      'error_msg',
      () => callerSocket.emit('call:invite', makeInvitePayload(calleeA.aegisId, callId)),
      600,
    );
    const peerOffline = errors.filter((e) => e.code === 'peer_offline' && e.for === 'call:invite');
    expect(peerOffline).toHaveLength(0);
  }, 10_000);

  it('invite is re-delivered when callee reconnects', async () => {
    const callId = `ca-rdr-${Date.now()}`;
    callerSocket.emit('call:invite', makeInvitePayload(calleeA.aegisId, callId));
    await new Promise<void>((r) => setTimeout(r, 200));

    const { socket: cs, invites } = await connectAndCollectCalls(calleeA);
    try {
      const found = invites.find((inv) => inv['callId'] === callId);
      expect(found).toBeDefined();
      expect(found!['from']).toBe(callerA.aegisId);
    } finally {
      cs.disconnect();
    }
  }, 15_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// (b) invite offline WITHOUT push tokens → peer_offline + queue cancelled
// ═════════════════════════════════════════════════════════════════════════════

describe('(b) call:invite offline — callee has NO push tokens', () => {
  let callerSocket: ClientSocket;

  beforeEach(async () => {
    callerSocket = await connectAgent(callerB);
  });

  afterEach(() => {
    callerSocket?.disconnect();
  });

  it('emits peer_offline to caller', async () => {
    const errPromise = once<{ code: string; for?: string }>(callerSocket, 'error_msg', 4_000);
    callerSocket.emit('call:invite', makeInvitePayload(calleeB.aegisId, `cb-pof-${Date.now()}`));
    const err = await errPromise;
    expect(err.code).toBe('peer_offline');
    expect(err.for).toBe('call:invite');
  }, 8_000);

  it('queue is cancelled — callee reconnect does NOT receive the invite', async () => {
    const callId = `cb-qcl-${Date.now()}`;
    const errPromise = once<{ code: string; for?: string }>(callerSocket, 'error_msg', 4_000);
    callerSocket.emit('call:invite', makeInvitePayload(calleeB.aegisId, callId));
    await errPromise;

    const { socket: cs, invites } = await connectAndCollectCalls(calleeB, 300);
    try {
      expect(invites.find((inv) => inv['callId'] === callId)).toBeUndefined();
    } finally {
      cs.disconnect();
    }
  }, 15_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// (c) ICE buffering while callee offline + drain on reconnect
// ═════════════════════════════════════════════════════════════════════════════

describe('(c) call:ice buffering and drain', () => {
  let callerSocket: ClientSocket;

  beforeEach(async () => {
    await pushRepo.upsert({
      aegis_id: calleeC.aegisId,
      expo_token: EXPO_TOKEN,
      platform: 'android',
      updated_at: Date.now(),
    });
    callerSocket = await connectAgent(callerC);
  });

  afterEach(async () => {
    callerSocket?.disconnect();
    await pushRepo.delete(EXPO_TOKEN);
  });

  it('ICE candidates buffered offline are drained after invite on callee reconnect', async () => {
    const callId = `cc-buf-${Date.now()}`;

    callerSocket.emit('call:invite', makeInvitePayload(calleeC.aegisId, callId));
    callerSocket.emit('call:ice', makeIcePayload(calleeC.aegisId, callId));
    callerSocket.emit('call:ice', makeIcePayload(calleeC.aegisId, callId));
    callerSocket.emit('call:ice', makeIcePayload(calleeC.aegisId, callId));

    await new Promise<void>((r) => setTimeout(r, 250));

    const { socket: cs, invites, iceEvents } = await connectAndCollectCalls(calleeC, 600);
    try {
      const foundInvite = invites.find((inv) => inv['callId'] === callId);
      expect(foundInvite).toBeDefined();
      expect(foundInvite!['from']).toBe(callerC.aegisId);
      expect(iceEvents).toHaveLength(3);
      for (const ice of iceEvents) {
        expect(ice['from']).toBe(callerC.aegisId);
      }
    } finally {
      cs.disconnect();
    }
  }, 20_000);

  it('call:ice does NOT emit peer_offline to caller when callee is offline', async () => {
    const callId = `cc-npo-${Date.now()}`;
    callerSocket.emit('call:invite', makeInvitePayload(calleeC.aegisId, callId));
    await new Promise<void>((r) => setTimeout(r, 100));

    const errors = await collectWithin<{ code: string; for?: string }>(
      callerSocket,
      'error_msg',
      () => {
        callerSocket.emit('call:ice', makeIcePayload(calleeC.aegisId, callId));
        callerSocket.emit('call:ice', makeIcePayload(calleeC.aegisId, callId));
      },
      400,
    );
    const iceOffline = errors.filter((e) => e.code === 'peer_offline' && e.for === 'call:ice');
    expect(iceOffline).toHaveLength(0);

    // Drain the pending invite to leave clean state
    const { socket: cs } = await connectAndCollectCalls(calleeC, 200);
    cs.disconnect();
  }, 15_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// (d) ICE buffer cap of 32
// ═════════════════════════════════════════════════════════════════════════════

describe('(d) call:ice buffer cap', () => {
  let callerSocket: ClientSocket;

  beforeEach(async () => {
    await pushRepo.upsert({
      aegis_id: calleeD.aegisId,
      expo_token: EXPO_TOKEN,
      platform: 'android',
      updated_at: Date.now(),
    });
    callerSocket = await connectAgent(callerD);
  });

  afterEach(async () => {
    callerSocket?.disconnect();
    await pushRepo.delete(EXPO_TOKEN);
  });

  it('at most 32 ICE candidates delivered on drain when 50 were sent', async () => {
    const callId = `cd-cap-${Date.now()}`;

    callerSocket.emit('call:invite', makeInvitePayload(calleeD.aegisId, callId));
    await new Promise<void>((r) => setTimeout(r, 100));

    for (let i = 0; i < 50; i++) {
      callerSocket.emit('call:ice', makeIcePayload(calleeD.aegisId, callId));
    }
    await new Promise<void>((r) => setTimeout(r, 400));

    const { socket: cs, iceEvents } = await connectAndCollectCalls(calleeD, 600);
    try {
      expect(iceEvents.length).toBeLessThanOrEqual(32);
      expect(iceEvents.length).toBeGreaterThan(0);
    } finally {
      cs.disconnect();
    }
  }, 20_000);
});

// ═════════════════════════════════════════════════════════════════════════════
// (e) group_call:channel — heartbeat fans out to ONLINE members (banner aware)
// ═════════════════════════════════════════════════════════════════════════════

function makeChannelPayload(to: string[], callId: string): Record<string, unknown> {
  return {
    to,
    callId,
    groupId: 'grp-treasury',
    groupName: 'DAO · Treasury',
    participants: [to[0]],
    media: 'audio',
  };
}

describe('(e) group_call:channel fanout to online members', () => {
  let initiatorSocket: ClientSocket;

  beforeEach(async () => {
    initiatorSocket = await connectAgent(initiatorE);
  });

  afterEach(() => {
    initiatorSocket?.disconnect();
  });

  it('online member receives the channel heartbeat with from injected', async () => {
    // A real UUID — the schema requires z.string().uuid().
    const callId = '11111111-2222-4333-8444-555555555555';
    const memberSocket = await connectAgent(memberE);
    try {
      const channels = await collectWithin<Record<string, unknown>>(
        memberSocket,
        'group_call:channel',
        () => initiatorSocket.emit('group_call:channel', makeChannelPayload([memberE.aegisId], callId)),
        500,
      );
      const found = channels.find((c) => c['callId'] === callId);
      expect(found).toBeDefined();
      expect(found!['from']).toBe(initiatorE.aegisId);
      expect(found!['groupId']).toBe('grp-treasury');
      // The relay strips `to` before forwarding.
      expect(found!['to']).toBeUndefined();
    } finally {
      memberSocket.disconnect();
    }
  }, 12_000);
});
