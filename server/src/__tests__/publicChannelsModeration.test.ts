/**
 * publicChannelsModeration.test.ts — Phase 4 (moderation + approval-gated joins)
 *
 *   PUT /public-channels/:id/manifest — owner rename/edit, seq rollback guard,
 *                                       identity binding, signature check
 *   pubchannel:pending        — owner-signed listing of un-answered requests
 *   pubchannel:approve        — approve seals the envelope / reject drops the row
 *   pubchannel:check_approval — applicant claims the envelope exactly once
 *
 * Self-contained harness (mirrors publicChannels.relay.test.ts).
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

import { identityRepo, initDb, publicChannelRepo, publicChannelJoinRepo } from '../db/client.js';
import { attachRelay } from '../relay/handler.js';
import { createPublicChannelsRouter } from '../routes/publicChannels.js';
import {
  generateChannelIdentity,
  generateCEK,
  signManifest,
  signPendingList,
  signApprove,
  deriveChannelDeliveryToken,
  hashChannelDeliveryToken,
  wrapCEK,
  type ChannelManifestData,
} from '../crypto/publicChannelKey.js';

// ── helpers (aegisId + agent identity, mirrored from the relay test) ─────────

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
    deviceId: `dev-mod-${seed}`,
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

function makeManifest(
  identity: ReturnType<typeof generateChannelIdentity>,
  cek: Uint8Array,
  overrides: Partial<ChannelManifestData> = {},
): ChannelManifestData {
  return {
    channelId: identity.channelId,
    salt: identity.salt,
    channelEd25519Pub: identity.channelEd25519Pub,
    name: 'Moderated Channel',
    description: 'Phase 4 test channel',
    avatarHash: null,
    channelType: 3, // approval
    createdAtHourMs: Math.floor(Date.now() / 3_600_000) * 3_600_000,
    manifestSeq: 1,
    contentKeyHash: sha256(cek),
    delegationsHash: sha256(new Uint8Array(0)),
    revokedHash: sha256(new Uint8Array(0)),
    pinnedPostSeq: -1,
    discussionsEnabled: true,
    ...overrides,
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

async function seedChannel(identity: ReturnType<typeof generateChannelIdentity>, cek: Uint8Array, capability: Uint8Array) {
  const manifest = makeManifest(identity, cek);
  const sig = signManifest(manifest, identity.channelEd25519Secret);
  const blob = manifestToBlob(manifest, sig);
  const deliveryToken = deriveChannelDeliveryToken(capability, identity.channelId);
  await publicChannelRepo.create({
    channel_id: identity.channelId,
    signed_manifest_blob: blob,
    delivery_token_hash_b64: hashChannelDeliveryToken(deliveryToken),
    channel_type: 'approval',
    content_key_envelope: JSON.stringify(wrapCEK(cek, capability, identity.channelId)),
    created_at: Date.now(),
  });
  return { blob, manifest };
}

let httpServer: ReturnType<typeof createServer>;
let io: SocketServer;
let serverUrl: string;
let sock: ClientSocket;

beforeAll(async () => {
  await initDb();
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/public-channels', createPublicChannelsRouter());
  httpServer = createServer(app);
  io = new SocketServer(httpServer, { cors: { origin: '*' } });
  attachRelay(io);
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;

  // One authenticated socket shared by all relay tests below.
  const agent = makeAgentKeys(94001);
  await identityRepo.insert({
    aegis_id: agent.aegisId,
    public_key_b64: encodeBase64(agent.boxKeyPair.publicKey),
    signing_public_key_b64: encodeBase64(agent.signKeyPair.publicKey),
    created_at: Date.now(),
  });
  sock = await new Promise<ClientSocket>((resolve, reject) => {
    const socket = clientIo(serverUrl, {
      auth: { aegisId: agent.aegisId, platform: 'mobile', deviceId: agent.deviceId },
      transports: ['websocket'],
      reconnection: false,
    });
    const timer = setTimeout(() => { socket.disconnect(); reject(new Error('Auth timeout')); }, 8_000);
    socket.on('auth:challenge', (wire: { ephemeralPubKey: string; nonce: string; ciphertext: string }) => {
      socket.emit('auth:response', { plain: solveChallenge(wire, agent.boxKeyPair.secretKey) });
    });
    socket.on('auth:ok', () => { clearTimeout(timer); resolve(socket); });
    socket.on('connect_error', (err: Error) => { clearTimeout(timer); reject(err); });
  });
}, 30_000);

afterAll(async () => {
  sock?.disconnect();
  io.disconnectSockets(true);
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => { io.close(() => resolve()); });
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
  await new Promise((resolve) => setTimeout(resolve, 50));
}, 10_000);

function emit<T>(event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve) => { sock.emit(event, payload, (res: T) => resolve(res)); });
}

function apply(channelId: string): Promise<{ ok: boolean; error?: string; joinEpk: string }> {
  const eph = nacl.box.keyPair();
  const joinEpk = encodeBase64(eph.publicKey);
  return emit<{ ok: boolean; error?: string }>('pubchannel:apply', { channelId, joinEpk })
    .then((res) => ({ ...res, joinEpk }));
}

// ── PUT /:channelId/manifest — owner rename / edit description ───────────────

describe('PUT /public-channels/:id/manifest', () => {
  test('owner-signed update with seq+1 replaces the stored manifest', async () => {
    const identity = generateChannelIdentity();
    const cek = generateCEK();
    await seedChannel(identity, cek, nacl.randomBytes(32));

    const next = makeManifest(identity, cek, { name: 'Renamed', description: 'New description', manifestSeq: 2 });
    const blob = manifestToBlob(next, signManifest(next, identity.channelEd25519Secret));
    const res = await fetch(`${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/manifest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedManifestBlob: blob }),
    });
    expect(res.status).toBe(200);

    const stored = await publicChannelRepo.get(identity.channelId);
    expect(stored!.signed_manifest_blob).toBe(blob);
  });

  test('rejects a stale or equal manifestSeq (rollback guard)', async () => {
    const identity = generateChannelIdentity();
    const cek = generateCEK();
    await seedChannel(identity, cek, nacl.randomBytes(32)); // stored seq = 1

    const sameSeq = makeManifest(identity, cek, { name: 'Rollback', manifestSeq: 1 });
    const blob = manifestToBlob(sameSeq, signManifest(sameSeq, identity.channelEd25519Secret));
    const res = await fetch(`${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/manifest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedManifestBlob: blob }),
    });
    expect(res.status).toBe(409);
  });

  test('rejects a manifest signed by a non-owner key', async () => {
    const identity = generateChannelIdentity();
    const cek = generateCEK();
    await seedChannel(identity, cek, nacl.randomBytes(32));

    const mallory = nacl.sign.keyPair();
    const next = makeManifest(identity, cek, { name: 'Hijacked', manifestSeq: 2 });
    const blob = manifestToBlob(next, signManifest(next, mallory.secretKey));
    const res = await fetch(`${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/manifest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedManifestBlob: blob }),
    });
    expect(res.status).toBe(403);
  });

  test('rejects an update that swaps the channel signing key (identity binding)', async () => {
    const identity = generateChannelIdentity();
    const cek = generateCEK();
    await seedChannel(identity, cek, nacl.randomBytes(32));

    // Attacker builds a self-consistent manifest (valid sig under HIS key) for
    // the same channelId, trying to take the channel over.
    const attacker = generateChannelIdentity();
    const evil = makeManifest(identity, cek, { manifestSeq: 2 });
    const evilBound: ChannelManifestData = { ...evil, channelEd25519Pub: attacker.channelEd25519Pub };
    const blob = manifestToBlob(evilBound, signManifest(evilBound, attacker.channelEd25519Secret));
    const res = await fetch(`${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/manifest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedManifestBlob: blob }),
    });
    expect(res.status).toBe(403);
  });

  test('owner type change re-syncs the informational channel_type column', async () => {
    const identity = generateChannelIdentity();
    const cek = generateCEK();
    await seedChannel(identity, cek, nacl.randomBytes(32)); // seeded as approval (type 3)

    const next = makeManifest(identity, cek, { channelType: 0, manifestSeq: 2 }); // → open
    const blob = manifestToBlob(next, signManifest(next, identity.channelEd25519Secret));
    const res = await fetch(`${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/manifest`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ signedManifestBlob: blob }),
    });
    expect(res.status).toBe(200);

    const stored = await publicChannelRepo.get(identity.channelId);
    expect(stored!.signed_manifest_blob).toBe(blob);
    expect(stored!.channel_type).toBe('open');
  });
});

// ── pubchannel:pending — owner lists un-answered join requests ───────────────

describe('pubchannel:pending', () => {
  test('owner signature lists pending requests; answered ones are excluded', async () => {
    const identity = generateChannelIdentity();
    await seedChannel(identity, generateCEK(), nacl.randomBytes(32));

    const a = await apply(identity.channelId);
    const b = await apply(identity.channelId);
    expect(a.ok && b.ok).toBe(true);

    // Answer b (attach an envelope) so only a remains in the owner queue.
    await publicChannelJoinRepo.setApprovalEnvelope(b.joinEpk, identity.channelId, '{"sealed":"x"}');

    const ts = Date.now();
    const sig = encodeBase64(signPendingList(identity.channelId, ts, identity.channelEd25519Secret));
    const res = await emit<{ ok: boolean; pending?: Array<{ joinEpk: string }> }>('pubchannel:pending', {
      channelId: identity.channelId, ts, sig,
    });
    expect(res.ok).toBe(true);
    const epks = (res.pending ?? []).map((p) => p.joinEpk);
    expect(epks).toContain(a.joinEpk);
    expect(epks).not.toContain(b.joinEpk);
  });

  test('rejects a non-owner signature and a stale timestamp', async () => {
    const identity = generateChannelIdentity();
    await seedChannel(identity, generateCEK(), nacl.randomBytes(32));

    const mallory = nacl.sign.keyPair();
    const ts = Date.now();
    const bad = await emit<{ ok: boolean; error?: string }>('pubchannel:pending', {
      channelId: identity.channelId, ts, sig: encodeBase64(signPendingList(identity.channelId, ts, mallory.secretKey)),
    });
    expect(bad.ok).toBe(false);
    expect(bad.error).toBe('invalid_signature');

    const staleTs = Date.now() - 10 * 60_000;
    const stale = await emit<{ ok: boolean; error?: string }>('pubchannel:pending', {
      channelId: identity.channelId, ts: staleTs, sig: encodeBase64(signPendingList(identity.channelId, staleTs, identity.channelEd25519Secret)),
    });
    expect(stale.ok).toBe(false);
    expect(stale.error).toBe('stale_timestamp');
  });
});

// ── pubchannel:approve + pubchannel:check_approval — the full loop ───────────

describe('pubchannel:approve / pubchannel:check_approval', () => {
  test('approve attaches the envelope; the applicant claims it exactly once', async () => {
    const identity = generateChannelIdentity();
    await seedChannel(identity, generateCEK(), nacl.randomBytes(32));
    const { joinEpk } = await apply(identity.channelId);

    const envelope = JSON.stringify({ adminEpkB64: 'x', ivB64: 'y', wrappedB64: 'z' });
    const ts = Date.now();
    const approveRes = await emit<{ ok: boolean; error?: string }>('pubchannel:approve', {
      channelId: identity.channelId, joinEpk, envelope, ts,
      sig: encodeBase64(signApprove(identity.channelId, joinEpk, ts, identity.channelEd25519Secret)),
    });
    expect(approveRes.ok).toBe(true);

    // Applicant polls: gets the envelope, and the relay retains nothing after.
    const poll = await emit<{ ok: boolean; status?: string; envelope?: string }>('pubchannel:check_approval', {
      channelId: identity.channelId, joinEpk,
    });
    expect(poll.ok).toBe(true);
    expect(poll.status).toBe('approved');
    expect(poll.envelope).toBe(envelope);
    expect(await publicChannelJoinRepo.get(joinEpk, identity.channelId)).toBeUndefined();
  });

  test('reject drops the request; a later poll reports not_found', async () => {
    const identity = generateChannelIdentity();
    await seedChannel(identity, generateCEK(), nacl.randomBytes(32));
    const { joinEpk } = await apply(identity.channelId);

    const ts = Date.now();
    const rejectRes = await emit<{ ok: boolean }>('pubchannel:approve', {
      channelId: identity.channelId, joinEpk, envelope: '', ts,
      sig: encodeBase64(signApprove(identity.channelId, joinEpk, ts, identity.channelEd25519Secret)),
    });
    expect(rejectRes.ok).toBe(true);

    const poll = await emit<{ ok: boolean; status?: string }>('pubchannel:check_approval', {
      channelId: identity.channelId, joinEpk,
    });
    expect(poll.ok).toBe(true);
    expect(poll.status).toBe('not_found');
  });

  test('approve with a non-owner signature is rejected', async () => {
    const identity = generateChannelIdentity();
    await seedChannel(identity, generateCEK(), nacl.randomBytes(32));
    const { joinEpk } = await apply(identity.channelId);

    const mallory = nacl.sign.keyPair();
    const ts = Date.now();
    const res = await emit<{ ok: boolean; error?: string }>('pubchannel:approve', {
      channelId: identity.channelId, joinEpk, envelope: '{"sealed":"x"}', ts,
      sig: encodeBase64(signApprove(identity.channelId, joinEpk, ts, mallory.secretKey)),
    });
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_signature');
    // The pending row is untouched.
    expect(await publicChannelJoinRepo.get(joinEpk, identity.channelId)).toBeDefined();
  });

  test('check_approval is throttled to 1 poll per 30s per request', async () => {
    const identity = generateChannelIdentity();
    await seedChannel(identity, generateCEK(), nacl.randomBytes(32));
    const { joinEpk } = await apply(identity.channelId);

    const first = await emit<{ ok: boolean; status?: string }>('pubchannel:check_approval', {
      channelId: identity.channelId, joinEpk,
    });
    expect(first.ok).toBe(true);
    expect(first.status).toBe('pending');

    const second = await emit<{ ok: boolean; error?: string }>('pubchannel:check_approval', {
      channelId: identity.channelId, joinEpk,
    });
    expect(second.ok).toBe(false);
    expect(second.error).toBe('rate_limited');
  });
});
