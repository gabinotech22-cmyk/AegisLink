import { redis } from './redisClient.js';
import { logger } from './logger.js';


// TODO (A-1, deferred): migrate to Redis ONLY when running >1 relay instance.
// Single-instance today, so in-memory is correct; the cap below bounds memory.
export const RATE_LIMIT_MAP_MAX = 10_000;

const INCR_EXPIRE_LUA = `
local count = redis.call("INCR", KEYS[1])
if count == 1 then
  redis.call("EXPIRE", KEYS[1], ARGV[1])
end
return count
`;

export async function redisIncrAtomic(key: string, ttlSeconds: number): Promise<number | null> {
  if (!redis) return null;
  try {
    return await redis.eval(INCR_EXPIRE_LUA, 1, key, ttlSeconds) as number;
  } catch (err) {
    logger.error('Redis atomic incr failed', { message: err instanceof Error ? err.message : String(err) });
    return null;
  }
}

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

export async function checkChannelMsgRateLimit(aegisId: string): Promise<boolean> {
  const count = await redisIncrAtomic(`ratelimit:channelMsg:${aegisId}`, 60);
  if (count !== null) return count <= 120;
  const now = Date.now();
  const entry = channelMsgRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  channelMsgRateLimit.set(aegisId, entry);
  evictExpired(channelMsgRateLimit);
  return entry.count <= 120;
}

// ── Shared low-frequency rate-limit (FIX D) ───────────────────────────────────
// typing + msg:read share a single bucket: 30 ops / 10 s per socket.
// group:rekey has its own stricter bucket: 10 ops / 60 s per aegisId.
// Keyed by aegisId — no IP involved.
const lowFreqRateLimit = new Map<string, { count: number; reset: number }>();
const rekeyRateLimit   = new Map<string, { count: number; reset: number }>();

export async function checkLowFreqRateLimit(aegisId: string): Promise<boolean> {
  const count = await redisIncrAtomic(`ratelimit:lowFreq:${aegisId}`, 10);
  if (count !== null) return count <= 30;
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
export async function checkRekeyRateLimit(aegisId: string): Promise<boolean> {
  const count = await redisIncrAtomic(`ratelimit:rekey:${aegisId}`, 60);
  if (count !== null) return count <= 30;
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

export async function checkPrekeysUploadRateLimit(aegisId: string): Promise<boolean> {
  const count = await redisIncrAtomic(`ratelimit:prekeysUpload:${aegisId}`, 600);
  if (count !== null) return count <= 20;
  const now = Date.now();
  const entry = prekeysUploadRateLimit.get(aegisId) ?? { count: 0, reset: now + 600_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 600_000; }
  entry.count++;
  prekeysUploadRateLimit.set(aegisId, entry);
  evictExpired(prekeysUploadRateLimit);
  return entry.count <= 20; // parity with HTTP uploadLimiter: 20 / 10 min
}

export async function checkPrekeysFetchRateLimit(aegisId: string): Promise<boolean> {
  const count = await redisIncrAtomic(`ratelimit:prekeysFetch:${aegisId}`, 60);
  if (count !== null) return count <= 60;
  const now = Date.now();
  const entry = prekeysFetchRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  prekeysFetchRateLimit.set(aegisId, entry);
  evictExpired(prekeysFetchRateLimit);
  return entry.count <= 60; // first-contact fan-out headroom: 60 / min
}

// ── pubchannel:apply rate limit (audit delta 2026-07-03) ──────────────────────
// pubchannel:apply is deliberately anonymous (no signature, no aegisId — the
// applicant's identity stays sealed inside the join envelope), so there is no
// per-identity key to throttle on. Key by the TARGET channelId instead: it
// bounds how fast anyone can churn a channel's pending-join queue toward the
// MAX_PENDING_JOINS_PER_CHANNEL cap (previously an attacker who knew a public
// channelId could fill all 256 slots in one tight loop, locking out legitimate
// applicants). 20/min leaves ample headroom for organic join bursts.
const pubchannelApplyRateLimit = new Map<string, { count: number; reset: number }>();

export async function checkPubchannelApplyRateLimit(channelId: string): Promise<boolean> {
  const count = await redisIncrAtomic(`ratelimit:pubchannelApply:${channelId}`, 60);
  if (count !== null) return count <= 20;
  const now = Date.now();
  const entry = pubchannelApplyRateLimit.get(channelId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  pubchannelApplyRateLimit.set(channelId, entry);
  evictExpired(pubchannelApplyRateLimit);
  return entry.count <= 20;
}

// ── device:link rate limit (audit 2026-06, roadmap Ola 3 MED) ─────────────────
// device:link is accepted from UNAUTHENTICATED sockets (the desktop hasn't
// completed challenge-response yet during pairing), so there is no `me` to key
// on. Key by the requested `targetAegisId`: an attacker spamming link requests
// against a victim can't exceed 3 / 15 min for that victim. Excess is dropped
// silently to avoid handing back any signal.
const deviceLinkRateLimit = new Map<string, { count: number; reset: number }>();

export async function checkDeviceLinkRateLimit(targetAegisId: string): Promise<boolean> {
  const count = await redisIncrAtomic(`ratelimit:deviceLink:${targetAegisId}`, 900);
  if (count !== null) return count <= 3;
  const now = Date.now();
  const entry = deviceLinkRateLimit.get(targetAegisId) ?? { count: 0, reset: now + 900_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 900_000; }
  entry.count++;
  deviceLinkRateLimit.set(targetAegisId, entry);
  evictExpired(deviceLinkRateLimit);
  return entry.count <= 3; // 3 / 15 min per target identity
}
