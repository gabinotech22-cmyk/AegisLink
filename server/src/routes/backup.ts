/**
 * backup.ts — Blind remote-backup endpoint.
 *
 * The server is a dumb courier: it stores an opaque encrypted blob keyed by a
 * hash of the user's aegisId. It cannot decrypt, cannot read fields, and never
 * logs IP addresses or association metadata.
 *
 * Authentication: nacl.box challenge-response (same scheme as the Socket.IO
 * relay — see auth/challenge.ts). The client:
 *   1. GET  /backup/challenge?aegisId=XXX   → { token, ephemeralPubKey, nonce, ciphertext }
 *   2. Opens the nacl.box with its secretKey, recovers the 32-byte plaintext.
 *   3. PUT/GET/DELETE /backup  →  { aegisId, token, plain: base64(plaintext), ...payload }
 *
 * The challenge token is a random UUID that maps to the server-side Challenge
 * struct held in a TTL'd in-memory store. No challenge state reaches SQLite.
 *
 * BackupEnvelope (client-side structure, opaque to server):
 *   { v: number, salt: string, nonce: string, ciphertext: string }
 * All fields are base64-encoded strings produced by the client's crypto layer.
 * The server stores the whole thing as a single JSON string and returns it
 * verbatim — zero parsing beyond JSON.stringify round-trip.
 *
 * Privacy properties:
 *   - aegisId stored only as SHA-256 hash (id_hash) in the DB row.
 *   - No IP logged anywhere.
 *   - No content inspection.
 *   - Rate-limited per aegisId (not per IP).
 *   - Backup size capped at 5 MB.
 */

import { Router } from 'express';
import { z } from 'zod';
import { createHash, randomUUID } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import { backupRepo } from '../db/client.js';
import { issueChallenge, verifyResponse, challengeWire, type Challenge } from '../auth/challenge.js';

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_BACKUP_BYTES = 5 * 1024 * 1024; // 5 MB

/**
 * Disk quota for the entire backup store (aggregate across all users).
 * Approximated in memory: updated on every PUT and DELETE.
 * If exceeded, PUT returns 507.
 */
const MAX_TOTAL_BACKUP_BYTES = 50 * 1024 * 1024 * 1024; // 50 GB
let currentTotalBytes = 0;

// ── Aegis ID regex (matches identity.ts / handler.ts) ────────────────────────
const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// ── In-memory pending challenge store (never hits SQLite) ─────────────────────

interface PendingChallenge {
  aegisId: string;
  challenge: Challenge;
  expiresAt: number;
}

const pendingChallenges = new Map<string, PendingChallenge>();
const CHALLENGE_STORE_TTL_MS = 35_000; // slightly longer than auth/challenge.ts 30 s TTL

function pruneExpiredChallenges(): void {
  const now = Date.now();
  for (const [token, entry] of pendingChallenges) {
    if (entry.expiresAt <= now) pendingChallenges.delete(token);
  }
}

/** Hash aegisId so the raw identifier never appears as a DB key. */
function hashAegisId(aegisId: string): string {
  return createHash('sha256').update(aegisId).digest('hex');
}

// ── Rate limiters (keyed by aegisId, in-memory) ───────────────────────────────
// We implement our own map-based limiter to avoid relying on IP, matching the
// pattern established in relay/handler.ts.

interface RateBucket {
  count: number;
  reset: number;
}

const putLimits = new Map<string, RateBucket>();    // 6 PUT/hour
const getLimits = new Map<string, RateBucket>();    // 30 GET/hour
const deleteLimits = new Map<string, RateBucket>(); // 10 DELETE/hour
const RATE_MAP_MAX = 50_000;

function checkRateLimit(
  map: Map<string, RateBucket>,
  aegisId: string,
  maxCount: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const entry = map.get(aegisId) ?? { count: 0, reset: now + windowMs };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + windowMs; }
  entry.count++;
  map.set(aegisId, entry);
  // Prevent unbounded memory growth
  if (map.size > RATE_MAP_MAX) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  return entry.count <= maxCount;
}

// IP-based rate limiter for the unauthenticated challenge endpoint only.
const challengeLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'RATE_LIMITED' });
  },
});

// ── Zod schemas ───────────────────────────────────────────────────────────────

const ChallengeQuerySchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE, 'invalid Aegis ID format'),
});

/**
 * The BackupEnvelope is treated as opaque by the server.
 * We validate only that the required fields are present and are non-empty
 * strings — we never parse ciphertext, salt, nonce, or v.
 */
const BackupEnvelopeSchema = z.object({
  v: z.number().int().min(1),
  salt: z.string().min(1).max(256),
  nonce: z.string().min(1).max(256),
  ciphertext: z.string().min(1),
});

const PutBodySchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE),
  token: z.string().uuid(),
  plain: z.string().min(1),
  envelope: BackupEnvelopeSchema,
});

const AuthBodySchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE),
  token: z.string().uuid(),
  plain: z.string().min(1),
});

// ── Helper: resolve and consume a pending challenge ───────────────────────────

function resolvePendingChallenge(
  aegisId: string,
  token: string,
  plain: string,
): boolean {
  pruneExpiredChallenges();
  const pending = pendingChallenges.get(token);
  if (!pending) return false;
  if (pending.aegisId !== aegisId) return false;
  if (!verifyResponse(pending.challenge, plain)) return false;
  // One-time use: consume immediately on success.
  pendingChallenges.delete(token);
  return true;
}

