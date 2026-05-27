/**
 * GET /proxy/gif
 *
 * Blind proxy for Tenor GIF search and featured feeds. The relay fetches on
 * behalf of the client so no user IP ever reaches Google/Tenor. The API key
 * stays server-side and is never exposed to the client.
 *
 * Privacy guarantees:
 *   - Client IP is never forwarded to Tenor (only the relay's egress IP is seen).
 *   - The query string, `next` cursor, and all upstream URLs are NEVER logged.
 *   - Error counters are logged without any query data.
 *   - Rate limiting uses express-rate-limit's in-memory store (ephemeral, no DB).
 *
 * Security notes:
 *   - TENOR_KEY must be set via env var — missing key → 503.
 *   - Query is sanitized to letters/digits/spaces/hyphens before being forwarded.
 *   - `next` cursor is bounded to 64 hex chars to prevent injection.
 *   - 8-second AbortController timeout prevents slow-upstream hangs.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

const router = Router();

// ── Rate limiter — 30 req/min per IP, in-memory only ─────────────────────────
const gifLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});

// ── Input schema ──────────────────────────────────────────────────────────────
const GifQuerySchema = z.object({
  // Optional free-text search; 1–100 chars
  q: z.string().min(1).max(100).optional(),
  // Optional pagination cursor from a previous Tenor response; max 64 hex chars
  next: z.string().max(64).regex(/^[0-9a-fA-F]+$/).optional(),
});

// Sanitize: keep only letters, digits, spaces, hyphens.
// This prevents any query injection into the upstream URL.
function sanitizeQuery(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9 -]/g, '').trim();
}

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', gifLimiter, async (req, res) => {
  const tenorKey = process.env.TENOR_KEY;
  if (!tenorKey) {
    res.status(503).json({ error: 'gif_provider_not_configured' });
    return;
  }

  const parsed = GifQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  const { q, next } = parsed.data;

  // Build upstream URL — featured feed when no query is provided.
  let upstreamUrl: string;
  if (q === undefined || q.length === 0) {
    upstreamUrl =
      `https://tenor.googleapis.com/v2/featured` +
      `?key=${encodeURIComponent(tenorKey)}&limit=20&media_filter=gif`;
  } else {
    const sanitized = sanitizeQuery(q);
    if (sanitized.length === 0) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    upstreamUrl =
      `https://tenor.googleapis.com/v2/search` +
      `?q=${encodeURIComponent(sanitized)}` +
      `&key=${encodeURIComponent(tenorKey)}&limit=20&media_filter=gif`;
  }

  if (next !== undefined) {
    upstreamUrl += `&pos=${encodeURIComponent(next)}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      // Do not forward any client headers — act as a fresh client to Tenor.
      headers: { 'User-Agent': 'AegisLinkRelay/1.0' },
    });

    clearTimeout(timeout);

    if (!upstream.ok) {
      // Log only the status code — never the URL (which contains the API key).
      console.error(`[proxy/gif] upstream HTTP ${upstream.status}`);
      res.status(502).json({ error: 'upstream_error' });
      return;
    }

    const body: unknown = await upstream.json();

    // Forward Tenor's response as-is; set cache headers to reduce repeat traffic.
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json(body);
  } catch (err: unknown) {
    clearTimeout(timeout);
    // AbortError = timeout; generic error = network/parse failure.
    // In both cases we log only a count-style marker — no query, no URL.
    const isTimeout =
      err instanceof Error && err.name === 'AbortError';
    console.error(`[proxy/gif] upstream_error type=${isTimeout ? 'timeout' : 'network'}`);
    res.status(502).json({ error: 'upstream_error' });
  }
});

export default router;
