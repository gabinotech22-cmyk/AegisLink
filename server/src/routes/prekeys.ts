import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
const { decodeBase64 } = tweetnaclUtil;
import { z } from 'zod';
import { identityRepo, prekeysRepo } from '../db/client.js';

const router = Router();

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// ── Rate limiter (20 requests per 10 minutes per IP) ──────────────────────────
const uploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 10 * 60 * 1000 });
  },
});

// ── Schemas ───────────────────────────────────────────────────────────────────

const UploadBody = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE, 'invalid Aegis ID format'),
  sig: z.string().min(1),
  ts: z.number().int().positive(),
  signedPreKey: z.object({
    keyId: z.number().int().nonnegative(),
    publicKeyB64: z.string().min(1).max(128),
    signatureB64: z.string().min(1).max(256),
  }),
  oneTimePreKeys: z
    .array(
      z.object({
        keyId: z.number().int().nonnegative(),
        publicKeyB64: z.string().min(1).max(128),
      })
    )
    .max(100),
});

// ── POST /prekeys ─────────────────────────────────────────────────────────────
/**
 * Upload or refresh prekeys for an identity.
 *
 * Auth: requires a valid Ed25519 signature over `${aegisId}:prekeys:${timeBucket}`
 * where timeBucket = Math.floor(ts / 30_000). The `ts` field must be within
 * ±60 seconds of server time.
 *
 * Body: { aegisId, sig, ts, signedPreKey: { keyId, publicKeyB64, signatureB64 },
 *         oneTimePreKeys: [{ keyId, publicKeyB64 }, ...] }
 * Response 201: { uploaded: N }
 */
router.post('/', uploadLimiter, async (req, res) => {
  const parsed = UploadBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid_body', issues: parsed.error.issues });
    return;
  }

  const { aegisId, sig, ts, signedPreKey, oneTimePreKeys } = parsed.data;

  // Validate timestamp within ±60 seconds.
  if (Math.abs(Date.now() - ts) > 60_000) {
    res.status(400).json({ error: 'timestamp_out_of_range' });
    return;
  }

  // Identity must exist and have a signing key.
  const identity = await identityRepo.get(aegisId);
  if (!identity || !identity.signing_public_key_b64) {
    res.status(403).json({ error: 'identity_not_found_or_no_signing_key' });
    return;
  }

  // Verify Ed25519 signature.
  let pubKeyBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    pubKeyBytes = decodeBase64(identity.signing_public_key_b64);
    sigBytes = decodeBase64(sig);
  } catch {
    res.status(403).json({ error: 'invalid_signature' });
    return;
  }

  const timeBucket = Math.floor(ts / 30_000);
  const encode = (bucket: number) =>
    new TextEncoder().encode(`${aegisId}:prekeys:${bucket}`);

  const valid =
    nacl.sign.detached.verify(encode(timeBucket), sigBytes, pubKeyBytes) ||
    nacl.sign.detached.verify(encode(timeBucket - 1), sigBytes, pubKeyBytes);

  if (!valid) {
    res.status(403).json({ error: 'invalid_signature' });
    return;
  }

  const now = Date.now();

  try {
    await prekeysRepo.upsertSigned({
      aegis_id: aegisId,
      key_id: signedPreKey.keyId,
      public_key_b64: signedPreKey.publicKeyB64,
      signature_b64: signedPreKey.signatureB64,
      created_at: now,
    });

    let uploaded = 0;
    for (const opk of oneTimePreKeys) {
      await prekeysRepo.insertOneTime({
        aegis_id: aegisId,
        key_id: opk.keyId,
        public_key_b64: opk.publicKeyB64,
        created_at: now,
      });
      uploaded++;
    }

    res.status(201).json({ uploaded });
  } catch (_err) {
    res.status(500).json({ error: 'db_error' });
  }
});

// ── GET /bundle/:aegisId ──────────────────────────────────────────────────────
/**
 * Fetch an X3DH prekey bundle for a contact.
 *
 * The one-time prekey (OPK) is consumed atomically — it is deleted from the
 * database on read and will never be returned again. If no OPKs remain,
 * `oneTimePreKey` is null; X3DH continues to work (slightly weaker forward
 * secrecy but the session is still E2EE).
 *
 * Response 200:
 *   {
 *     signingPublicKeyB64: string,
 *     signedPreKey: { keyId, publicKeyB64, signatureB64 },
 *     oneTimePreKey: { keyId, publicKeyB64 } | null
 *   }
 */
router.get('/bundle/:aegisId', async (req, res) => {
  const { aegisId } = req.params;

  if (!AEGIS_ID_RE.test(aegisId)) {
    res.status(400).json({ error: 'invalid_id_format' });
    return;
  }

  try {
    const bundle = await prekeysRepo.getBundle(aegisId);
    if (!bundle) {
      res.status(404).json({ error: 'bundle_not_found' });
      return;
    }

    res.json(bundle);
  } catch (_err) {
    res.status(500).json({ error: 'db_error' });
  }
});

export default router;
