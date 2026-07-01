/**
 * blobAvatarTTL.test.ts — Slice 2 regression: avatar blobs survive TTL cleanup
 *
 * Covers:
 *   (a) A blob associated as a channel avatar is NOT deleted by TTL cleanup
 *   (b) An unpinned (orphan) blob older than 24h IS deleted by TTL cleanup
 *   (c) After avatar replacement, the OLD blob becomes deletable
 *   (d) After avatar DELETE, the blob becomes deletable
 */

process.env['AEGIS_DB_PATH'] = ':memory:';
process.env['PUBLIC_CHANNELS'] = 'on';

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { createHash, randomUUID } from 'node:crypto';
import { initDb, closeDb, publicChannelRepo } from '../db/client.js';
import {
  generateChannelIdentity,
  generateCEK,
  signManifest,
  deriveChannelDeliveryToken,
  hashChannelDeliveryToken,
  wrapCEK,
  type ChannelManifestData,
} from '../crypto/publicChannelKey.js';

// ── Test infrastructure ─────────────────────────────────────────────────────

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-avatar-ttl-'));
const UPLOADS_DIR = path.join(TMP_DIR, 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const _origCwd = process.cwd.bind(process);

// We need to import runBlobCleanup from blob.ts, but it captures UPLOADS_DIR
// from process.cwd() at import time. Override cwd BEFORE import.
let runBlobCleanup: typeof import('../routes/blob.js')['runBlobCleanup'];

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
    name: 'TTL Test Channel',
    description: 'Testing avatar TTL exemption',
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

/** Register a channel directly via the repo. */
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

  await publicChannelRepo.create({
    channel_id: identity.channelId,
    signed_manifest_blob: blob,
    delivery_token_hash_b64: tokenHash,
    channel_type: 'open',
    content_key_envelope: contentKeyEnvelope,
    created_at: Date.now(),
    avatar_blob_id: null,
  });
  return identity;
}

/** Write a fake blob file and backdate its mtime to >24h ago. */
function writeOldBlob(sizeBytes: number): string {
  const blobId = randomUUID();
  const data = Buffer.alloc(sizeBytes, 0xab);
  const filePath = path.join(UPLOADS_DIR, blobId);
  fs.writeFileSync(filePath, data);
  // Backdate to 25 hours ago so it is eligible for TTL deletion.
  const pastMs = Date.now() - 25 * 60 * 60 * 1000;
  const pastSec = pastMs / 1000;
  fs.utimesSync(filePath, pastSec, pastSec);
  return blobId;
}

// ── Setup / teardown ────────────────────────────────────────────────────────

beforeAll(async () => {
  (process as NodeJS.Process & { cwd: () => string }).cwd = () => TMP_DIR;
  await initDb();
  // Import blob module AFTER cwd override so UPLOADS_DIR resolves to TMP_DIR/uploads.
  const blobModule = await import('../routes/blob.js');
  runBlobCleanup = blobModule.runBlobCleanup;
}, 15_000);

afterAll(async () => {
  (process as NodeJS.Process & { cwd: () => string }).cwd = _origCwd;
  await closeDb();
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}, 10_000);

// ── Tests ───────────────────────────────────────────────────────────────────

describe('Slice 2 — avatar blob TTL exemption', () => {
  test('(a) pinned avatar blob survives TTL cleanup; (b) unpinned old blob is deleted', async () => {
    const identity = await registerChannel();

    // Create two blobs, both older than 24h.
    const avatarBlobId = writeOldBlob(512);
    const orphanBlobId = writeOldBlob(256);

    // Pin the avatar blob to the channel.
    await publicChannelRepo.setAvatarBlobId(identity.channelId, avatarBlobId);

    // Run cleanup.
    await runBlobCleanup();

    // Avatar blob MUST survive (pinned).
    expect(fs.existsSync(path.join(UPLOADS_DIR, avatarBlobId))).toBe(true);

    // Orphan blob MUST be deleted (not pinned, older than 24h).
    expect(fs.existsSync(path.join(UPLOADS_DIR, orphanBlobId))).toBe(false);
  });

  test('(c) after avatar replacement, the old blob becomes deletable', async () => {
    const identity = await registerChannel();

    const oldBlobId = writeOldBlob(512);
    const newBlobId = writeOldBlob(768);

    // Pin old blob as avatar.
    await publicChannelRepo.setAvatarBlobId(identity.channelId, oldBlobId);

    // Replace with new blob.
    await publicChannelRepo.setAvatarBlobId(identity.channelId, newBlobId);

    // Run cleanup.
    await runBlobCleanup();

    // Old blob is no longer pinned — should be deleted (it is older than 24h).
    expect(fs.existsSync(path.join(UPLOADS_DIR, oldBlobId))).toBe(false);

    // New blob is pinned — should survive.
    expect(fs.existsSync(path.join(UPLOADS_DIR, newBlobId))).toBe(true);
  });

  test('(d) after avatar DELETE, the blob becomes deletable', async () => {
    const identity = await registerChannel();

    const blobId = writeOldBlob(512);

    // Pin blob as avatar.
    await publicChannelRepo.setAvatarBlobId(identity.channelId, blobId);

    // Verify it survives a cleanup while pinned.
    await runBlobCleanup();
    expect(fs.existsSync(path.join(UPLOADS_DIR, blobId))).toBe(true);

    // Delete the avatar (unpin).
    await publicChannelRepo.setAvatarBlobId(identity.channelId, null);

    // Run cleanup again — now the blob is unpinned and old.
    await runBlobCleanup();
    expect(fs.existsSync(path.join(UPLOADS_DIR, blobId))).toBe(false);
  });
});
