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
/**
 * If `h` (a lowercased, bracket-stripped host) denotes an IPv4 address — plain
 * dotted, IPv4-mapped IPv6 in dotted form (`::ffff:127.0.0.1`) OR the hex form
 * (`::ffff:7f00:1`, `::7f00:1`, or fully-expanded `0:0:0:0:0:ffff:7f00:1`) —
 * return its canonical dotted-decimal string, else null. The hex form was the
 * SSRF bypass: `::ffff:a9fe:a9fe` == 169.254.169.254 slipped past a dotted-only
 * regex, reaching cloud metadata / loopback. See security audit 2026-07.
 */
export function canonicalIpv4(h: string): string | null {
  const dotted = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (dotted) {
    const o = dotted.slice(1, 5).map(Number);
    return o.every((n) => n <= 255) ? o.join('.') : null;
  }
  const hex = /^(?:::ffff:|::|0:0:0:0:0:ffff:|0:0:0:0:0:0:)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    if (hi <= 0xffff && lo <= 0xffff) {
      return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
    }
  }
  return null;
}

/** True when a literal IP string is in a private/loopback/link-local/metadata range. */
export function isBlockedIp(ip: string): boolean {
  const h = ip.replace(/^\[|\]$/g, '').toLowerCase();

  // Canonicalise any embedded IPv4 (plain, dotted-mapped, or hex-mapped IPv6) to
  // dotted form BEFORE the range checks, so `::ffff:a9fe:a9fe` is treated exactly
  // like 169.254.169.254 instead of slipping through as an opaque IPv6 literal.
  const v4 = canonicalIpv4(h);
  if (v4) {
    const [a, b] = v4.split('.').map(Number);
    if (a === 127) return true;                       // loopback 127.0.0.0/8
    if (a === 0) return true;                          // unspecified / invalid
    if (a === 10) return true;                         // RFC 1918
    if (a === 172 && b >= 16 && b <= 31) return true;  // RFC 1918
    if (a === 192 && b === 168) return true;           // RFC 1918
    if (a === 169 && b === 254) return true;           // link-local (AWS/GCP/Hetzner IMDS)
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
    // Public address — fall through to the IPv6 literal checks below.
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
    // Manual redirect handling: validate EVERY hop's host (textual + DNS) BEFORE
    // issuing the request to it. `redirect:'follow'` let undici reach intermediate
    // hosts (internal services, cloud metadata) before the code could re-check —
    // a blind SSRF via open-redirect. Now each Location is re-validated as a fresh
    // target and never followed blindly. See security audit 2026-07 (M6).
    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let upstream: Response | null = null;
    for (let hop = 0; ; hop++) {
      const hopParsed = new URL(currentUrl);
      if (
        (hopParsed.protocol !== 'http:' && hopParsed.protocol !== 'https:') ||
        isBlockedHostname(hopParsed.hostname)
      ) {
        res.status(400).json({ error: 'INVALID_PAYLOAD' });
        return;
      }
      // Throws on a blocked/unresolvable host; the outer catch turns it into a
      // generic error response WITHOUT the request ever being issued.
      await assertPublicHost(hopParsed.hostname);

      const resp = await fetch(currentUrl, {
        signal: controller.signal,
        headers: {
          // Request only the first 8 KB; many servers honour this.
          Range: 'bytes=0-8191',
          'User-Agent': 'AegisLinkRelay/1.0 (+linkpreview)',
          // Do not send cookies or credentials to the upstream host.
          Cookie: '',
        },
        redirect: 'manual',
      });

      const location =
        resp.status >= 300 && resp.status < 400 ? resp.headers.get('location') : null;
      if (location) {
        if (hop >= MAX_REDIRECTS) {
          res.status(400).json({ error: 'INVALID_PAYLOAD' });
          return;
        }
        // Resolve relative Location against the current URL; the next loop
        // iteration validates it before any request is made.
        currentUrl = new URL(location, currentUrl).href;
        continue;
      }
      upstream = resp;
      break;
    }

    clearTimeout(timeout);

    if (!upstream) {
      res.status(504).json({ error: 'preview_unavailable' });
      return;
    }

    // The final URL after any redirects — used to resolve relative image URLs.
    const finalUrl = upstream.url || currentUrl;

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
