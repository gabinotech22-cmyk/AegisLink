/**
 * publicChannelAvatar.test.ts — Slice 2: Channel avatar association
 *
 * Covers:
 *   (a) Owner can associate an avatar (POST /:channelId/avatar) and read it
 *   (b) Non-owner (invalid/missing signature) is REJECTED with 403
 *   (c) Blob size exceeding 256 KB is rejected with 413
 *   (d) GET /:channelId/avatar serves the blob publicly (no auth)
 *   (e) DELETE /:channelId/avatar with valid owner sig clears the avatar
 *   (f) GET returns 404 when no avatar is set or blob is missing
 */

process.env['AEGIS_DB_PATH'] = ':memory:';
process.env['PUBLIC_CHANNELS'] = 'on';

import express from 'express';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { createHash, randomUUID } from 'node:crypto';
import { initDb, closeDb } from '../db/client.js';
import {
  generateChannelIdentity,
  generateCEK,
  signManifest,
  deriveChannelDeliveryToken,
  hashChannelDeliveryToken,
  wrapCEK,
  signAvatarSet,
  signAvatarDelete,
  type ChannelManifestData,
} from '../crypto/publicChannelKey.js';
import { createPublicChannelsRouter } from '../routes/publicChannels.js';

// ── Test infrastructure ─────────────────────────────────────────────────────

const TMP_UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-avatar-test-'));
const UPLOADS_DIR = path.join(TMP_UPLOADS, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// Override cwd so the publicChannels router resolves UPLOADS_DIR correctly.
const _origCwd = process.cwd.bind(process);

let httpServer: Server;
let serverUrl: string;

function sha256(data: Uint8Array): Uint8Array {
  return Uint8Array.from(createHash('sha256').update(Buffer.from(data)).digest());
}

function makeManifest(
  identity: ReturnType<typeof generateChannelIdentity>,
  cek: Uint8Array,
): ChannelManifestData {
  return {
    channelId: identity.channelId,
    salt: identity.salt,
    channelEd25519Pub: identity.channelEd25519Pub,
    name: 'Avatar Test Channel',
    description: 'Testing avatar association',
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

/** Register a channel and return its identity + channelId. */
async function registerChannel() {
  const identity = generateChannelIdentity();
  const cek = generateCEK();
  const capability = nacl.randomBytes(32);
  const manifest = makeManifest(identity, cek);
  const sig = signManifest(manifest, identity.channelEd25519Secret);
  const blob = manifestToBlob(manifest, sig);
  const deliveryToken = deriveChannelDeliveryToken(capability, identity.channelId);
  const tokenHash = hashChannelDeliveryToken(deliveryToken);
  const contentKeyEnvelope = JSON.stringify(wrapCEK(cek, capability, identity.channelId));

  const res = await fetch(`${serverUrl}/public-channels`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      signedManifestBlob: blob,
      deliveryTokenHashB64: tokenHash,
      channelType: 'open',
      contentKeyEnvelope,
    }),
  });
  expect(res.status).toBe(201);
  return identity;
}

/** Write a fake blob file into the uploads dir and return its "blobId". */
function writeFakeBlob(sizeBytes: number): string {
  const blobId = randomUUID();
  const data = Buffer.alloc(sizeBytes, 0x42);
  fs.writeFileSync(path.join(UPLOADS_DIR, blobId), data);
  return blobId;
}

// ── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  (process as NodeJS.Process & { cwd: () => string }).cwd = () => TMP_UPLOADS;
  await initDb();
  const app = express();
  app.use(express.json({ limit: '64kb' }));
  app.use('/public-channels', createPublicChannelsRouter());
  httpServer = createServer(app);
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', () => resolve());
  });
  const { port } = httpServer.address() as AddressInfo;
  serverUrl = `http://127.0.0.1:${port}`;
}, 15_000);

