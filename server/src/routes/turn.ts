import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { z } from 'zod';
import rateLimit from 'express-rate-limit';

const router = Router();

// TTL: 1 hour — matches coturn use-auth-secret convention
const TTL_SECS = 3600;

// Crockford Base32 aegisId pattern — same as used throughout the relay
const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const CredentialsQuery = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE).optional(),
});

/**
 * GET /turn/credentials
 *
 * Returns short-lived TURN credentials using coturn's use-auth-secret mechanism:
 *   username = "<expiry_unix_ts>:<aegisId>"
 *   password = HMAC-SHA1(TURN_SECRET, username) encoded as base64
 *
 * Clients call this before initiating a WebRTC call and pass the credentials
 * to RTCPeerConnection as an iceServer entry. The server never logs the
 * aegisId — it is used only for username uniqueness within the TTL window.
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

router.get('/credentials', turnLimiter, (req, res) => {
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

  // aegisId is opaque to the server — used only to make the username unique
  // across simultaneous sessions. Never logged.
  const aegisId = parsed.data.aegisId ?? 'anon';

  const expiresAt = Math.floor(Date.now() / 1000) + TTL_SECS;
  const username = `${expiresAt}:${aegisId}`;
  const credential = createHmac('sha1', secret).update(username).digest('base64');

  // TURN server URLs from environment — defaults to localhost for dev
  const turnHost = process.env.TURN_HOST ?? 'localhost';
  const turnPort = process.env.TURN_PORT ?? '3478';
  const turnsPort = process.env.TURNS_PORT ?? '5349';

  const urls: string[] = [
    `turn:${turnHost}:${turnPort}?transport=udp`,
    `turn:${turnHost}:${turnPort}?transport=tcp`,
    `turns:${turnHost}:${turnsPort}?transport=tcp`,
  ];

  res.json({ urls, username, credential, ttl: TTL_SECS });
});

export default router;
