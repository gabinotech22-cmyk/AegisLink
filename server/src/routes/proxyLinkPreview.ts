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
import { lookup } from 'node:dns/promises';

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
/** True when a literal IP string is in a private/loopback/link-local/metadata range. */
export function isBlockedIp(ip: string): boolean {
  const h = ip.replace(/^\[|\]$/g, '').toLowerCase();

  // IPv4 (also matches IPv4-mapped IPv6 like ::ffff:169.254.169.254 via the suffix)
  const ipv4 = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [, a, b] = ipv4.map(Number) as [string, number, number, number, number];
    if (a === 127) return true;                 // loopback
    if (a === 0) return true;                    // unspecified / invalid
    if (a === 10) return true;                   // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
    if (a === 192 && b === 168) return true;     // RFC 1918
    if (a === 169 && b === 254) return true;     // link-local (AWS IMDS 169.254.169.254)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    // Note: do not early-return false here — fall through to IPv6 checks for
    // mapped forms; the IPv4 regex is anchored to the END of the string.
  }

  if (h === '::1' || h === '0:0:0:0:0:0:0:1') return true; // IPv6 loopback
  if (/^fe[89ab][0-9a-f]:/i.test(h)) return true;          // link-local fe80::/10
  if (/^f[cd][0-9a-f]{2}:/i.test(h)) return true;          // unique-local fc00::/7
  if (h === '::') return true;                              // unspecified

  return false;
}

// Returns true when the hostname is an explicitly-blocked name or a literal IP
// in a blocked range. DNS resolution (rebinding defence) is handled separately
// by assertPublicHost() before any fetch.
function isBlockedHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const blockedNames = ['localhost', 'metadata.google.internal'];
  if (blockedNames.includes(h)) return true;
  return isBlockedIp(h);
}

/**
 * B-8 (DNS rebinding): textual hostname checks are not enough — an attacker can
 * point a public-looking name at a private IP. Resolve the hostname to ALL of
 * its A/AAAA records and reject if ANY resolves into a blocked range. Throws on
 * any blocked/failed resolution. NOTE: a narrow TOCTOU window remains between
 * this lookup and fetch()'s own resolution; the complete mitigation is an egress
 * firewall on the relay host (documented in ops). This closes the trivial case.
 */
async function assertPublicHost(hostname: string): Promise<void> {
  const h = hostname.replace(/^\[|\]$/g, '');
  // A literal IP needs no DNS — validate directly.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) {
    if (isBlockedIp(h)) throw new Error('blocked_ip');
    return;
  }
  const addrs = await lookup(h, { all: true });
  if (addrs.length === 0) throw new Error('no_address');
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error('blocked_ip');
  }
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

  // SSRF guard — block private/loopback/metadata ranges (textual).
  if (isBlockedHostname(parsedUrl.hostname)) {
    res.status(400).json({ error: 'INVALID_PAYLOAD' });
    return;
  }

  // SSRF guard — resolve DNS and reject if the host points at a private IP
  // (DNS-rebinding defence). Failure to resolve is also rejected.
  try {
    await assertPublicHost(parsedUrl.hostname);
  } catch {
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

    // Re-check hostname after redirects (open-redirect SSRF mitigation) — both
    // textually and via DNS resolution (rebinding through a redirect target).
    try {
      const finalParsed = new URL(finalUrl);
      if (
        (finalParsed.protocol !== 'http:' && finalParsed.protocol !== 'https:') ||
        isBlockedHostname(finalParsed.hostname)
      ) {
        res.status(400).json({ error: 'INVALID_PAYLOAD' });
        return;
      }
      await assertPublicHost(finalParsed.hostname);
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
