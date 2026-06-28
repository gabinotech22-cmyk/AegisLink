/**
 * publicChannels.routes.test.ts
 *
 * Integration tests for the sealed public channels REST endpoints (Phase 1,
 * docs/SEALED-PUBLIC-CHANNELS.md section 5.2):
 *
 *   GET  /public-channels            — list all signed manifest blobs
 *   GET  /public-channels/:channelId/manifest — single manifest
 *   POST /public-channels            — register a channel (manifest + token hash)
 *
 * Covers:
 *   - Flag-off returns 404/disabled consistently
 *   - Manifest signature rejection (invalid sig)
 *   - Successful registration stores channel + manifest
 *   - GET list returns registered manifests
 *   - GET single returns the correct manifest
 *   - POST with invalid Zod payload returns 400
 */

process.env['AEGIS_DB_PATH'] = ':memory:';
process.env['PUBLIC_CHANNELS'] = 'on'; // default for these tests

import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { initDb } from '../db/client.js';
import {
  generateChannelIdentity,
  generateCEK,
  signManifest,
  deriveChannelDeliveryToken,
  hashChannelDeliveryToken,
  type ChannelManifestData,
} from '../crypto/publicChannelKey.js';
import { createPublicChannelsRouter } from '../routes/publicChannels.js';
import { createHash } from 'node:crypto';

let httpServer: Server;
let serverUrl: string;

function sha256(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(Buffer.from(data)).digest());
}

function makeManifest(identity: ReturnType<typeof generateChannelIdentity>, cek: Uint8Array): ChannelManifestData {
  return {
    channelId: identity.channelId,
    salt: identity.salt,
    channelEd25519Pub: identity.channelEd25519Pub,
    name: 'Test Channel',
    description: 'A test public channel',
    avatarHash: null,
    channelType: 0, // open
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

beforeAll(async () => {
  await initDb();
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/public-channels', createPublicChannelsRouter());
  httpServer = createServer(app);
  await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', () => resolve()); });
  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;
}, 15_000);

afterAll(async () => {
  await new Promise<void>((resolve) => { httpServer.close(() => resolve()); });
}, 10_000);

describe('public-channels REST (flag ON)', () => {
  test('GET /public-channels returns empty list initially', async () => {
    const res = await fetch(`${serverUrl}/public-channels`);
    expect(res.status).toBe(200);
    const body = await res.json() as { channels: unknown[] };
    expect(body.channels).toEqual([]);
  });

  test('POST /public-channels with valid manifest stores channel', async () => {
    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const capability = nacl.randomBytes(32);
    const manifest = makeManifest(identity, cek);
    const sig = signManifest(manifest, identity.channelEd25519Secret);
    const blob = manifestToBlob(manifest, sig);
    const deliveryToken = deriveChannelDeliveryToken(capability, identity.channelId);
    const tokenHash = hashChannelDeliveryToken(deliveryToken);

    const res = await fetch(`${serverUrl}/public-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signedManifestBlob: blob,
        deliveryTokenHashB64: tokenHash,
        channelType: 'open',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as { channelId: string };
    expect(body.channelId).toBe(identity.channelId);

    // Verify it appears in the list
    const listRes = await fetch(`${serverUrl}/public-channels`);
    const listBody = await listRes.json() as { channels: Array<{ channel_id: string }> };
    expect(listBody.channels.length).toBeGreaterThanOrEqual(1);
    expect(listBody.channels.some((c: { channel_id: string }) => c.channel_id === identity.channelId)).toBe(true);

    // Verify single manifest endpoint (URL-encode because channelId is base64, may contain / or +)
    const singleRes = await fetch(`${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/manifest`);
    expect(singleRes.status).toBe(200);
    const singleBody = await singleRes.json() as { signed_manifest_blob: string };
    expect(singleBody.signed_manifest_blob).toBe(blob);
  });

  test('POST /public-channels rejects invalid manifest signature', async () => {
    const identity = generateChannelIdentity();
    const cek = generateCEK();
    const manifest = makeManifest(identity, cek);
    // Sign with a DIFFERENT key
    const mallory = nacl.sign.keyPair();
    const badSig = signManifest(manifest, mallory.secretKey);
    const blob = manifestToBlob(manifest, badSig);

    const res = await fetch(`${serverUrl}/public-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signedManifestBlob: blob,
        deliveryTokenHashB64: 'dummyhash',
        channelType: 'open',
      }),
    });
    expect(res.status).toBe(403);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('INVALID_MANIFEST_SIGNATURE');
  });

  test('POST /public-channels rejects invalid payload (Zod)', async () => {
    const res = await fetch(`${serverUrl}/public-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bad: 'data' }),
    });
    expect(res.status).toBe(400);
  });

  test('GET /public-channels/:channelId/manifest returns 404 for unknown channel', async () => {
    const res = await fetch(`${serverUrl}/public-channels/nonexistent/manifest`);
    expect(res.status).toBe(404);
  });
});

describe('public-channels REST (flag OFF)', () => {
  let offServer: Server;
  let offUrl: string;

  let savedFlag: string | undefined;

  beforeAll(async () => {
    savedFlag = process.env['PUBLIC_CHANNELS'];
    process.env['PUBLIC_CHANNELS'] = 'off';

    const app = express();
    app.use(express.json({ limit: '64kb' }));
    app.use('/public-channels', createPublicChannelsRouter());
    offServer = createServer(app);
    await new Promise<void>((resolve) => { offServer.listen(0, '127.0.0.1', () => resolve()); });
    const { port } = offServer.address() as AddressInfo;
    offUrl = `http://127.0.0.1:${port}`;
  }, 10_000);

  afterAll(async () => {
    // Restore flag so other suites are unaffected
    if (savedFlag !== undefined) process.env['PUBLIC_CHANNELS'] = savedFlag;
    else delete process.env['PUBLIC_CHANNELS'];
    await new Promise<void>((resolve) => { offServer.close(() => resolve()); });
  }, 10_000);

  test('GET returns 404 when flag is off', async () => {
    const res = await fetch(`${offUrl}/public-channels`);
    expect(res.status).toBe(404);
  });

  test('POST returns 404 when flag is off', async () => {
    const res = await fetch(`${offUrl}/public-channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });
});
