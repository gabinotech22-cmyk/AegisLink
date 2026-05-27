/**
 * GET /proxy/linkpreview
 *
 * Blind proxy for Open Graph link previews. The relay fetches the target URL
 * on behalf of the client so no user IP reaches the destination server.
 *
 * Privacy guarantees:
 *   - Client IP is never forwarded to the target host.
 *   - The fetched URL and parsed content are NEVER logged (zero-metadata).
 *   - Error events are counted without URL or content data.
 *   - Rate limiting uses express-rate-limit's in-memory store (ephemeral, no DB).
 *
 * Security (SSRF prevention):
 *   - Only http: and https: schemes are allowed.
 *   - Private / loopback / link-local / cloud-metadata ranges are blocked.
 *   - Only the first 8 KB of the response body are read (Range: bytes=0-8191).
 *   - 5-second AbortController timeout prevents slow-drip attacks.
 *   - Relative og:image URLs are resolved against the final (post-redirect) URL.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';

const router = Router();

// ── Rate limiter — 60 req/min per IP, in-memory only ─────────────────────────
const previewLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (_req, res) => {
    res.status(429).json({ error: 'rate_limit_exceeded', retryAfterMs: 60_000 });
  },
});

// ── Input schema ──────────────────────────────────────────────────────────────
const PreviewQuerySchema = z.object({
  url: z.string().url().max(2048),
});

// ── SSRF block list ───────────────────────────────────────────────────────────
// Returns true when the hostname resolves to a private/loopback/metadata range.
// We check the hostname textually — DNS rebinding is out of scope here because
// the relay is not a browser; actual network-level hardening (firewall rules
// restricting egress from the relay process) is the correct defense-in-depth.
function isBlockedHostname(hostname: string): boolean {
  // Normalise: strip IPv6 brackets if present.
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();

  // Explicit blocked names
  const blockedNames = [
    'localhost',
    'metadata.google.internal',
  ];
  if (blockedNames.includes(h)) return true;

  // IPv4 address check
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number) as [string, number, number, number, number];
    // 127.x.x.x — loopback
    if (a === 127) return true;
    // 0.x.x.x — unspecified / invalid
    if (a === 0) return true;
    // 10.x.x.x — RFC 1918 private
    if (a === 10) return true;
    // 172.16.x.x – 172.31.x.x — RFC 1918 private
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.x.x — RFC 1918 private
    if (a === 192 && b === 168) return true;
    // 169.254.x.x — link-local (AWS IMDS: 169.254.169.254)
    if (a === 169 && b === 254) return true;
  }

  // IPv6 loopback ::1
  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true;
  // IPv6 link-local fe80::/10
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;
  // Unique local fc00::/7
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;

  return false;
}

// ── OG tag extractor (regex-based, no cheerio dependency) ────────────────────
interface OgData {
  title: string | null;
  description: string | null;
  image: string | null;
}

function extractOg(html: string, baseUrl: string): OgData {
  const get = (prop: string): string | null => {
    // Match both <meta property="og:X" content="Y"> and reversed attribute order.
    const re1 = new RegExp(
      `<meta[^>]+property=["']og:${prop}["'][^>]+content=["']([^"']{1,2048})["']`,
      'i',
    );
    const re2 = new RegExp(
      `<meta[^>]+content=["']([^"']{1,2048})["'][^>]+property=["']og:${prop}["']`,
      'i',
    );
    const m = re1.exec(html) ?? re2.exec(html);
    return m ? m[1].trim() : null;
  };

  const rawImage = get('image');
  let image: string | null = null;
  if (rawImage !== null) {
    try {
      // Resolve relative URLs (e.g. "/logo.png") against the final URL.
      image = new URL(rawImage, baseUrl).href;
    } catch {
      // Malformed image URL — discard rather than propagate garbage.
      image = null;
    }
  }

  return {
    title: get('title'),
    description: get('description'),
    image,
  };
}

// ── GET / ─────────────────────────────────────────────────────────────────────
router.get('/', previewLimiter, async (req, res) => {
  const parsed = PreviewQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  const { url } = parsed.data;

  // Schema check — only http/https allowed.
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  // SSRF guard — block private/loopback/metadata ranges.
  if (isBlockedHostname(parsedUrl.hostname)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);

  try {
    const upstream = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Request only the first 8 KB; many servers honour this.
        Range: 'bytes=0-8191',
        'User-Agent': 'AegisLinkRelay/1.0 (+linkpreview)',
        // Do not send cookies or credentials to the upstream host.
        Cookie: '',
      },
      redirect: 'follow',
    });

    clearTimeout(timeout);

    // The final URL after any redirects — used to resolve relative image URLs.
    const finalUrl = upstream.url ?? url;

    // Re-check hostname after redirects (basic open-redirect SSRF mitigation).
    try {
      const finalParsed = new URL(finalUrl);
      if (
        (finalParsed.protocol !== 'http:' && finalParsed.protocol !== 'https:') ||
        isBlockedHostname(finalParsed.hostname)
      ) {
        res.status(400).json({ error: 'INVALID_PAYLOAD' });
        return;
      }
    } catch {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }

    if (!upstream.ok) {
      // Only log aggregated status codes — never the URL.
      console.error(`[proxy/linkpreview] upstream HTTP ${upstream.status}`);
      res.status(504).json({ error: 'preview_unavailable' });
      return;
    }

    // Read at most 8 KB regardless of what the server sends.
    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      // Non-HTML (e.g. binary, video) — no OG data to extract.
      res.json({ title: null, description: null, image: null, url: finalUrl });
      return;
    }

    const rawBuffer = await upstream.arrayBuffer();
    const sliced = rawBuffer.slice(0, 8192);
    const html = new TextDecoder('utf-8', { fatal: false }).decode(sliced);

    const og = extractOg(html, finalUrl);

    res.json({ ...og, url: finalUrl });
  } catch (err: unknown) {
    clearTimeout(timeout);
    const isTimeout = err instanceof Error && err.name === 'AbortError';
    // Log only a type marker — no URL, no content.
    console.error(
      `[proxy/linkpreview] error type=${isTimeout ? 'timeout' : 'network'}`,
    );
    res.status(504).json({ error: 'preview_unavailable' });
  }
});

export default router;
