/**
 * AegisLink — Sealed Public Channels REST endpoints (Phase 1)
 *
 * docs/SEALED-PUBLIC-CHANNELS.md section 5.2:
 *   GET  /public-channels                    — directory of signed manifest blobs
 *   GET  /public-channels/:channelId/manifest — single manifest
 *   POST /public-channels                    — register a channel
 *
 * All gated behind the PUBLIC_CHANNELS feature flag (default OFF).
 * The relay never sees plaintext channel content — manifests are opaque
 * signed blobs verified against the channel's Ed25519 public key.
 */

import { Router } from 'express';
import { z } from 'zod';
import { decodeBase64 } from 'tweetnacl-util';
import { publicChannelRepo } from '../db/client.js';
import { verifyManifest, type ChannelManifestData } from '../crypto/publicChannelKey.js';

// ── Feature flag ─────────────────────────────────────────────────────────────

function isPublicChannelsEnabled(): boolean {
  return (process.env['PUBLIC_CHANNELS'] ?? 'off').toLowerCase() === 'on';
}

// ── Zod schemas ──────────────────────────────────────────────────────────────

const RegisterChannelBody = z.object({
  /** JSON-serialized signed manifest blob (contains sig + all manifest fields). */
  signedManifestBlob: z.string().min(1).max(65536),
  /** SHA-256 hash of the channel delivery token, base64-encoded. */
  deliveryTokenHashB64: z.string().min(1).max(128),
  /** Channel type string. */
  channelType: z.enum(['open', 'readonly', 'moderated', 'approval']),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a signed manifest blob and extract the ChannelManifestData + signature
 * for server-side verification. Returns null on any parse failure.
 */
function parseManifestBlob(blobStr: string): { manifest: ChannelManifestData; sig: Uint8Array } | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(blobStr) as Record<string, unknown>;
  } catch {
    return null;
  }

  try {
    const channelId = parsed['channelId'] as string;
    const salt = decodeBase64(parsed['salt'] as string);
    const channelEd25519Pub = decodeBase64(parsed['channelEd25519Pub'] as string);
    const sig = decodeBase64(parsed['sig'] as string);
    const avatarHashRaw = parsed['avatarHash'] as string | null;
    const contentKeyHashRaw = parsed['contentKeyHash'] as string | null;

    const channelTypeMap: Record<number, number> = { 0: 0, 1: 1, 2: 2, 3: 3 };
    const channelTypeNum = channelTypeMap[parsed['channelType'] as number];
    if (channelTypeNum === undefined) return null;

    const manifest: ChannelManifestData = {
      channelId,
      salt,
      channelEd25519Pub,
      name: parsed['name'] as string,
      description: parsed['description'] as string,
      avatarHash: avatarHashRaw ? decodeBase64(avatarHashRaw) : null,
      channelType: channelTypeNum as 0 | 1 | 2 | 3,
      createdAtHourMs: parsed['createdAtHourMs'] as number,
      manifestSeq: parsed['manifestSeq'] as number,
      contentKeyHash: contentKeyHashRaw ? decodeBase64(contentKeyHashRaw) : null,
      delegationsHash: decodeBase64(parsed['delegationsHash'] as string),
      revokedHash: decodeBase64(parsed['revokedHash'] as string),
      pinnedPostSeq: parsed['pinnedPostSeq'] as number,
      discussionsEnabled: parsed['discussionsEnabled'] as boolean,
    };

    return { manifest, sig };
  } catch {
    return null;
  }
}

// ── Router factory ───────────────────────────────────────────────────────────

export function createPublicChannelsRouter(): Router {
  const router = Router();

  // Flag gate middleware — all routes return 404 when disabled.
  router.use((_req, res, next) => {
    if (!isPublicChannelsEnabled()) {
      res.status(404).json({ error: 'FEATURE_DISABLED' });
      return;
    }
    next();
  });

  // GET / — directory of all channels (public, no auth required)
  router.get('/', async (_req, res) => {
    try {
      const channels = await publicChannelRepo.list();
      res.json({ channels });
    } catch {
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });

  // GET /:channelId/manifest — single manifest
  router.get('/:channelId/manifest', async (req, res) => {
    try {
      const channel = await publicChannelRepo.get(req.params['channelId'] as string);
      if (!channel) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      res.json({ signed_manifest_blob: channel.signed_manifest_blob });
    } catch {
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });

  // POST / — register a new channel
  router.post('/', async (req, res) => {
    const parsed = RegisterChannelBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }

    const { signedManifestBlob, deliveryTokenHashB64, channelType } = parsed.data;

    // Parse + verify manifest signature server-side (golden rule #3)
    const result = parseManifestBlob(signedManifestBlob);
    if (!result) {
      res.status(400).json({ error: 'INVALID_MANIFEST' });
      return;
    }

    const { manifest, sig } = result;
    if (!verifyManifest(manifest, sig)) {
      res.status(403).json({ error: 'INVALID_MANIFEST_SIGNATURE' });
      return;
    }

    try {
      await publicChannelRepo.create({
        channel_id: manifest.channelId,
        signed_manifest_blob: signedManifestBlob,
        delivery_token_hash_b64: deliveryTokenHashB64,
        channel_type: channelType,
        created_at: Date.now(),
      });
      res.status(201).json({ channelId: manifest.channelId });
    } catch {
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });

  return router;
}

export default createPublicChannelsRouter;
