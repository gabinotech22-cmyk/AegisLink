import { Router } from 'express';
import tweetnaclUtil from 'tweetnacl-util';
import { z } from 'zod';
import { identityRepo, web3Repo } from '../db/client.js';
import { didHashHex, didKeyFromEd25519 } from '../crypto/didKey.js';
import { issueChallenge, verifyPoW, REGISTRATION_POW_DIFFICULTY } from '../pow/challenge.js';
import { verifyDetached } from '../crypto/ed25519.js';
import { relayLimiter, paramField } from '../http/relayLimiter.js';

const { decodeBase64 } = tweetnaclUtil;

const router = Router();

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// ── Rate limiter ──────────────────────────────────────────────────────────────
// Per-IP on clearnet, flood backstop over the onion (http/relayLimiter.ts); the
// IP is NEVER written to SQLite or any application log. The store is in-memory
// and ephemeral.
const registrationLimiter = relayLimiter({
  // Ops-tunable ceiling (default 5). Raise via AEGIS_REG_RATELIMIT_MAX for
  // local E2E testing where one machine re-registers many times; production
  // leaves it at the strict default.
  windowMs: 15 * 60 * 1000,
  max: Number(process.env.AEGIS_REG_RATELIMIT_MAX ?? 5),
  // Over Tor the real anti-abuse is the registration PoW (A-2); the shared
  // backstop only caps CPU, so it is sized for onboarding bursts, not 5 × 50.
  onion: { kind: 'shared' },
  onionFloodMax: Number(process.env.AEGIS_ONION_REG_FLOOD_MAX ?? 1000),
  body: { error: 'rate_limit_exceeded', retryAfterMs: 15 * 60 * 1000 },
});

// A lighter limiter for the challenge endpoint to prevent challenge-store flooding.
const challengeLimiter = relayLimiter({
  windowMs: 60 * 1000,
  max: 20,
  onion: { kind: 'shared' },
  body: { error: 'rate_limit_exceeded', retryAfterMs: 60_000 },
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
  // A-2: registration uses a harder PoW than the shared default (anti-squatting).
  const payload = issueChallenge(REGISTRATION_POW_DIFFICULTY);
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

const lookupLimiter = relayLimiter({
  windowMs: 60 * 1000,
  max: 60,
  onion: { kind: 'shared' },
  body: { error: 'rate_limit_exceeded', retryAfterMs: 60_000 },
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

// ── DELETE /identity/:id ──────────────────────────────────────────────────────
/**
 * B-2: account deletion. Wipes every relay-side trace of the identity except
 * one: SHA-256 of the identity's did:key, kept so GET /web3/did/resolve reports
 * the DID as deactivated (see the revocation step below).
 *
 * Auth: a valid Ed25519 signature over `${aegisId}:delete:${timeBucket}` where
 * timeBucket = Math.floor(ts / 30_000), verified against the stored signing key —
 * the same proof-of-key-possession scheme as POST /prekeys (golden rule #3:
 * knowing an ID is not owning it). `ts` must be within ±60s of server time.
 *
 * Body: { sig, ts }. Response 200: { deleted: true }.
 */
const DeleteBody = z.object({
  sig: z.string().min(1),
  ts: z.number().int().positive(),
});

const deleteLimiter = relayLimiter({
  windowMs: 15 * 60 * 1000,
  max: 5,
  onion: { kind: 'identity', key: paramField('id') },
  body: { error: 'rate_limit_exceeded', retryAfterMs: 15 * 60 * 1000 },
});

router.delete('/:id', deleteLimiter, async (req, res) => {
  const id = String(req.params.id);
  if (!AEGIS_ID_RE.test(id)) {
    res.status(400).json({ error: 'invalid_id_format' });
    return;
  }
  const parsed = DeleteBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
    return;
  }
  const { sig, ts } = parsed.data;

  if (Math.abs(Date.now() - ts) > 60_000) {
    res.status(400).json({ error: 'timestamp_out_of_range' });
    return;
  }

  const identity = await identityRepo.get(id);
  if (!identity || !identity.signing_public_key_b64) {
    res.status(404).json({ error: 'not_found' });
    return;
  }

  let pubKeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubKeyBytes = decodeBase64(identity.signing_public_key_b64);
    sigBytes = decodeBase64(sig);
  } catch {
    res.status(403).json({ error: 'invalid_signature' });
    return;
  }

  const bucket = Math.floor(ts / 30_000);
  const encode = (b: number) => new TextEncoder().encode(`${id}:delete:${b}`);
  const valid =
    verifyDetached(encode(bucket), sigBytes, pubKeyBytes) ||
    verifyDetached(encode(bucket - 1), sigBytes, pubKeyBytes);
  if (!valid) {
    res.status(403).json({ error: 'invalid_signature' });
    return;
  }

  // Retire the identity's DID (did:key of this very signing key) BEFORE the
  // account row goes: the revocation is derived server-side from the owner's
  // signature just verified, never taken from the client (golden rules #3/#7),
  // so nobody can deactivate a DID they do not hold the key for. It is what lets
  // a verifier stop trusting a key a thief may still hold after the owner wipes
  // it. Idempotent, so a retried delete after a partial failure is safe; the
  // reverse order could leave the account gone and the DID forever active.
  await web3Repo.insertRevocation(didHashHex(didKeyFromEd25519(pubKeyBytes)));
  await identityRepo.deleteAccount(id);
  res.status(200).json({ deleted: true });
});

export default router;
