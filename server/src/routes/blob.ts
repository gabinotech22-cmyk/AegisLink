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

if (!fs.existsSync(UPLOADS_DIR)) {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

// ── Rate limiter (10 uploads per 15 minutes per IP) ───────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 15 * 60 * 1000 });
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

  const id = crypto.randomUUID();
  const filePath = path.join(UPLOADS_DIR, id);

  fs.writeFile(filePath, req.body, (err) => {
    if (err) {
      res.status(500).json({ error: 'SERVER_ERROR' });
      return;
    }
    res.json({ id });
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

  const filePath = path.join(UPLOADS_DIR, id);
  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  res.set('X-Content-Type-Options', 'nosniff');
  res.sendFile(filePath);
});

// Background task to delete files older than 24h
setInterval(() => {
  fs.readdir(UPLOADS_DIR, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const file of files) {
      if (file === '.gitkeep') continue;
      const filePath = path.join(UPLOADS_DIR, file);
      fs.stat(filePath, (statErr, stats) => {
        if (!statErr && now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
          fs.unlink(filePath, () => {});
        }
      });
    }
  });
}, 60 * 60 * 1000).unref();

export default router;
