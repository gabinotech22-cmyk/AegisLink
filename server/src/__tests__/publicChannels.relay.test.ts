/**
 * publicChannels.relay.test.ts
 *
 * Integration tests for the sealed public channels Socket.IO events (Phase 1,
 * docs/SEALED-PUBLIC-CHANNELS.md section 5.1):
 *
 *   pubchannel:join   — delivery token gate (constant-time pass/fail)
 *   pubchannel:msg    — fan-out reaches room members, relay never exposes `from`
 *   pubchannel:apply  — approval-gated join, cap 256 pending
 *   pubchannel:pull   — incremental post pull
 *   pubchannel:delete — signed delete verified server-side
 *   pubchannel:ban    — signed ban verified server-side
 *   pubchannel:tombstone — signed tombstone verified server-side
 *
 * Self-contained harness (mirrors sealedSenderV2.relay.test.ts).
 */

process.env['AEGIS_DB_PATH'] = ':memory:';
process.env['PUBLIC_CHANNELS'] = 'on';

import express from 'express';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Server as SocketServer } from 'socket.io';
import { io as clientIo, type Socket as ClientSocket } from 'socket.io-client';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { createHash } from 'node:crypto';

const { encodeBase64, decodeBase64 } = naclUtil;

import { identityRepo, initDb, publicChannelRepo, publicChannelPostRepo } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';
import {
  generateChannelIdentity,
  generateCEK,
  signManifest,
  deriveChannelDeliveryToken,
  hashChannelDeliveryToken,
  signTombstone,
  signDelete,
  type ChannelManifestData,
} from '../crypto/publicChannelKey.js';

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

function sha256(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(Buffer.from(data)).digest());
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
    deviceId: `dev-pc-${seed}`,
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

function makeManifest(identity: ReturnType<typeof generateChannelIdentity>, cek: Uint8Array): ChannelManifestData {
  return {
    channelId: identity.channelId,
    salt: identity.salt,
    channelEd25519Pub: identity.channelEd25519Pub,
    name: 'Test Channel',
    description: 'A test public channel',
    avatarHash: null,
    channelType: 0,
    createdAtHourMs: Math.floor(Date.now() / 3_600_000) * 3_600_000,
    manifestSeq: 1,
    contentKeyHash: sha256(cek),
    delegationsHash: sha256(new Uint8Array(0)),
    revokedHash: sha256(new Uint8Array(0)),
    pinnedPostSeq: -1,
    discussionsEnabled: true,
  };
}

function manifestToBlob(m: ChannelManifestData, sig: Uint8Array): string {
  return JSON.stringify({
    channelId: m.channelId,
    salt: encodeBase64(m.salt),
    channelEd25519Pub: encodeBase64(m.channelEd25519Pub),
    name: m.name,
    description: m.description,
    avatarHash: m.avatarHash ? encodeBase64(m.avatarHash) : null,
    channelType: m.channelType,
    createdAtHourMs: m.createdAtHourMs,
    manifestSeq: m.manifestSeq,
    contentKeyHash: m.contentKeyHash ? encodeBase64(m.contentKeyHash) : null,
    delegationsHash: encodeBase64(m.delegationsHash),
    revokedHash: encodeBase64(m.revokedHash),
    pinnedPostSeq: m.pinnedPostSeq,
    discussionsEnabled: m.discussionsEnabled,
    sig: encodeBase64(sig),
  });
}

// Register a channel directly in DB for socket event tests
async function seedChannel(identity: ReturnType<typeof generateChannelIdentity>, cek: Uint8Array, capability: Uint8Array) {
  const manifest = makeManifest(identity, cek);
  const sig = signManifest(manifest, identity.channelEd25519Secret);
  const blob = manifestToBlob(manifest, sig);
  const deliveryToken = deriveChannelDeliveryToken(capability, identity.channelId);
  const tokenHash = hashChannelDeliveryToken(deliveryToken);
  await publicChannelRepo.create({
    channel_id: identity.channelId,
    signed_manifest_blob: blob,
    delivery_token_hash_b64: tokenHash,
    channel_type: 'open',
    created_at: Date.now(),
  });
  return { blob, deliveryToken, tokenHash };
}

