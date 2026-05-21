/**
 * ICE server config for WebRTC peer connections.
 *
 * Public STUN works for direct connectivity when at least one peer is on an
 * unrestricted NAT. For symmetric NATs (common on mobile carriers ~20% of the
 * time), TURN is required to relay media. Self-host coturn in the same VPS
 * as the relay; set EXPO_PUBLIC_TURN_URL / USER / PASS in `.env`.
 *
 * For production use, call `fetchTurnConfig(aegisId)` before each call to
 * obtain ephemeral HMAC-SHA1 credentials from the relay (TTL 24h). Falls back
 * to `rtcConfig()` (static env creds or STUN-only) on any fetch failure.
 */

import { SERVER_URL, TURN_SERVER_URL } from '../config';

export interface RTCConfigShape {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  iceTransportPolicy?: 'all' | 'relay';
}

/**
 * TURN_URL resolution order:
 * 1. EXPO_PUBLIC_TURN_URL env var (explicit override)
 * 2. TURN_SERVER_URL from config (derived from ORACLE_IP in prod, empty in dev)
 */
const TURN_URL =
  (process.env.EXPO_PUBLIC_TURN_URL as string | undefined) ?? TURN_SERVER_URL;
const TURN_USERNAME = (process.env.EXPO_PUBLIC_TURN_USERNAME as string | undefined) ?? '';
const TURN_PASSWORD = (process.env.EXPO_PUBLIC_TURN_PASSWORD as string | undefined) ?? '';

export function rtcConfig(): RTCConfigShape {
  const iceServers: RTCConfigShape['iceServers'] = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ];
  if (TURN_URL) {
    iceServers.push({
      urls: TURN_URL,
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    });
  }
  return { iceServers };
}

/**
 * Fetches ephemeral TURN credentials from the relay before each call.
 * The relay generates short-lived HMAC-SHA1 credentials (TTL 1h) so the
 * static password is never embedded in the client build.
 *
 * Result is cached for 50 minutes (credentials have a 1-hour TTL).
 *
 * Falls back silently to `rtcConfig()` (static env creds or STUN-only) if:
 * - the relay is unreachable / times out in 3 s
 * - the relay has no TURN configured (non-2xx response)
 * - any network or parse error
 */

/** In-memory cache: keyed per aegisId so multi-profile users get their own creds. */
const _cache = new Map<string, { config: RTCConfigShape; expiresAt: number }>();

/** Cache TTL in ms: 50 minutes (tokens are valid for 1 hour). */
const CACHE_TTL_MS = 50 * 60 * 1000;

export async function fetchTurnConfig(aegisId: string): Promise<RTCConfigShape> {
  // Return cached result if still fresh
  const cached = _cache.get(aegisId);
  if (cached && Date.now() < cached.expiresAt) return cached.config;

  try {
    const res = await fetch(
      `${SERVER_URL}/turn/credentials?aegisId=${encodeURIComponent(aegisId)}`,
      { signal: AbortSignal.timeout(3000) },
    );
    if (!res.ok) return rtcConfig();
    const { username, password } = (await res.json()) as {
      username: string;
      password: string;
      ttl: number;
    };
    const iceServers: RTCConfigShape['iceServers'] = [
      { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    ];
    if (TURN_URL) {
      iceServers.push({ urls: TURN_URL, username, credential: password });
    }
    const config: RTCConfigShape = { iceServers };
    _cache.set(aegisId, { config, expiresAt: Date.now() + CACHE_TTL_MS });
    return config;
  } catch {
    // Network error, timeout, or parse failure — degrade gracefully to STUN / static creds
    return rtcConfig();
  }
}

/** Clear the TURN credential cache (call on logout or identity reset). */
export function clearTurnCache(): void {
  _cache.clear();
}
