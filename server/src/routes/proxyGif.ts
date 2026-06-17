/**
 * GET /proxy/gif
 *
 * Blind proxy for KLIPY GIF search and trending feeds. The relay fetches on
 * behalf of the client so no user IP ever reaches the GIF provider. The API
 * key stays server-side and is never exposed to the client.
 *
 * Provider note: Google shut down the Tenor public API (full shutdown
 * 2026-06-30). KLIPY is the drop-in successor (same content, lifetime-free
 * key). We map KLIPY's response back to the Tenor-shaped
 * `{ results: [{ id, media_formats: { gif, tinygif, nanogif } }] }` payload the
 * mobile client already consumes, so GifPicker.tsx needs no change.
 *
 * Privacy guarantees:
 *   - Client IP is never forwarded upstream (only the relay's egress IP is seen).
 *   - The query string and all upstream URLs are NEVER logged.
 *   - Error counters are logged without any query data.
 *   - Rate limiting uses express-rate-limit's in-memory store (ephemeral, no DB).
 *
 * Security notes:
 *   - KLIPY_KEY must be set via env var — missing key → 503.
 *   - Query is sanitized to letters/digits/spaces/hyphens before being forwarded.
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
  // Optional 1-based page for pagination (KLIPY uses `page`, not a cursor).
  page: z.coerce.number().int().min(1).max(100).optional(),
});

// Sanitize: keep only letters, digits, spaces, hyphens.
// This prevents any query injection into the upstream URL.
function sanitizeQuery(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9 -]/g, '').trim();
}

const PER_PAGE = 24;
const KLIPY_BASE = 'https://api.klipy.com/api/v1';

// ── KLIPY response types (only the fields we read) ──────────────────────────────
interface KlipyMedia {
  url?: string;
  width?: number;
  height?: number;
}
interface KlipyVariant {
  gif?: KlipyMedia;
}
interface KlipyItem {
  id?: number | string;
  file?: {
    hd?: KlipyVariant;
    md?: KlipyVariant;
    sm?: KlipyVariant;
    xs?: KlipyVariant;
  };
}
interface KlipyResponse {
  result?: boolean;
  data?: { data?: KlipyItem[] };
}

// Map one KLIPY format to the Tenor-shaped { url, dims } the client expects.
function fmt(m: KlipyMedia | undefined): { url: string; dims: [number, number] } | undefined {
  if (!m || !m.url) return undefined;
  return { url: m.url, dims: [m.width ?? 200, m.height ?? 200] };
}

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', gifLimiter, async (req, res) => {
  const klipyKey = process.env.KLIPY_KEY;
  if (!klipyKey) {
    res.status(503).json({ error: 'gif_provider_not_configured' });
    return;
  }

  const parsed = GifQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  const { q, page } = parsed.data;
  const keyPath = encodeURIComponent(klipyKey);

  // Build upstream URL — trending feed when no query is provided.
  let upstreamUrl: string;
  if (q === undefined || q.length === 0) {
    upstreamUrl = `${KLIPY_BASE}/${keyPath}/gifs/trending?per_page=${PER_PAGE}`;
  } else {
    const sanitized = sanitizeQuery(q);
    if (sanitized.length === 0) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    upstreamUrl =
      `${KLIPY_BASE}/${keyPath}/gifs/search` +
      `?q=${encodeURIComponent(sanitized)}&per_page=${PER_PAGE}`;
  }

  if (page !== undefined) {
    upstreamUrl += `&page=${page}`;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);

  try {
    const upstream = await fetch(upstreamUrl, {
      signal: controller.signal,
      // Do not forward any client headers — act as a fresh client upstream.
      headers: { 'User-Agent': 'AegisLinkRelay/1.0' },
    });

    clearTimeout(timeout);

    if (!upstream.ok) {
      // Log only the status code — never the URL (which contains the API key).
      console.error(`[proxy/gif] upstream HTTP ${upstream.status}`);
      res.status(502).json({ error: 'upstream_error' });
      return;
    }

    const body = (await upstream.json()) as KlipyResponse;
    const items = body.data?.data ?? [];

    // Map KLIPY → Tenor-shaped payload the client already understands.
    //   full  ← md.gif (falls back to hd/sm)
    //   tinygif ← sm.gif (220px preview)
    //   nanogif ← xs.gif (90px preview)
    const results = items
      .map((item) => ({
        id: String(item.id ?? ''),
        media_formats: {
          gif: fmt(item.file?.md?.gif ?? item.file?.hd?.gif ?? item.file?.sm?.gif),
          tinygif: fmt(item.file?.sm?.gif ?? item.file?.md?.gif),
          nanogif: fmt(item.file?.xs?.gif ?? item.file?.sm?.gif),
        },
      }))
      .filter((r) => r.id && (r.media_formats.gif || r.media_formats.tinygif));

    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=60');
    res.json({ results });
  } catch (err: unknown) {
    clearTimeout(timeout);
    // AbortError = timeout; generic error = network/parse failure.
    // In both cases we log only a count-style marker — no query, no URL.
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    console.error(`[proxy/gif] upstream_error type=${isTimeout ? 'timeout' : 'network'}`);
    res.status(502).json({ error: 'upstream_error' });
  }
});

export default router;