// ── GET /backup/challenge?aegisId=XXX ────────────────────────────────────────

router.get('/challenge', challengeLimiter, async (req, res) => {
  const parsed = ChallengeQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  const { aegisId } = parsed.data;
  const challenge = await issueChallenge(aegisId);
  if (!challenge) {
    // Identity not found — don't reveal why (privacy).
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const token = randomUUID();
  pruneExpiredChallenges();
  pendingChallenges.set(token, {
    aegisId,
    challenge,
    expiresAt: Date.now() + CHALLENGE_STORE_TTL_MS,
  });

  res.json({
    token,
    ...challengeWire(challenge),
  });
});

// ── PUT /backup — upload / replace backup ─────────────────────────────────────

router.put('/', async (req, res) => {
  const parsed = PutBodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  const { aegisId, token, plain, envelope } = parsed.data;

  // Verify ownership before touching storage.
  if (!resolvePendingChallenge(aegisId, token, plain)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  // Rate limit: 6 PUTs per hour per aegisId.
  if (!checkRateLimit(putLimits, aegisId, 6, 60 * 60 * 1000)) {
    res.status(429).json({ error: 'RATE_LIMITED' });
    return;
  }

  // Validate per-backup size limit (5 MB).
  const envelopeJson = JSON.stringify(envelope);
  if (Buffer.byteLength(envelopeJson, 'utf8') > MAX_BACKUP_BYTES) {
    res.status(413).json({ error: 'PAYLOAD_TOO_LARGE' });
    return;
  }

  // Check global quota (rough approximation).
  if (currentTotalBytes + Buffer.byteLength(envelopeJson, 'utf8') > MAX_TOTAL_BACKUP_BYTES) {
    res.status(507).json({ error: 'STORAGE_FULL' });
    return;
  }

  try {
    // Retrieve previous size so we can keep the counter accurate.
    const idHash = hashAegisId(aegisId);
    const existing = await backupRepo.get(idHash);
    const prevSize = existing ? Buffer.byteLength(existing.envelope, 'utf8') : 0;

    await backupRepo.upsert(idHash, envelopeJson);

    const newSize = Buffer.byteLength(envelopeJson, 'utf8');
    currentTotalBytes = Math.max(0, currentTotalBytes - prevSize + newSize);

    res.status(200).json({ ok: true });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── GET /backup/:aegisId — retrieve backup ────────────────────────────────────

router.get('/:aegisId', async (req, res) => {
  const aegisIdParam = String(req.params['aegisId']);
  if (!AEGIS_ID_RE.test(aegisIdParam)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  // Auth fields come from query string (GET has no body).
  const authParsed = z.object({
    token: z.string().uuid(),
    plain: z.string().min(1),
  }).safeParse(req.query);

  if (!authParsed.success) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const { token, plain } = authParsed.data;

  if (!resolvePendingChallenge(aegisIdParam, token, plain)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  // Rate limit: 30 GETs per hour.
  if (!checkRateLimit(getLimits, aegisIdParam, 30, 60 * 60 * 1000)) {
    res.status(429).json({ error: 'RATE_LIMITED' });
    return;
  }

  try {
    const idHash = hashAegisId(aegisIdParam);
    const row = await backupRepo.get(idHash);
    if (!row) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    // Parse back to object and return — the ciphertext passes through verbatim.
    const envelope: unknown = JSON.parse(row.envelope);
    res.status(200).json({ envelope });
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// ── DELETE /backup/:aegisId — delete backup ───────────────────────────────────
// Used during account panic / deletion so no orphan blobs remain.

router.delete('/:aegisId', async (req, res) => {
  const aegisIdParam = String(req.params['aegisId']);
  if (!AEGIS_ID_RE.test(aegisIdParam)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  const authParsed = AuthBodySchema.safeParse(req.body);
  if (!authParsed.success) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  const { aegisId, token, plain } = authParsed.data;

  // The aegisId in the body must match the URL param.
  if (aegisId !== aegisIdParam) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  if (!resolvePendingChallenge(aegisId, token, plain)) {
    res.status(401).json({ error: 'UNAUTHORIZED' });
    return;
  }

  // Rate limit: 10 DELETEs per hour.
  if (!checkRateLimit(deleteLimits, aegisId, 10, 60 * 60 * 1000)) {
    res.status(429).json({ error: 'RATE_LIMITED' });
    return;
  }

  try {
    const idHash = hashAegisId(aegisId);
    const existing = await backupRepo.get(idHash);
    const prevSize = existing ? Buffer.byteLength(existing.envelope, 'utf8') : 0;

    const deleted = await backupRepo.delete(idHash);
    if (deleted) {
      currentTotalBytes = Math.max(0, currentTotalBytes - prevSize);
      res.status(200).json({ ok: true });
    } else {
      res.status(404).json({ error: 'NOT_FOUND' });
    }
  } catch {
    res.status(500).json({ error: 'SERVER_ERROR' });
  }
});

// Export the in-memory counter for tests (not used by production callers).
export { currentTotalBytes as _currentTotalBytes };

export default router;
