/**
 * GET /relay/info — what this relay offers (federation F2, docs/FEDERATION-DESIGN.md D5).
 *
 * A client about to use a relay it does not know (a contact's onion, or the
 * user's own choice in "Mi relay") asks this first: which features exist, what
 * limits apply and the minimum client the relay will talk to. Static,
 * unauthenticated, cacheable, and deliberately free of anything that varies
 * per user or per request — it must not become a fingerprinting surface.
 * The relay never learns who asked (Tor) and stores nothing.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { appVersionInfo } from '../relay/appVersion.js';

const router = Router();

/** Bump when the wire this relay speaks changes incompatibly. */
export const RELAY_PROTOCOL = 1;
/** Mirrors routes/blob.ts (express.raw limit). */
export const MAX_BLOB_BYTES = 50 * 1024 * 1024;

const infoLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 }); },
});

export interface RelayInfo {
  name: string;
  protocol: number;
  minClient?: string;
  features: string[];
  maxBlobBytes: number;
}

export function relayInfo(env: NodeJS.ProcessEnv = process.env): RelayInfo {
  const features = ['mailbox', 'prekeys', 'blob', 'calls'];
  if ((env['PUSH_MAILBOX_ENABLED'] ?? 'off').toLowerCase() === 'on') features.push('ntfy');
  // Directory lookups (GET /identity/:id) are a per-relay policy: a self-hosted
  // relay may keep its identities private (contacts then come from links/QRs,
  // which carry the key). Default: on, to match today's official relay.
  if ((env['IDENTITY_LOOKUP'] ?? 'on').toLowerCase() !== 'off') features.push('identity-lookup');
  const info: RelayInfo = {
    name: env['RELAY_NAME'] ?? 'AegisLink relay',
    protocol: RELAY_PROTOCOL,
    features,
    maxBlobBytes: MAX_BLOB_BYTES,
  };
  const min = appVersionInfo(env)?.minVersion;
  if (min) info.minClient = min;
  return info;
}

router.get('/info', infoLimiter, (_req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.json(relayInfo());
});

export default router;