afterAll(async () => {
  (process as NodeJS.Process & { cwd: () => string }).cwd = _origCwd;
  await new Promise<void>((resolve) => {
    httpServer.close(() => resolve());
  });
  await closeDb();
  fs.rmSync(TMP_UPLOADS, { recursive: true, force: true });
}, 10_000);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Slice 2 — channel avatar association', () => {
  test('(a) owner can associate an avatar and read it back', async () => {
    const identity = await registerChannel();
    const blobId = writeFakeBlob(1024); // 1 KB — well within limits

    // Sign the avatar-set action
    const sig = signAvatarSet(
      identity.channelId,
      blobId,
      identity.channelEd25519Secret,
    );
    const sigB64 = encodeBase64(sig);

    // POST to associate
    const setRes = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId, sigB64 }),
      },
    );
    expect(setRes.status).toBe(200);
    const setBody = (await setRes.json()) as { ok: boolean };
    expect(setBody.ok).toBe(true);

    // GET to read back
    const getRes = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
    );
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get('x-content-type-options')).toBe('nosniff');
    // The body should be the blob bytes (1024 bytes of 0x42)
    const buf = Buffer.from(await getRes.arrayBuffer());
    expect(buf.length).toBe(1024);
    expect(buf[0]).toBe(0x42);
  });

  test('(b) non-owner (invalid signature) is rejected with 403', async () => {
    const identity = await registerChannel();
    const blobId = writeFakeBlob(512);

    // Sign with a DIFFERENT key (mallory)
    const mallory = nacl.sign.keyPair();
    const badSig = signAvatarSet(identity.channelId, blobId, mallory.secretKey);
    const sigB64 = encodeBase64(badSig);

    const res = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId, sigB64 }),
      },
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('INVALID_SIGNATURE');
  });

  test('(b2) missing signature field is rejected with 400', async () => {
    const identity = await registerChannel();
    const blobId = writeFakeBlob(512);

    const res = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId }),
      },
    );
    expect(res.status).toBe(400);
  });

  test('(c) blob exceeding 256 KB is rejected with 413', async () => {
    const identity = await registerChannel();
    const blobId = writeFakeBlob(256 * 1024 + 1); // 1 byte over

    const sig = signAvatarSet(
      identity.channelId,
      blobId,
      identity.channelEd25519Secret,
    );
    const sigB64 = encodeBase64(sig);

    const res = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId, sigB64 }),
      },
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('AVATAR_TOO_LARGE');
  });

  test('(d) GET avatar returns 404 when no avatar is set', async () => {
    const identity = await registerChannel();

    const res = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('NO_AVATAR');
  });

  test('(e) owner can delete the avatar', async () => {
    const identity = await registerChannel();
    const blobId = writeFakeBlob(512);

    // Set avatar first
    const setSig = signAvatarSet(
      identity.channelId,
      blobId,
      identity.channelEd25519Secret,
    );
    const setRes = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId, sigB64: encodeBase64(setSig) }),
      },
    );
    expect(setRes.status).toBe(200);

    // Delete avatar
    const delSig = signAvatarDelete(
      identity.channelId,
      identity.channelEd25519Secret,
    );
    const delRes = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sigB64: encodeBase64(delSig) }),
      },
    );
    expect(delRes.status).toBe(200);
    const delBody = (await delRes.json()) as { ok: boolean };
    expect(delBody.ok).toBe(true);

    // Verify avatar is gone
    const getRes = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
    );
    expect(getRes.status).toBe(404);
  });

  test('(e2) non-owner cannot delete the avatar', async () => {
    const identity = await registerChannel();
    const blobId = writeFakeBlob(512);

    // Set avatar with legitimate owner
    const setSig = signAvatarSet(
      identity.channelId,
      blobId,
      identity.channelEd25519Secret,
    );
    await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId, sigB64: encodeBase64(setSig) }),
      },
    );

    // Try to delete with mallory's key
    const mallory = nacl.sign.keyPair();
    const badDelSig = signAvatarDelete(identity.channelId, mallory.secretKey);
    const res = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sigB64: encodeBase64(badDelSig) }),
      },
    );
    expect(res.status).toBe(403);
  });

  test('(f) POST with non-existent blobId returns 400', async () => {
    const identity = await registerChannel();
    const fakeBlobId = randomUUID(); // does not exist on disk

    const sig = signAvatarSet(
      identity.channelId,
      fakeBlobId,
      identity.channelEd25519Secret,
    );
    const sigB64 = encodeBase64(sig);

    const res = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId: fakeBlobId, sigB64 }),
      },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BLOB_NOT_FOUND');
  });

  test('(f2) POST/DELETE on non-existent channel returns 404', async () => {
    const blobId = writeFakeBlob(256);
    const fakeChannelId = encodeBase64(nacl.randomBytes(16));

    const setRes = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(fakeChannelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId, sigB64: encodeBase64(nacl.randomBytes(64)) }),
      },
    );
    expect(setRes.status).toBe(404);

    const delRes = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(fakeChannelId)}/avatar`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sigB64: encodeBase64(nacl.randomBytes(64)) }),
      },
    );
    expect(delRes.status).toBe(404);
  });

  test('owner can replace an avatar (update)', async () => {
    const identity = await registerChannel();
    const blobId1 = writeFakeBlob(512);
    const blobId2 = writeFakeBlob(768);

    // Set first avatar
    const sig1 = signAvatarSet(identity.channelId, blobId1, identity.channelEd25519Secret);
    const r1 = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId: blobId1, sigB64: encodeBase64(sig1) }),
      },
    );
    expect(r1.status).toBe(200);

    // Replace with second avatar
    const sig2 = signAvatarSet(identity.channelId, blobId2, identity.channelEd25519Secret);
    const r2 = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId: blobId2, sigB64: encodeBase64(sig2) }),
      },
    );
    expect(r2.status).toBe(200);

    // GET should return the SECOND blob's bytes (768 bytes)
    const getRes = await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
    );
    expect(getRes.status).toBe(200);
    const buf = Buffer.from(await getRes.arrayBuffer());
    expect(buf.length).toBe(768);
  });

  test('avatar_blob_id appears in directory listing', async () => {
    const identity = await registerChannel();
    const blobId = writeFakeBlob(128);

    // Set avatar
    const sig = signAvatarSet(identity.channelId, blobId, identity.channelEd25519Secret);
    await fetch(
      `${serverUrl}/public-channels/${encodeURIComponent(identity.channelId)}/avatar`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ blobId, sigB64: encodeBase64(sig) }),
      },
    );

    const listRes = await fetch(`${serverUrl}/public-channels`);
    const listBody = (await listRes.json()) as {
      channels: Array<{ channel_id: string; avatar_blob_id: string | null }>;
    };
    const row = listBody.channels.find((c) => c.channel_id === identity.channelId);
    expect(row).toBeDefined();
    expect(row!.avatar_blob_id).toBe(blobId);
  });
});
