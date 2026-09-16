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
 *   - DNS is resolved ONCE per hop and the connection is pinned to the validated
 *     address (undici Agent with a fixed `lookup`), so a rebinding name cannot
 *     answer public to the check and private to the connect (audit 2026-09-16 AL-03).
 *   - At most 8 KB of the response body are ever read into memory: the stream is
 *     cancelled at 8192 bytes regardless of what the server sends (Range is only a hint).
 *   - 5-second AbortController timeout prevents slow-drip attacks.
 *   - Relative og:image URLs are resolved against the final (post-redirect) URL.
 */

import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { lookup } from 'node:dns/promises';
import { fetch as undiciFetch, Agent, type Dispatcher } from 'undici';
import type { LookupOptions } from 'node:dns';

/** Hard cap on bytes read from an upstream body. */
export const MAX_PREVIEW_BYTES = 8192;

export interface ResolvedAddr { address: string; family: number }

/**
 * A `net.connect`-compatible lookup that never touches DNS: it answers with the
 * addresses `assertPublicHost` already validated. Handles both call shapes Node
 * uses (`options.all` → array of {address, family}; otherwise a single address).
 */
export function pinnedLookup(addrs: readonly ResolvedAddr[]) {
  return (
    _hostname: string,
    options: LookupOptions,
    cb: (err: NodeJS.ErrnoException | null, address: string | ResolvedAddr[], family?: number) => void,
  ): void => {
    const first = addrs[0];
    if (!first) { cb(Object.assign(new Error('no_address'), { code: 'ENOTFOUND' }), ''); return; }
    if (options.all) cb(null, addrs.map((a) => ({ address: a.address, family: a.family })));
    else cb(null, first.address, first.family);
  };
}

/**
 * Seams for tests (no network in CI): DNS resolution, the dispatcher factory
 * that pins the connection to validated addresses, and fetch itself.
 */
export const __deps = {
  lookup: (host: string) => lookup(host, { all: true }),
  makeDispatcher: (addrs: readonly ResolvedAddr[]): Dispatcher =>
    new Agent({ connect: { lookup: pinnedLookup(addrs) } }),
  fetch: undiciFetch,
};

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
 * any blocked/failed resolution.
 *
 * Returns the validated addresses so the caller can PIN the connection to them
 * (audit 2026-09-16 AL-03): the old code validated here and then let fetch()
 * resolve the name a second time, leaving a TOCTOU window a rebinding DNS server
 * could exploit. Now the fetch never resolves DNS at all.
 */
async function assertPublicHost(hostname: string): Promise<ResolvedAddr[]> {
  const h = hostname.replace(/^\[|\]$/g, '');
  // A literal IP needs no DNS — validate directly.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':')) {
    if (isBlockedIp(h)) throw new Error('blocked_ip');
    return [{ address: h, family: h.includes(':') ? 6 : 4 }];
  }
  const addrs = await __deps.lookup(h);
  if (addrs.length === 0) throw new Error('no_address');
  for (const { address } of addrs) {
    if (isBlockedIp(address)) throw new Error('blocked_ip');
  }
  return addrs.map((a) => ({ address: a.address, family: a.family }));
}

/**
 * Read at most `limit` bytes from a body and cancel the stream — never buffer
 * the whole response (AL-03: `arrayBuffer()` let a hostile server push an
 * unbounded body into relay memory before the 8 KB slice).
 */
export async function readBounded(body: ReadableStream<Uint8Array> | null, limit: number): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < limit) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const room = limit - total;
      const piece = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(piece);
      total += piece.byteLength;
    }
  } finally {
    // Stop the upstream transfer as soon as we have what we need.
    reader.cancel().catch(() => { /* already closed */ });
  }
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.byteLength; }
  return out;
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

  // DNS validation happens per hop inside the loop below (hop 0 included), so
  // the first hop is resolved exactly once and that answer pins its connection.

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  // The per-hop dispatcher pinned to validated addresses; closed in `finally`.
  let dispatcher: Dispatcher | null = null;

  try {
    // Manual redirect handling: validate EVERY hop's host (textual + DNS) BEFORE
    // issuing the request to it. `redirect:'follow'` let undici reach intermediate
    // hosts (internal services, cloud metadata) before the code could re-check —
    // a blind SSRF via open-redirect. Now each Location is re-validated as a fresh
    // target and never followed blindly. See security audit 2026-07 (M6).
    const MAX_REDIRECTS = 5;
    let currentUrl = url;
    let upstream: Awaited<ReturnType<typeof undiciFetch>> | null = null;
    for (let hop = 0; ; hop++) {
      const hopParsed = new URL(currentUrl);
      if (
        (hopParsed.protocol !== 'http:' && hopParsed.protocol !== 'https:') ||
        isBlockedHostname(hopParsed.hostname)
      ) {
        res.status(400).json({ error: 'INVALID_PAYLOAD' });
        return;
      }
      // Blocked/unresolvable host → 400 like the textual block, and the
      // request to it is never issued.
      let addrs: ResolvedAddr[];
      try {
        addrs = await assertPublicHost(hopParsed.hostname);
      } catch {
        clearTimeout(timeout);
        res.status(400).json({ error: 'INVALID_PAYLOAD' });
        return;
      }

      // Pin THIS hop's connection to the addresses just validated. Host header
      // and TLS SNI still carry the hostname; only the socket target is fixed.
      if (dispatcher) void dispatcher.close();
      dispatcher = __deps.makeDispatcher(addrs);

      const resp = await __deps.fetch(currentUrl, {
        dispatcher,
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

    if (!upstream) {
      clearTimeout(timeout);
      res.status(504).json({ error: 'preview_unavailable' });
      return;
    }

    // The final URL after any redirects — used to resolve relative image URLs.
    const finalUrl = upstream.url || currentUrl;

    if (!upstream.ok) {
      clearTimeout(timeout);
      void upstream.body?.cancel().catch(() => { /* ignore */ });
      // Only log aggregated status codes — never the URL.
      console.error(`[proxy/linkpreview] upstream HTTP ${upstream.status}`);
      res.status(504).json({ error: 'preview_unavailable' });
      return;
    }

    const contentType = upstream.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      clearTimeout(timeout);
      void upstream.body?.cancel().catch(() => { /* ignore */ });
      // Non-HTML (e.g. binary, video) — no OG data to extract.
      res.json({ title: null, description: null, image: null, url: finalUrl });
      return;
    }

    // Read at most 8 KB regardless of what the server sends — the timeout still
    // covers the body read so a slow-drip server cannot hold the request open.
    const sliced = await readBounded(upstream.body, MAX_PREVIEW_BYTES);
    clearTimeout(timeout);
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
  } finally {
    if (dispatcher) void dispatcher.close();
  }
});

export default router;
