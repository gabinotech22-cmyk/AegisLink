// TODO (A-1, deferred): migrate to Redis ONLY when running >1 relay instance.
// Single-instance today, so in-memory is correct; the cap below bounds memory.
export const RATE_LIMIT_MAP_MAX = 10_000;

/**
 * Bound the size of an in-memory rate-limit map WITHOUT letting an attacker reset
 * a victim's counter. The old code evicted the oldest-INSERTED key (plain FIFO):
 * flooding the map with fresh keys would evict an active victim entry and hand
 * them a clean bucket. Instead, evict only entries whose window has already
 * elapsed (their counter is meaningless anyway); active buckets are never
 * dropped to make room. As a last resort under a pathological all-active map we
 * stop inserting churn rather than evicting a live limit. Keyed by aegisId, all
 * authenticated — and registration now costs an 18-bit PoW (A-2), so minting the
 * thousands of identities needed to fill this map is already expensive.
 */
export function evictExpired(map: Map<string, { count: number; reset: number }>): void {
  if (map.size <= RATE_LIMIT_MAP_MAX) return;
  const now = Date.now();
  for (const [key, entry] of map) {
    if (entry.reset <= now) map.delete(key);
    if (map.size <= RATE_LIMIT_MAP_MAX) return;
  }
}

// Rate-limit buckets for channel:msg — keyed by aegisId, max 120/min
const channelMsgRateLimit = new Map<string, { count: number; reset: number }>();

export function checkChannelMsgRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = channelMsgRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  channelMsgRateLimit.set(aegisId, entry);
  evictExpired(channelMsgRateLimit);
  return entry.count <= 120;
}

// ── Shared low-frequency rate-limit (FIX D) ───────────────────────────────────
// typing + msg:read + msg:delete share a single bucket: 30 ops / 10 s per socket.
// group:rekey has its own stricter bucket: 10 ops / 60 s per aegisId.
// Keyed by aegisId — no IP involved.
const lowFreqRateLimit = new Map<string, { count: number; reset: number }>();
const rekeyRateLimit   = new Map<string, { count: number; reset: number }>();

export function checkLowFreqRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = lowFreqRateLimit.get(aegisId) ?? { count: 0, reset: now + 10_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 10_000; }
  entry.count++;
  lowFreqRateLimit.set(aegisId, entry);
  evictExpired(lowFreqRateLimit);
  return entry.count <= 30;
}

// Raised from 10 to 30 per minute to support large-group re-keys.
// Rationale: with GROUP_REKEY_MAX_DIST=512, an admin re-keying a 512-member
// group needs exactly 1 call (fits in one batch). The extra headroom (30 calls)
// covers concurrent group memberships and retry attempts without opening a
// meaningful DoS vector — sustained abuse would only exhaust the attacker's own
// per-identity bucket, not others'.
export function checkRekeyRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = rekeyRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  rekeyRateLimit.set(aegisId, entry);
  evictExpired(rekeyRateLimit);
  return entry.count <= 30;
}

// ── PreKey rate limits (audit 2026-06) ────────────────────────────────────────
// The HTTP path (routes/prekeys.ts) already throttles uploads, but the SOCKET
// path was unprotected — an authenticated socket could flood SQLite with SPK/OPK
// upserts or hammer prekeys:fetch against any identity. Two routes to the same
// resource; both must be rate-limited. Keyed by aegisId (authenticated), no IP.
const prekeysUploadRateLimit = new Map<string, { count: number; reset: number }>();
const prekeysFetchRateLimit  = new Map<string, { count: number; reset: number }>();

export function checkPrekeysUploadRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = prekeysUploadRateLimit.get(aegisId) ?? { count: 0, reset: now + 600_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 600_000; }
  entry.count++;
  prekeysUploadRateLimit.set(aegisId, entry);
  evictExpired(prekeysUploadRateLimit);
  return entry.count <= 20; // parity with HTTP uploadLimiter: 20 / 10 min
}

export function checkPrekeysFetchRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = prekeysFetchRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  prekeysFetchRateLimit.set(aegisId, entry);
  evictExpired(prekeysFetchRateLimit);
  return entry.count <= 60; // first-contact fan-out headroom: 60 / min
}

// ── device:link rate limit (audit 2026-06, roadmap Ola 3 MED) ─────────────────
// device:link is accepted from UNAUTHENTICATED sockets (the desktop hasn't
// completed challenge-response yet during pairing), so there is no `me` to key
// on. Key by the requested `targetAegisId`: an attacker spamming link requests
// against a victim can't exceed 3 / 15 min for that victim. Excess is dropped
// silently to avoid handing back any signal.
const deviceLinkRateLimit = new Map<string, { count: number; reset: number }>();

export function checkDeviceLinkRateLimit(targetAegisId: string): boolean {
  const now = Date.now();
  const entry = deviceLinkRateLimit.get(targetAegisId) ?? { count: 0, reset: now + 900_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 900_000; }
  entry.count++;
  deviceLinkRateLimit.set(targetAegisId, entry);
  evictExpired(deviceLinkRateLimit);
  return entry.count <= 3; // 3 / 15 min per target identity
}
