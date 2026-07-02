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
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import naclUtil from 'tweetnacl-util';
import fs from 'node:fs';
import path from 'node:path';
import { publicChannelRepo } from '../db/client.js';
import {
  verifyManifest,
  extractChannelSignerPub,
  verifyAvatarSet,
  verifyAvatarDelete,
  type ChannelManifestData,
} from '../crypto/publicChannelKey.js';

// tweetnacl-util is a CommonJS module: import the default export and destructure,
// so the binding resolves under Node's native ESM loader. Production runs via
// `node --import tsx` (ESM), where `import { decodeBase64 } from 'tweetnacl-util'`
// is NOT a valid named export and crashes boot. Every other server module
// (challenge.ts, relay/handler.ts, publicChannelKey.ts) uses this default import.
const { decodeBase64 } = naclUtil;

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
  /**
   * Wrapped CEK envelope (JSON {ivB64,wrappedB64}) the relay stores opaquely and
   * returns on join so a capability-holder can unwrap the CEK (docs §4.2/§10.1).
   * Optional only for forward-compat; a real channel always has one.
   */
  contentKeyEnvelope: z.string().max(4096).optional(),
});

/** Phase 4 — manifest update body (owner rename/edit-description/pin). */
const UpdateManifestBody = z.object({
  /** The full replacement signed manifest blob (same shape as registration). */
  signedManifestBlob: z.string().min(1).max(65536),
});

/** Slice 2 — avatar association request body. Owner-authenticated via Ed25519 sig. */
const SetAvatarBody = z.object({
  /** Blob store ID returned by POST /blob/upload. */
  blobId: z.string().min(1).max(128),
  /** base64-encoded Ed25519 signature over domain-separated (channelId ‖ blobId). */
  sigB64: z.string().min(1).max(256),
});

/** Slice 2 — avatar deletion request body. Owner-authenticated via Ed25519 sig. */
const DeleteAvatarBody = z.object({
  /** base64-encoded Ed25519 signature over domain-separated (channelId). */
  sigB64: z.string().min(1).max(256),
});

/** Maximum avatar blob size: 256 KB (256px avatar, PNG/WebP). */
const MAX_AVATAR_BYTES = 256 * 1024;

