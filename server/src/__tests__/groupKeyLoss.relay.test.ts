/**
 * groupKeyLoss.relay.test.ts — audit 2026-08-08
 *
 * "I create a group and it never shows up for the other contact — not by
 * sending messages, not by calling, it simply never appears."
 *
 * The group:rekey handler forwarded each sealed SenderKey distribution live when
 * `recipientSockets.size > 0` and enqueued it ONLY in the else branch. That
 * `size > 0` is the original zombie-socket bug liveSockets exists to kill (see
 * zombieSocket.relay.test.ts); this call site was never migrated. A dead-but-
 * registered socket — or an iOS app torn down without closing its TCP connection,
 * which keeps reporting `connected === true` for up to ~35s — therefore swallowed
 * the distribution and nothing was ever stored.
 *
 * A lost message is bad. A lost SenderKey distribution is worse: without it the
 * recipient cannot open ANY message for that group, so the group never appears
 * for them at all — and because nothing was queued there is no recovery path.
 * Not reconnecting, not sending, not calling. Permanent.
 *
 * Fix: enqueue FIRST, always, then emit to the sockets that are actually live —
 * the same order the message paths use. Same distId on the wire as in the queue,
 * so the recipient's 'group:rekey_drain_ack' frees the row it just persisted.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer, type Socket as ServerSocket } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

import { identityRepo, senderKeyDistRepo, initDb } from '../db/client.js';
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
    deviceId: `dev-grp-${seed}`,
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

function rekey(socket: ClientSocket, groupId: string, toAegisId: string): Promise<{ ok: boolean }> {
  return new Promise((resolve) => {
    socket.emit(
      'group:rekey',
      {
        groupId,
        distributions: [{
          aegisId: toAegisId,
          ciphertextB64: encodeBase64(nacl.randomBytes(64)),
          // GroupRekeyDistribution pins nonceB64 to exactly 44 chars = 32 bytes.
          nonceB64: encodeBase64(nacl.randomBytes(32)),
          iteration: 0,
        }],
      },
      (res: { ok: boolean }) => resolve(res),
    );
  });
}

const GROUP_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

describe('group SenderKey distribution must survive a socket that is not really there', () => {
  test('a zombie recipient socket does not swallow the distribution', async () => {
    const admin = makeAgentKeys(92001);
    const member = makeAgentKeys(92002);
    await registerAgent(admin);
    await registerAgent(member);

    const memberSock = await connectAgent(member);
    const adminSock = await connectAgent(admin);

    // Exactly the state the old `size > 0` check could not see: still in the
    // sockets map, transport already dead.
    const memberServerSocket = [...io.sockets.sockets.values()].find(
      (s: ServerSocket) => (s.handshake.auth as { aegisId?: string }).aegisId === member.aegisId,
    );
    expect(memberServerSocket).toBeDefined();
    Object.defineProperty(memberServerSocket, 'connected', { value: false, configurable: true });

    const got: unknown[] = [];
    memberSock.on('group:rekey_dist', (d: unknown) => got.push(d));

    expect((await rekey(adminSock, GROUP_ID, member.aegisId)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));

    expect(got).toHaveLength(0); // nothing emitted into the dead transport
    // ...but the key is queued, so the member gets the group on next connect
    // instead of never seeing it at all.
    const queued = await senderKeyDistRepo.drainFor(member.aegisId);
    expect(queued.map((r) => r.group_id)).toContain(GROUP_ID);

    memberSock.disconnect();
    adminSock.disconnect();
  }, 15_000);

  test('a genuinely live recipient still gets it live AND has a durable copy', async () => {
    const admin = makeAgentKeys(92003);
    const member = makeAgentKeys(92004);
    await registerAgent(admin);
    await registerAgent(member);

    const memberSock = await connectAgent(member);
    const adminSock = await connectAgent(admin);

    const got: Array<{ distId: string; groupId: string }> = [];
    memberSock.on('group:rekey_dist', (d: { distId: string; groupId: string }) => got.push(d));

    expect((await rekey(adminSock, GROUP_ID, member.aegisId)).ok).toBe(true);
    await new Promise((r) => setTimeout(r, 150));

    expect(got).toHaveLength(1);
    expect(got[0]?.groupId).toBe(GROUP_ID);

    // The durable copy exists and carries the SAME distId that went on the wire,
    // so the recipient's drain-ack frees exactly the row it just persisted.
    const queued = await senderKeyDistRepo.drainFor(member.aegisId);
    expect(queued.map((r) => r.id)).toContain(got[0]?.distId);

    memberSock.disconnect();
    adminSock.disconnect();
  }, 15_000);

  test("the recipient's drain-ack frees the row", async () => {
    const admin = makeAgentKeys(92005);
    const member = makeAgentKeys(92006);
    await registerAgent(admin);
    await registerAgent(member);

    const memberSock = await connectAgent(member);
    const adminSock = await connectAgent(admin);

    const acked = new Promise<void>((resolve) => {
      memberSock.on('group:rekey_dist', (d: { distId: string }) => {
        memberSock.emit('group:rekey_drain_ack', { distId: d.distId });
        setTimeout(resolve, 200);
      });
    });

    await rekey(adminSock, GROUP_ID, member.aegisId);
    await acked;

    expect(await senderKeyDistRepo.drainFor(member.aegisId)).toHaveLength(0);

    memberSock.disconnect();
    adminSock.disconnect();
  }, 15_000);
});