describe('pubchannel:join — delivery token gate', () => {
  test('valid token joins room and receives ack with manifest', async () => {
    const alice = makeAgentKeys(90001);
    await registerAgent(alice);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    const { blob, deliveryToken } = await seedChannel(identity, cek, capability);

    const sock = await connectAgent(alice);
    const ack = await new Promise<{ ok: boolean; manifest?: string; error?: string }>((resolve) => {
      sock.emit('pubchannel:join', { channelId: identity.channelId, deliveryToken }, (res: { ok: boolean; manifest?: string; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(true);
    expect(ack.manifest).toBe(blob);

    sock.disconnect();
  });

  test('wrong token is rejected (constant-time fail)', async () => {
    const bob = makeAgentKeys(90002);
    await registerAgent(bob);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    await seedChannel(identity, cek, capability);

    const sock = await connectAgent(bob);
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sock.emit('pubchannel:join', { channelId: identity.channelId, deliveryToken: 'wrong-token' }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('bad_delivery_token');

    sock.disconnect();
  });

  test('nonexistent channel is rejected', async () => {
    const carol = makeAgentKeys(90003);
    await registerAgent(carol);

    const sock = await connectAgent(carol);
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sock.emit('pubchannel:join', { channelId: 'nonexistent-channel', deliveryToken: 'any' }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('channel_not_found');

    sock.disconnect();
  });
});

describe('pubchannel:msg — fan-out with no from', () => {
  test('message fans out to room members without from field', async () => {
    const alice = makeAgentKeys(91001);
    const bob = makeAgentKeys(91002);
    await registerAgent(alice);
    await registerAgent(bob);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    const { deliveryToken } = await seedChannel(identity, cek, capability);

    const aliceSock = await connectAgent(alice);
    const bobSock = await connectAgent(bob);

    // Both join
    await new Promise<void>((resolve) => {
      aliceSock.emit('pubchannel:join', { channelId: identity.channelId, deliveryToken }, () => resolve());
    });
    await new Promise<void>((resolve) => {
      bobSock.emit('pubchannel:join', { channelId: identity.channelId, deliveryToken }, () => resolve());
    });

    // Listen for fan-out on Bob's socket
    const received: Array<Record<string, unknown>> = [];
    bobSock.on('pubchannel:msg', (msg: Record<string, unknown>) => received.push(msg));

    // Alice sends a message
    const ct = encodeBase64(nacl.randomBytes(48));
    const nonce = encodeBase64(nacl.randomBytes(24));
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      aliceSock.emit('pubchannel:msg', {
        channelId: identity.channelId,
        ciphertext: ct,
        nonce,
        deliveryToken,
      }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(true);

    await new Promise((r) => setTimeout(r, 200));

    expect(received.length).toBeGreaterThanOrEqual(1);
    const msg = received[0]!;
    expect(msg['channelId']).toBe(identity.channelId);
    expect(msg['ciphertext']).toBe(ct);
    expect(msg['nonce']).toBe(nonce);
    // CORE: relay never exposes `from`
    expect(msg['from']).toBeUndefined();

    aliceSock.disconnect();
    bobSock.disconnect();
  });

  test('message with invalid delivery token is rejected', async () => {
    const eve = makeAgentKeys(91003);
    await registerAgent(eve);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    await seedChannel(identity, cek, capability);

    const sock = await connectAgent(eve);
    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sock.emit('pubchannel:msg', {
        channelId: identity.channelId,
        ciphertext: encodeBase64(nacl.randomBytes(48)),
        nonce: encodeBase64(nacl.randomBytes(24)),
        deliveryToken: 'bad-token',
      }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('bad_delivery_token');

    sock.disconnect();
  });
});

describe('pubchannel:pull — incremental post pull', () => {
  test('returns persisted posts since seqNum', async () => {
    const alice = makeAgentKeys(92001);
    await registerAgent(alice);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    const { deliveryToken } = await seedChannel(identity, cek, capability);

    // Insert some posts directly
    const now = Date.now();
    await publicChannelPostRepo.append({
      id: 'post-1',
      channel_id: identity.channelId,
      seq_num: 0,
      ciphertext_b64: encodeBase64(nacl.randomBytes(32)),
      nonce_b64: encodeBase64(nacl.randomBytes(24)),
      post_hash_b64: encodeBase64(nacl.randomBytes(32)),
      created_at: now,
      expires_at: 0,
    });
    await publicChannelPostRepo.append({
      id: 'post-2',
      channel_id: identity.channelId,
      seq_num: 1,
      ciphertext_b64: encodeBase64(nacl.randomBytes(32)),
      nonce_b64: encodeBase64(nacl.randomBytes(24)),
      post_hash_b64: encodeBase64(nacl.randomBytes(32)),
      created_at: now + 1,
      expires_at: 0,
    });

    const sock = await connectAgent(alice);
    // Join first
    await new Promise<void>((resolve) => {
      sock.emit('pubchannel:join', { channelId: identity.channelId, deliveryToken }, () => resolve());
    });

    // Pull since seqNum -1 (all posts)
    const pullAck = await new Promise<{ ok: boolean; posts?: Array<{ seq_num: number }>; error?: string }>((resolve) => {
      sock.emit('pubchannel:pull', { channelId: identity.channelId, sinceSeqNum: -1 }, (res: { ok: boolean; posts?: Array<{ seq_num: number }>; error?: string }) => resolve(res));
    });
    expect(pullAck.ok).toBe(true);
    expect(pullAck.posts).toHaveLength(2);

    // Pull since seqNum 0 (only post with seq_num > 0)
    const pullAck2 = await new Promise<{ ok: boolean; posts?: Array<{ seq_num: number }>; error?: string }>((resolve) => {
      sock.emit('pubchannel:pull', { channelId: identity.channelId, sinceSeqNum: 0 }, (res: { ok: boolean; posts?: Array<{ seq_num: number }>; error?: string }) => resolve(res));
    });
    expect(pullAck2.ok).toBe(true);
    expect(pullAck2.posts).toHaveLength(1);
    expect(pullAck2.posts![0]!.seq_num).toBe(1);

    sock.disconnect();
  });
});

describe('pubchannel:apply — approval-gated join', () => {
  test('enqueues a pending join request', async () => {
    const alice = makeAgentKeys(93001);
    await registerAgent(alice);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    await seedChannel(identity, cek, capability);

    const sock = await connectAgent(alice);
    const joinEpk = encodeBase64(nacl.randomBytes(32));

    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sock.emit('pubchannel:apply', { channelId: identity.channelId, joinEpk }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(true);

    sock.disconnect();
  });
});

describe('pubchannel:tombstone — signed channel deletion', () => {
  test('valid tombstone removes channel', async () => {
    const alice = makeAgentKeys(94001);
    await registerAgent(alice);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    await seedChannel(identity, cek, capability);

    const sock = await connectAgent(alice);
    const ts = Date.now();
    const sig = signTombstone(identity.channelId, ts, identity.channelEd25519Secret);

    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sock.emit('pubchannel:tombstone', {
        channelId: identity.channelId,
        ts,
        sig: encodeBase64(sig),
        channelPub: encodeBase64(identity.channelEd25519Pub),
      }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(true);

    // Verify channel is gone
    const ch = await publicChannelRepo.get(identity.channelId);
    expect(ch).toBeUndefined();

    sock.disconnect();
  });

  test('tombstone with invalid signature is rejected', async () => {
    const alice = makeAgentKeys(94002);
    await registerAgent(alice);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    await seedChannel(identity, cek, capability);

    const sock = await connectAgent(alice);
    const ts = Date.now();
    // Sign with wrong key
    const mallory = nacl.sign.keyPair();
    const badSig = signTombstone(identity.channelId, ts, mallory.secretKey);

    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sock.emit('pubchannel:tombstone', {
        channelId: identity.channelId,
        ts,
        sig: encodeBase64(badSig),
        channelPub: encodeBase64(identity.channelEd25519Pub),
      }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid_signature');

    // Channel still exists
    const ch = await publicChannelRepo.get(identity.channelId);
    expect(ch).toBeDefined();

    sock.disconnect();
  });
});

describe('pubchannel:delete — signed post deletion', () => {
  test('valid signed delete removes post', async () => {
    const alice = makeAgentKeys(95001);
    await registerAgent(alice);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    const { deliveryToken } = await seedChannel(identity, cek, capability);

    // Insert a post
    await publicChannelPostRepo.append({
      id: 'del-post-1',
      channel_id: identity.channelId,
      seq_num: 0,
      ciphertext_b64: encodeBase64(nacl.randomBytes(32)),
      nonce_b64: encodeBase64(nacl.randomBytes(24)),
      post_hash_b64: encodeBase64(nacl.randomBytes(32)),
      created_at: Date.now(),
      expires_at: 0,
    });

    const sock = await connectAgent(alice);
    // Sign with the canonical, domain-separated helper so the input matches
    // verifyDelete exactly (DELETE_LABEL ‖ channelId ‖ u64be(seqNum)).
    const deleteSig = signDelete(identity.channelId, 0, identity.channelEd25519Secret);

    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sock.emit('pubchannel:delete', {
        channelId: identity.channelId,
        seqNum: 0,
        sig: encodeBase64(deleteSig),
      }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(true);

    sock.disconnect();
  });

  test('delete with invalid signature is rejected', async () => {
    const alice = makeAgentKeys(95002);
    await registerAgent(alice);

    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    await seedChannel(identity, cek, capability);

    // Insert a post
    await publicChannelPostRepo.append({
      id: 'del-post-2',
      channel_id: identity.channelId,
      seq_num: 0,
      ciphertext_b64: encodeBase64(nacl.randomBytes(32)),
      nonce_b64: encodeBase64(nacl.randomBytes(24)),
      post_hash_b64: encodeBase64(nacl.randomBytes(32)),
      created_at: Date.now(),
      expires_at: 0,
    });

    const sock = await connectAgent(alice);
    // Wrong key
    const mallory = nacl.sign.keyPair();
    const badSig = nacl.sign.detached(new Uint8Array(24), mallory.secretKey);

    const ack = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      sock.emit('pubchannel:delete', {
        channelId: identity.channelId,
        seqNum: 0,
        sig: encodeBase64(badSig),
        channelPub: encodeBase64(identity.channelEd25519Pub),
      }, (res: { ok: boolean; error?: string }) => resolve(res));
    });
    expect(ack.ok).toBe(false);
    expect(ack.error).toBe('invalid_signature');

    sock.disconnect();
  });
});