/** Uploads directory (same as blob store). Lazily resolved so tests can override cwd. */
function getUploadsDir(): string {
  return path.join(process.cwd(), 'uploads');
}

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

  // ── Rate limiters (golden rule: rate-limit every endpoint) ──────────────────
  // express-rate-limit keys on the client IP internally; that IP is NEVER
  // written to SQLite or any application log — the store is in-memory and
  // ephemeral, so zero-metadata holds. Maxes are ops-tunable via env; defaults
  // are strict-but-CI-safe. Defined per factory call so counters are isolated
  // per router instance (test isolation) and pick up env overrides at call time.
  const createLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes — anti-squatting on channel creation
    max: Number(process.env['AEGIS_PUBCHANNEL_CREATE_RATELIMIT_MAX'] ?? 50),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 15 * 60 * 1000 });
    },
  });
  const avatarWriteLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // owner-authed avatar set/delete
    max: Number(process.env['AEGIS_PUBCHANNEL_AVATAR_RATELIMIT_MAX'] ?? 100),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 15 * 60 * 1000 });
    },
  });
  const readLimiter = rateLimit({
    windowMs: 60 * 1000, // directory / manifest / avatar reads — flood guard
    max: Number(process.env['AEGIS_PUBCHANNEL_READ_RATELIMIT_MAX'] ?? 200),
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
    },
  });

  // Flag gate middleware — all routes return 404 when disabled.
  router.use((_req, res, next) => {
    if (!isPublicChannelsEnabled()) {
      res.status(404).json({ error: 'FEATURE_DISABLED' });
      return;
    }
    next();
  });

  // GET / — directory of all channels (public, no auth required)
  router.get('/', readLimiter, async (_req, res) => {
    try {
      const channels = await publicChannelRepo.list();
      res.json({ channels });
    } catch {
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });

  // GET /:channelId/manifest — single manifest
  router.get('/:channelId/manifest', readLimiter, async (req, res) => {
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
  router.post('/', createLimiter, async (req, res) => {
    const parsed = RegisterChannelBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }

    const { signedManifestBlob, deliveryTokenHashB64, channelType, contentKeyEnvelope } = parsed.data;

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
        content_key_envelope: contentKeyEnvelope ?? '',
        created_at: Date.now(),
        avatar_blob_id: null,
      });
      res.status(201).json({ channelId: manifest.channelId });
    } catch {
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });

  // PUT /:channelId/manifest — replace the signed manifest (owner rename/edit).
  // Owner-authenticated cryptographically: the NEW blob must verify against the
  // signing key extracted from the STORED manifest (never from the wire, golden
  // rules #3/#7), bind to the same channelId/salt/pubkey, and strictly increase
  // manifestSeq (replay/rollback guard).
  router.put('/:channelId/manifest', avatarWriteLimiter, async (req, res) => {
    const bodyParsed = UpdateManifestBody.safeParse(req.body);
    if (!bodyParsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    const channelId = req.params['channelId'] as string;

    try {
      const channel = await publicChannelRepo.get(channelId);
      if (!channel) {
        res.status(404).json({ error: 'NOT_FOUND' });
        return;
      }
      const oldParsed = parseManifestBlob(channel.signed_manifest_blob);
      if (!oldParsed) {
        res.status(500).json({ error: 'SERVER_ERROR' });
        return;
      }

      const newParsed = parseManifestBlob(bodyParsed.data.signedManifestBlob);
      if (!newParsed) {
        res.status(400).json({ error: 'INVALID_MANIFEST' });
        return;
      }
      const { manifest: next, sig } = newParsed;
      const prev = oldParsed.manifest;

      // Identity binding: same channel, same key, same salt — an update can
      // change name/description/type/pins, never the channel identity.
      if (
        next.channelId !== channelId ||
        Buffer.compare(Buffer.from(next.channelEd25519Pub), Buffer.from(prev.channelEd25519Pub)) !== 0 ||
        Buffer.compare(Buffer.from(next.salt), Buffer.from(prev.salt)) !== 0
      ) {
        res.status(403).json({ error: 'CHANNEL_IDENTITY_MISMATCH' });
        return;
      }

      // Signature check against the AUTHORITATIVE (stored) key.
      if (!verifyManifest(next, sig)) {
        res.status(403).json({ error: 'INVALID_MANIFEST_SIGNATURE' });
        return;
      }

      // Rollback guard: seq must strictly increase.
      if (!(next.manifestSeq > prev.manifestSeq)) {
        res.status(409).json({ error: 'STALE_MANIFEST_SEQ' });
        return;
      }

      await publicChannelRepo.updateManifest(channelId, bodyParsed.data.signedManifestBlob);
      res.json({ ok: true, manifestSeq: next.manifestSeq });
    } catch {
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });

  // ── Slice 2: Channel avatar endpoints ──────────────────────────────────────

  // POST /:channelId/avatar — associate a blob-store avatar with a channel.
  // Owner-authenticated: requires Ed25519 sig over (channelId ‖ blobId) verified
  // against the channel's signing key extracted from the stored manifest.
  router.post('/:channelId/avatar', avatarWriteLimiter, async (req, res) => {
    const channelId = req.params['channelId'] as string;
    const parsed = SetAvatarBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }

    const { blobId, sigB64 } = parsed.data;

    // Fetch channel to extract the authoritative signer pub from the stored manifest.
    const channel = await publicChannelRepo.get(channelId);
    if (!channel) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    const signerPub = extractChannelSignerPub(channel.signed_manifest_blob);
    if (!signerPub) {
      res.status(500).json({ error: 'SERVER_ERROR' });
      return;
    }

    // Verify owner signature (golden rule #3: proof of possession).
    let sig: Uint8Array;
    try { sig = decodeBase64(sigB64); } catch {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }

    if (!verifyAvatarSet(channelId, blobId, sig, signerPub)) {
      res.status(403).json({ error: 'INVALID_SIGNATURE' });
      return;
    }

    // Verify the blob exists in the blob store and is within size limits.
    const blobPath = path.join(getUploadsDir(), blobId);
    try {
      const stat = fs.statSync(blobPath);
      if (stat.size > MAX_AVATAR_BYTES) {
        res.status(413).json({ error: 'AVATAR_TOO_LARGE' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'BLOB_NOT_FOUND' });
      return;
    }

    try {
      await publicChannelRepo.setAvatarBlobId(channelId, blobId);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });

  // DELETE /:channelId/avatar — remove the avatar association.
  // Owner-authenticated: requires Ed25519 sig over domain-separated (channelId).
  router.delete('/:channelId/avatar', avatarWriteLimiter, async (req, res) => {
    const channelId = req.params['channelId'] as string;
    const parsed = DeleteAvatarBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }

    const { sigB64 } = parsed.data;

    const channel = await publicChannelRepo.get(channelId);
    if (!channel) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    const signerPub = extractChannelSignerPub(channel.signed_manifest_blob);
    if (!signerPub) {
      res.status(500).json({ error: 'SERVER_ERROR' });
      return;
    }

    let sig: Uint8Array;
    try { sig = decodeBase64(sigB64); } catch {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }

    if (!verifyAvatarDelete(channelId, sig, signerPub)) {
      res.status(403).json({ error: 'INVALID_SIGNATURE' });
      return;
    }

    try {
      await publicChannelRepo.setAvatarBlobId(channelId, null);
      res.json({ ok: true });
    } catch {
      res.status(500).json({ error: 'SERVER_ERROR' });
    }
  });

  // GET /:channelId/avatar — serve the avatar bytes publicly (no auth required).
  // No metadata logged (golden rule #10): no IP, no requester identity.
  router.get('/:channelId/avatar', readLimiter, async (req, res) => {
    const channelId = req.params['channelId'] as string;

    const blobId = await publicChannelRepo.getAvatarBlobId(channelId);
    if (!blobId) {
      res.status(404).json({ error: 'NO_AVATAR' });
      return;
    }

    const blobPath = path.join(getUploadsDir(), blobId);
    if (!fs.existsSync(blobPath)) {
      res.status(404).json({ error: 'BLOB_EXPIRED' });
      return;
    }

    // Serve as image with cache headers. Avatars are public branding content.
    res.set('Content-Type', 'application/octet-stream');
    res.set('Cache-Control', 'public, max-age=3600, immutable');
    res.set('X-Content-Type-Options', 'nosniff');
    res.sendFile(blobPath);
  });

  return router;
}

export default createPublicChannelsRouter;
