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

import { RELAY_URL as SERVER_URL, TURN_SERVER_URL } from '../config';

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

/**
 * When `forceRelay` is true the peer connection ONLY emits relay (TURN) ICE
 * candidates — host and server-reflexive candidates are suppressed so neither
 * peer's real IP address ever appears in the signaling exchange. This is the
 * privacy-preserving default; it requires a reachable TURN server. Callers may
 * pass `false` to permit direct (lower-latency) connectivity when IP exposure
 * to the peer is acceptable.
 */
export function rtcConfig(forceRelay: boolean = true): RTCConfigShape {
  const iceServers: RTCConfigShape['iceServers'] = [
    { urls: [
      'stun:stun.l.google.com:19302',
      'stun:stun1.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ] },
  ];
  if (TURN_URL) {
    iceServers.push({
      urls: TURN_URL,
      username: TURN_USERNAME,
      credential: TURN_PASSWORD,
    });
  }
  const config: RTCConfigShape = { iceServers };
  // Only force relay when a TURN server is actually configured; otherwise a
  // relay-only policy would yield zero candidates and the call could never
  // connect. Privacy is preserved when TURN exists; we degrade gracefully when
  // it does not.
  if (forceRelay && TURN_URL) config.iceTransportPolicy = 'relay';
  return config;
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

export async function fetchTurnConfig(aegisId: string, forceRelay: boolean = true): Promise<RTCConfigShape> {
  // Return cached result if still fresh
  const cacheKey = `${aegisId}|${forceRelay ? 'relay' : 'all'}`;
  const cached = _cache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.config;

  try {
    const res = await fetch(
      `${SERVER_URL}/turn/credentials?aegisId=${encodeURIComponent(aegisId)}`,
      { signal: (() => { const c = new AbortController(); setTimeout(() => c.abort(), 3000); return c.signal; })() },
    );
    if (!res.ok) return rtcConfig(forceRelay);
    // Server returns { urls, username, credential, ttl }
    // Accept both `credential` and legacy `password` field names.
    const { username, credential, password, urls: turnUrls } = (await res.json()) as {
      username: string;
      credential?: string;
      password?: string;
      urls?: string[];
      ttl: number;
    };
    const cred = credential ?? password ?? '';
    // Prefer the `urls` array returned by the server (includes UDP+TCP+TLS variants).
    // Fall back to the static TURN_URL env var if the server didn't return urls.
    const resolvedUrls: string[] = (turnUrls && turnUrls.length > 0)
      ? turnUrls
      : (TURN_URL ? [TURN_URL] : []);
    const iceServers: RTCConfigShape['iceServers'] = [
      { urls: [
        'stun:stun.l.google.com:19302',
        'stun:stun1.l.google.com:19302',
        'stun:stun.cloudflare.com:3478',
      ] },
    ];
    if (resolvedUrls.length > 0) {
      iceServers.push({ urls: resolvedUrls, username, credential: cred });
    }
    const config: RTCConfigShape = { iceServers };
    // Relay-only ICE keeps both peers' real IPs out of the signaling exchange.
    // Only enforce it when ephemeral TURN creds were actually obtained.
    if (forceRelay && resolvedUrls.length > 0) config.iceTransportPolicy = 'relay';
    _cache.set(cacheKey, { config, expiresAt: Date.now() + CACHE_TTL_MS });
    return config;
  } catch {
    // Network error, timeout, or parse failure — degrade gracefully to STUN / static creds
    return rtcConfig(forceRelay);
  }
}

/** Clear the TURN credential cache (call on logout or identity reset). */
export function clearTurnCache(): void {
  _cache.clear();
}
