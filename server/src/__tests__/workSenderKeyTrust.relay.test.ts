/**
 * workSenderKeyTrust.relay.test.ts — golden rule #7 regression.
 *
 * The relay must DERIVE the distributor identity on `work:sender_key_dist` from
 * the authenticated socket, never trust the client-supplied `senderAegisId`.
 * A malicious member that stamps another member's id must NOT be able to make
 * the recipient see a spoofed distributor: the forwarded `senderAegisId` must
 * equal the authenticated emitter.
 *
 * Self-contained harness (mirrors ola8.relay.test.ts).
 */

process.env['AEGIS_DB_PATH'] = ':memory:';

import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeBase64 } = naclUtil;

import { identityRepo, initDb, workRepo, workChannelRepo } from '../db/client.js';
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
  const seedBytes = new Uint8Array(32);
  const view = new DataView(seedBytes.buffer);
  view.setUint32(0, seed, false);
  view.setUint32(4, seed * 31337, false);
  return {
    boxKeyPair: nacl.box.keyPair.fromSecretKey(seedBytes),
    signKeyPair: nacl.sign.keyPair.fromSeed(seedBytes),
    aegisId: makeAegisId(seed),
    deviceId: `dev-wskt-${seed}`,
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

describe('Work sender-key distribution — server-derived distributor identity (golden rule #7)', () => {
  test('forwarded senderAegisId is the authenticated emitter, not a client-spoofed value', async () => {
    const distributor = makeAgentKeys(70101);
    const recipient = makeAgentKeys(70102);
    const victim = makeAgentKeys(70103); // identity the attacker tries to impersonate

    await registerAgent(distributor);
    await registerAgent(recipient);
    await registerAgent(victim);

    const orgId = randomUUID();
    const channelId = randomUUID();
    const now = Date.now();
    await workRepo.createOrg({ org_id: orgId, name: 'Acme', admin_id: distributor.aegisId, policy_key_rotation_days: 30, created_at: now });
    await workRepo.addMember({ org_id: orgId, aegis_id: distributor.aegisId, team: 'eng', role: 'admin', joined_at: now });
    await workRepo.addMember({ org_id: orgId, aegis_id: recipient.aegisId, team: 'eng', role: 'member', joined_at: now });
    await workChannelRepo.create({ channel_id: channelId, org_id: orgId, name: 'general', is_announcements: 0, created_at: now });

    const distSock = await connectAgent(distributor);
    const recSock = await connectAgent(recipient);

    const received = new Promise<{ senderAegisId?: string }>((resolve) => {
      recSock.on('work:sender_key_dist', (msg: { senderAegisId?: string }) => resolve(msg));
    });

    // Attacker (distributor socket) stamps the VICTIM's id as the distributor.
    const ackOk = await new Promise<boolean>((resolve) => {
      distSock.emit(
        'work:sender_key_dist',
        {
          channelId,
          orgId,
          recipients: [{
            aegisId: recipient.aegisId,
            ciphertextB64: encodeBase64(nacl.randomBytes(48)),
            nonceB64: encodeBase64(nacl.randomBytes(32)),
            iteration: 0,
            senderAegisId: victim.aegisId, // <-- spoof attempt
          }],
        },
        (res: { ok: boolean }) => resolve(res.ok),
      );
    });
    expect(ackOk).toBe(true);

    const msg = await received;
    // The relay must overwrite the spoofed field with the authenticated emitter.
    expect(msg.senderAegisId).toBe(distributor.aegisId);
    expect(msg.senderAegisId).not.toBe(victim.aegisId);

    distSock.disconnect();
    recSock.disconnect();
  }, 20_000);
});
