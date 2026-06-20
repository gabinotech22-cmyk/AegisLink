import { Router } from 'express';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { issueChallenge, verifyPoW } from '../pow/challenge.js';
import { z } from 'zod';

const router = Router();
const UPLOADS_DIR = path.join(process.cwd(), 'uploads');

// ── Download authorization secret (C-1) ─────────────────────────────────────
// A download must prove it holds a token bound to the blob id, not merely know
// the (122-bit random) UUID. The token is HMAC(BLOB_SECRET, id), minted at
// upload and carried INSIDE the E2EE envelope alongside the key/nonce — so the
// relay can neither enumerate blobs from leaked ids nor serve ciphertext to a
// party who only learned the id (logs, relay DB, etc.).
//
// Fail-closed in production: a missing secret must not silently downgrade to an
// unauthenticated download. In dev/test we synthesize an ephemeral secret so
// the suite and local runs work without configuration (blobs expire in 24h, so
// an ephemeral per-process secret is harmless).
const BLOB_SECRET: Buffer = (() => {
  const fromEnv = process.env['BLOB_SECRET'];
  if (fromEnv && fromEnv.length > 0) return Buffer.from(fromEnv, 'utf8');
  if (process.env['NODE_ENV'] === 'production') {
    throw new Error('BLOB_SECRET is required in production (download authorization)');
  }
  // dev/test: ephemeral, per-process. Tokens stay valid for this process only.
  return crypto.randomBytes(32);
})();

/** Mint the download token bound to a blob id: base64url(HMAC-SHA256)[:22] (~16 bytes). */
function mintDownloadToken(id: string): string {
  return crypto.createHmac('sha256', BLOB_SECRET).update(id).digest('base64url').slice(0, 22);
}

/** Constant-time check that `token` is the valid download token for `id`. */
function isValidDownloadToken(id: string, token: string): boolean {
  const expected = Buffer.from(mintDownloadToken(id), 'utf8');
  const provided = Buffer.from(token, 'utf8');
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Global storage quota ──────────────────────────────────────────────────────
// Maximum aggregate bytes allowed in the uploads directory. Prevents disk-fill
// DoS even when PoW is solved correctly. Cached in memory — updated on every
// upload and every TTL-cleanup pass so we never call du() on each request.
const MAX_TOTAL_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

let currentTotalBytes = 0;

// Initialise the counter once at startup by summing existing files.
(function initStorageCounter() {
  try {
    const files = fs.readdirSync(UPLOADS_DIR);
    for (const file of files) {
      if (file === '.gitkeep') continue;
      try {
        const s = fs.statSync(path.join(UPLOADS_DIR, file));
        currentTotalBytes += s.size;
      } catch { /* ignore */ }
    }
  } catch { /* uploads dir may not exist yet */ }
})();

// ── Rate limiter (per IP) ─────────────────────────────────────────────────────
// A real messenger shares many photos/audios in a single sitting, so 10/15 min
// (the old value) blocked normal use almost immediately. Abuse is already
// constrained by the per-upload Proof-of-Work and the global byte quota, so the
// rate limit only needs to bound bulk-bot floods. 200/15 min (~13/min sustained)
// comfortably covers sharing a photo album while still capping automated abuse.
const UPLOAD_WINDOW_MS = 15 * 60 * 1000;
const uploadLimiter = rateLimit({
  windowMs: UPLOAD_WINDOW_MS,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: UPLOAD_WINDOW_MS });
  },
});

// A lighter limiter for the challenge endpoint.
const challengeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});

// ── PoW upload body schema ────────────────────────────────────────────────────
const UploadPoWSchema = z.object({
  powChallenge: z.string().length(64),
  powNonce: z.string().min(1).max(32).regex(/^[0-9a-f]+$/),
});

// ── GET /blob/challenge ───────────────────────────────────────────────────────
router.get('/challenge', challengeLimiter, (_req, res) => {
  res.json(issueChallenge());
});

// ── POST /blob/upload ─────────────────────────────────────────────────────────
// Requires a valid PoW solution passed as query params alongside the binary body.
router.post('/upload', uploadLimiter, express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  // PoW fields come from query string so we can still accept raw binary body.
  const parsed = UploadPoWSchema.safeParse({
    powChallenge: req.query.powChallenge,
    powNonce: req.query.powNonce,
  });
  if (!parsed.success) {
    res.status(400).json({ error: 'pow_required', issues: parsed.error.issues });
    return;
  }

  const powError = verifyPoW(parsed.data.powChallenge, parsed.data.powNonce);
  if (powError !== null) {
    res.status(403).json({ error: 'pow_failed', reason: powError });
    return;
  }

  if (!req.body || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: 'body_must_be_binary' });
    return;
  }

  // ── Global quota check (FIX A) ────────────────────────────────────────────
  if (currentTotalBytes + req.body.length > MAX_TOTAL_UPLOAD_BYTES) {
    res.status(507).json({ error: 'storage_full' });
    return;
  }

  const id = crypto.randomUUID();
  const filePath = path.join(UPLOADS_DIR, id);

  fs.writeFile(filePath, req.body, (err) => {
    if (err) {
      res.status(500).json({ error: 'SERVER_ERROR' });
      return;
    }
    currentTotalBytes += req.body.length;
    // Return the download token bound to this id. It travels inside the E2EE
    // envelope; the relay never needs to persist it (it is recomputed on GET).
    res.json({ id, token: mintDownloadToken(id) });
  });
});

// ── GET /blob/download/:id ────────────────────────────────────────────────────
// UUID v4 strict validation.
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

router.get('/download/:id', (req, res) => {
  const id = req.params.id;
  if (!UUID_V4_RE.test(id)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  // C-1 — require the HMAC token bound to this blob id. Knowing the UUID is not
  // enough; the token only exists inside the E2EE envelope the recipient holds.
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  if (!token || !isValidDownloadToken(id, token)) {
    res.status(403).json({ error: 'forbidden' });
    return;
  }

  const filePath = path.join(UPLOADS_DIR, id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  // FIX E — force download; prevent browser render/execution of arbitrary blobs.
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Disposition', 'attachment');
  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
});

// Background task to delete files older than 24h.
// Also keeps currentTotalBytes accurate so the quota check stays correct.
setInterval(() => {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const file of files) {
      if (file === '.gitkeep') continue;
      const filePath = path.join(UPLOADS_DIR, file);
      fs.stat(filePath, (statErr, stats) => {
        if (!statErr && now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
          fs.unlink(filePath, (unlinkErr) => {
            if (!unlinkErr) {
              currentTotalBytes = Math.max(0, currentTotalBytes - stats.size);
            }
          });
        }
      });
    }
  });
}, 60 * 60 * 1000).unref();

export default router;
