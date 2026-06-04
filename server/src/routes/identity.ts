import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { identityRepo } from '../db/client.js';
import { issueChallenge, verifyPoW } from '../pow/challenge.js';

const router = Router();

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// ── Rate limiter ──────────────────────────────────────────────────────────────
// Uses IP internally via express-rate-limit; the IP is NEVER written to SQLite
// or any application log. The store is in-memory and ephemeral.
const registrationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  // Return JSON instead of HTML on limit breach.
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 15 * 60 * 1000 });
  },
  skip: () => false,
});

// A lighter limiter for the challenge endpoint to prevent challenge-store flooding.
const challengeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});

// ── Schemas ───────────────────────────────────────────────────────────────────
const RegisterBody = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE, 'invalid Aegis ID format'),
  publicKey: z.string().min(40).max(64),
  signingPublicKey: z.string().min(1).max(64),
  // PoW fields
  powChallenge: z.string().length(64, 'challenge must be 64 hex chars'),
  powNonce: z.string().min(1).max(32).regex(/^[0-9a-f]+$/, 'nonce must be lowercase hex'),
});

// ── GET /identity/challenge ───────────────────────────────────────────────────
/** Issues a one-time PoW challenge. The client must solve it before registering. */
router.get('/challenge', challengeLimiter, (_req, res) => {
  const payload = issueChallenge();
  res.json(payload);
});

// ── POST /identity ────────────────────────────────────────────────────────────
/** Register a new identity. Requires a valid PoW solution obtained from GET /identity/challenge. */
router.post('/', registrationLimiter, async (req, res) => {
  const parsed = RegisterBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
    return;
  }

  const { aegisId, publicKey, signingPublicKey, powChallenge, powNonce } = parsed.data;

  // Verify PoW before touching the DB.
  const powError = verifyPoW(powChallenge, powNonce);
  if (powError !== null) {
    res.status(403).json({ error: 'pow_failed', reason: powError });
    return;
  }

  const existing = await identityRepo.get(aegisId);
  if (existing) {
    if (existing.public_key_b64 !== publicKey) {
      res.status(409).json({ error: 'id_taken' });
      return;
    }
    res.status(200).json({
      aegisId,
      publicKey,
      signingPublicKey: existing.signing_public_key_b64,
      createdAt: existing.created_at,
    });
    return;
  }

  const createdAt = Date.now();
  await identityRepo.insert({
    aegis_id: aegisId,
    public_key_b64: publicKey,
    signing_public_key_b64: signingPublicKey,
    created_at: createdAt,
  });
  res.status(201).json({ aegisId, publicKey, signingPublicKey, createdAt });
});

const lookupLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});

// ── GET /identity/:id ─────────────────────────────────────────────────────────
/** Look up a public key by Aegis ID (for adding contacts). */
router.get('/:id', lookupLimiter, async (req, res) => {
  const id = String(req.params.id);
  if (!AEGIS_ID_RE.test(id)) {
    res.status(400).json({ error: 'invalid_id_format' });
    return;
  }
  const row = await identityRepo.get(id);
  if (!row) {
    res.status(404).json({ error: 'not_found' });
    return;
  }
  res.json({
    aegisId: row.aegis_id,
    publicKey: row.public_key_b64,
    signingPublicKey: row.signing_public_key_b64,
    createdAt: row.created_at,
  });
});

export default router;
