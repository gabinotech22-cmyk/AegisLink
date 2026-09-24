/**
 * relayLimiter — HTTP rate limiting that stays per-client when clients arrive
 * over Tor.
 *
 * Clients reach the relay two ways:
 *   - **clearnet**: nginx → relay. nginx always sets `X-Forwarded-For`, so
 *     `req.ip` (with `trust proxy`) is the real client address and a per-IP
 *     bucket is meaningful — this path is unchanged.
 *   - **onion**: the Tor sidecar → relay:3001 directly (docs/RELAY-ONION-SERVICE.md;
 *     self-hosted relays are onion-only, docs/SELF-HOSTING.md). There is no
 *     reverse proxy, so no `X-Forwarded-For`, and every request carries the same
 *     socket address — the Tor container. A per-IP bucket there would put EVERY
 *     Tor user in one bucket: one abuser (or plain growth) locks everyone out.
 *
 * Since every mobile and desktop client now reaches the official relay over its
 * onion (docs/SEALED-SENDER-ARCHITECTURE.md §6.2), onion requests get a different
 * policy instead of a per-IP one:
 *   - `identity`: routes that carry a signed identity (prekeys, TURN, delete…)
 *     are limited PER IDENTITY with the same window/max as the per-IP bucket, and
 *     only requests the route accepted count (`skipFailedRequests`). A forged
 *     request naming someone else's id is rejected by the signature check and
 *     does not spend that person's budget.
 *   - `shared`: anonymous routes (PoW challenges, lookups, blobs, proxies) have no
 *     per-client key over Tor; their real anti-abuse is proof-of-work and
 *     unguessable ids. They keep only the flood backstop below.
 * Both policies also get a **flood backstop**: one bucket shared by all onion
 * clients of that route, `max × AEGIS_ONION_FLOOD_MULT` (default 50). It protects
 * the relay's CPU. It does not give each client a fair share.
 *
 * An onion request is recognised by: no `X-Forwarded-For` AND a v3 `.onion` Host.
 * The relay port is bound to loopback / the internal Docker network only
 * (docker-compose.yml), so a clearnet client can only arrive through nginx,
 * which always adds `X-Forwarded-For`. It therefore cannot claim the onion
 * policy by forging a Host header.
 *
 * Zero-metadata: buckets live in express-rate-limit's in-memory store and are
 * never persisted or logged; 429 bodies carry no address.
 */
import type { Request, RequestHandler } from 'express';
import rateLimit from 'express-rate-limit';

const ONION_HOST_RE = /^[a-z2-7]{56}\.onion(?::\d+)?$/;

/** True when the request came through our onion service rather than nginx. */
export function isOnionRequest(req: Request): boolean {
  if (req.headers['x-forwarded-for'] !== undefined) return false;
  return ONION_HOST_RE.test(String(req.headers.host ?? '').toLowerCase());
}

function floodMultiplier(): number {
  const n = Number(process.env['AEGIS_ONION_FLOOD_MULT'] ?? 50);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 50;
}

export type OnionPolicy =
  /** Per-identity bucket; `key` returns the identity the request claims (null → shared). */
  | { kind: 'identity'; key: (req: Request) => string | null }
  | { kind: 'shared' };

export interface RelayLimiterOptions {
  windowMs: number;
  /** Per-IP (clearnet) and per-identity (onion) ceiling. */
  max: number;
  onion: OnionPolicy;
  /** JSON body of the 429 response (routes keep their historical error shape). */
  body: Record<string, unknown>;
  /** Override for the onion flood backstop (default `max × AEGIS_ONION_FLOOD_MULT`). */
  onionFloodMax?: number;
}

export function relayLimiter(o: RelayLimiterOptions): RequestHandler {
  const common = {
    windowMs: o.windowMs,
    standardHeaders: true,
    legacyHeaders: false,
    handler: (_req: Request, res: Parameters<RequestHandler>[1]) => {
      res.status(429).json(o.body);
    },
  } as const;

  const byIp = rateLimit({ ...common, limit: o.max });
  const onionFlood = rateLimit({
    ...common,
    limit: o.onionFloodMax ?? o.max * floodMultiplier(),
    keyGenerator: () => 'onion',
  });
  const policy = o.onion;
  const onionIdentity =
    policy.kind === 'identity'
      ? rateLimit({
          ...common,
          limit: o.max,
          skipFailedRequests: true,
          keyGenerator: (req) => `id:${policy.key(req) ?? '-'}`,
        })
      : null;

  return (req, res, next) => {
    if (!isOnionRequest(req)) {
      void byIp(req, res, next);
      return;
    }
    void onionFlood(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      if (!onionIdentity) {
        next();
        return;
      }
      void onionIdentity(req, res, next);
    });
  };
}

/** Reads a string field from the parsed JSON body (null when absent / not a string). */
export function bodyField(name: string): (req: Request) => string | null {
  return (req) => {
    const v = (req.body as Record<string, unknown> | undefined)?.[name];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
}

/** Reads a string query parameter (null when absent / not a string). */
export function queryField(name: string): (req: Request) => string | null {
  return (req) => {
    const v = req.query[name];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
}

/** Reads a route parameter (null when absent). */
export function paramField(name: string): (req: Request) => string | null {
  return (req) => {
    const v = req.params[name];
    return typeof v === 'string' && v.length > 0 ? v : null;
  };
}
