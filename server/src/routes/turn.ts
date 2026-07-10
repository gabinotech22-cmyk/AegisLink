import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
import { identityRepo } from '../db/client.js';

const { decodeBase64 } = tweetnaclUtil;

const router = Router();

// TTL: 1 hour — matches coturn use-auth-secret convention
const TTL_SECS = 3600;

// Crockford Base32 aegisId pattern — same as used throughout the relay
const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// Auth (A-7 of the 2026-06 audit): minting coturn credentials must require proof
// of a registered identity — otherwise anyone can GET working TURN creds and
// steal relay bandwidth. We require an Ed25519 signature over
// `${aegisId}:turn:${timeBucket}` (timeBucket = floor(ts/30_000)), verified
// against the signing key the identity registered — IDENTICAL trust model to
// POST /prekeys. `ts` is sent so the bucket is reproducible and bounded; it is
// used only for the signature window and is never logged.
const CredentialsQuery = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE),
  sig: z.string().min(1).max(128),
  ts: z.coerce.number().int().positive(),
});

/**
 * GET /turn/credentials?aegisId=&sig=&ts=
 *
 * Returns short-lived TURN credentials using coturn's use-auth-secret mechanism:
 *   username = "<expiry_unix_ts>:<aegisId>"
 *   password = HMAC-SHA1(TURN_SECRET, username) encoded as base64
 *
 * Requires a valid Ed25519 signature over `${aegisId}:turn:${floor(ts/30_000)}`
 * by the identity's registered signing key (anti-abuse). The server never logs
 * the aegisId — it is used only for username uniqueness within the TTL window
 * and to look up the signing key for verification.
 */
const turnLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20, // 20 credential refreshes per minute is generous for real usage
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});

router.get('/credentials', turnLimiter, async (req, res) => {
  const secret = process.env.TURN_SECRET;
  if (!secret) {
    res.status(503).json({ error: 'TURN_NOT_CONFIGURED' });
    return;
  }

  const parsed = CredentialsQuery.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  const { aegisId, sig, ts } = parsed.data;

  // Reject stale/forward-dated requests (±60s), then verify the signature
  // against the registered signing key for this identity.
  if (Math.abs(Date.now() - ts) > 60_000) {
    res.status(400).json({ error: 'timestamp_out_of_range' });
    return;
  }
  const identity = await identityRepo.get(aegisId);
  if (!identity || !identity.signing_public_key_b64) {
    res.status(403).json({ error: 'identity_not_found_or_no_signing_key' });
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
  const timeBucket = Math.floor(ts / 30_000);
  const encode = (bucket: number) => new TextEncoder().encode(`${aegisId}:turn:${bucket}`);
  // Accept the current and previous bucket to tolerate clock skew, exactly like
  // POST /prekeys.
  const validSig =
    nacl.sign.detached.verify(encode(timeBucket), sigBytes, pubKeyBytes) ||
    nacl.sign.detached.verify(encode(timeBucket - 1), sigBytes, pubKeyBytes);
  if (!validSig) {
    res.status(403).json({ error: 'invalid_signature' });
    return;
  }

  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECS;
  const username = `${expiresAt}:${aegisId}`;
  // lgtm[js/weak-cryptographic-algorithm]
  const credential = createHmac('sha1', secret).update(username).digest('base64');

  // TURN server URLs from environment — defaults to localhost for dev.
  // `||` (not `??`) so an empty-string env var falls back to the default
  // instead of producing a malformed URL like `turns:host:?transport=tcp`,
  // which makes native libwebrtc reject the WHOLE ICE config and throw
  // "Failed to initialize PeerConnection".
  const turnHost = process.env.TURN_HOST || 'localhost';
  const turnPort = process.env.TURN_PORT || '3478';
  const turnsPort = process.env.TURNS_PORT || '';

  const urls: string[] = [
    // Advertise OUR OWN coturn as the STUN server. coturn serves STUN natively on
    // the same host/port as TURN (there is no `no-stun` in turnserver.conf), so
    // the client gets server-reflexive candidates from infrastructure we control.
    // We deliberately do NOT list any third-party public STUN (Google/Cloudflare):
    // that would leak "this AegisLink user is calling now, from this IP" to an
    // outside party — a metadata leak that contradicts the zero-metadata promise.
    // The server is the single source of truth for its own host/port; clients do
    // not re-derive it.
    `stun:${turnHost}:${turnPort}`,
    `turn:${turnHost}:${turnPort}?transport=udp`,
    `turn:${turnHost}:${turnPort}?transport=tcp`,
  ];
  // Only advertise TURNS (TLS) when a TLS port is actually configured.
  // Emitting it with an empty port breaks the entire client RTCConfiguration.
  if (turnsPort) {
    urls.push(`turns:${turnHost}:${turnsPort}?transport=tcp`);
  }

  res.json({ urls, username, credential, ttl: TTL_SECS });
});

export default router;
