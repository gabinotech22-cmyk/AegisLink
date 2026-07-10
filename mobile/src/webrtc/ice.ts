/**
 * ICE server config for WebRTC peer connections.
 *
 * ZERO third-party STUN. We NEVER query public STUN (Google/Cloudflare): doing so
 * would reveal "this AegisLink user is calling now, from this IP" to an outside
 * party — a metadata leak that contradicts the zero-metadata promise, even though
 * forceRelay keeps that IP away from the peer. Our own coturn serves STUN natively
 * on the same host/port as TURN (no `no-stun` in turnserver.conf), so every STUN
 * candidate comes from infrastructure we control. Self-host coturn in the same VPS
 * as the relay; set EXPO_PUBLIC_TURN_URL / USER / PASS in `.env`.
 *
 * For production use, call `fetchTurnConfig(aegisId)` before each call to obtain
 * ephemeral HMAC-SHA1 credentials from the relay (TTL 1h); the relay's response
 * also advertises our own stun: URL. Falls back to `rtcConfig()` on any fetch
 * failure — which derives STUN from the configured TURN host, never a third party.
 * With no TURN configured (dev without coturn) the result has NO STUN entry at
 * all (host candidates only) rather than falling back to a public server.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeUTF8 } from 'tweetnacl-util';
import { RELAY_URL as SERVER_URL, TURN_SERVER_URL } from '../config';

export interface RTCConfigShape {
  iceServers: { urls: string | string[]; username?: string; credential?: string }[];
  iceTransportPolicy?: 'all' | 'relay';
}

/**
 * TURN_URL resolution order:
 * 1. EXPO_PUBLIC_TURN_URL env var (explicit override)
 * 2. TURN_SERVER_URL from config (derived from RELAY_IP in prod, empty in dev)
 */
const TURN_URL =
  (process.env.EXPO_PUBLIC_TURN_URL as string | undefined) ?? TURN_SERVER_URL;
const TURN_USERNAME = (process.env.EXPO_PUBLIC_TURN_USERNAME as string | undefined) ?? '';
const TURN_PASSWORD = (process.env.EXPO_PUBLIC_TURN_PASSWORD as string | undefined) ?? '';

/**
 * Derive a `stun:` URL from our own TURN URL (same host+port). coturn serves STUN
 * on the TURN port, so this yields server-reflexive candidates from OUR server —
 * never a third party. Strips any `?transport=` query and swaps the turn/turns
 * scheme for stun. Returns null for an empty/malformed TURN URL (→ no STUN entry).
 */
function deriveStunUrl(turnUrl: string): string | null {
  const noQuery = turnUrl.split('?')[0];
  const m = /^turns?:(.+)$/.exec(noQuery);
  return m ? `stun:${m[1]}` : null;
}

/**
 * When `forceRelay` is true the peer connection ONLY emits relay (TURN) ICE
 * candidates — host and server-reflexive candidates are suppressed so neither
 * peer's real IP address ever appears in the signaling exchange. This is the
 * privacy-preserving default; it requires a reachable TURN server. Callers may
 * pass `false` to permit direct (lower-latency) connectivity when IP exposure
 * to the peer is acceptable.
 */
export function rtcConfig(forceRelay: boolean = true): RTCConfigShape {
  const iceServers: RTCConfigShape['iceServers'] = [];
  // STUN is derived from OUR TURN host (coturn serves STUN on the same port).
  // No third-party public STUN — see file header. With no TURN configured this
  // list stays empty (host candidates only), never a public fallback.
  const stunUrl = TURN_URL ? deriveStunUrl(TURN_URL) : null;
  if (stunUrl) iceServers.push({ urls: [stunUrl] });
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

  // A-7 auth: minting TURN credentials requires proof of a registered identity.
  // We sign `${aegisId}:turn:${timeBucket}` with the ACTIVE identity's Ed25519
  // signing key (the same key the relay holds), exactly like POST /prekeys. The
  // active identity is the authoritative signer, so we read aegisId + signing
  // key from the store (lazy require avoids a static import cycle) rather than
  // trusting the passed-in id. No identity → no creds (STUN-only fallback).
  let signed: { aegisId: string; sig: string; ts: number } | null = null;
  try {
    const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
    const id = useIdentity.getState().identity;
    if (id?.signingSecretKey) {
      const ts = Date.now();
      const bucket = Math.floor(ts / 30_000);
      const sig = encodeBase64(
        nacl.sign.detached(decodeUTF8(`${id.aegisId}:turn:${bucket}`), id.signingSecretKey),
      );
      signed = { aegisId: id.aegisId, sig, ts };
    }
  } catch { /* store unavailable (tests) → STUN fallback below */ }
  if (!signed) return rtcConfig(forceRelay);

  try {
    const query =
      `aegisId=${encodeURIComponent(signed.aegisId)}` +
      `&sig=${encodeURIComponent(signed.sig)}` +
      `&ts=${signed.ts}`;
    const res = await fetch(
      `${SERVER_URL}/turn/credentials?${query}`,
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
    const iceServers: RTCConfigShape['iceServers'] = [];
    if (resolvedUrls.length > 0) {
      iceServers.push({ urls: resolvedUrls, username, credential: cred });
    }
    // The relay now advertises its OWN stun: URL inside `urls` (same coturn host),
    // so no third-party STUN is ever needed. If it didn't (older relay, or we fell
    // back to the static TURN_URL), derive a stun: entry from our TURN host — never
    // a public server (metadata leak). No TURN at all → no STUN entry.
    if (!resolvedUrls.some((u) => u.startsWith('stun:'))) {
      const stunUrl = TURN_URL ? deriveStunUrl(TURN_URL) : null;
      if (stunUrl) iceServers.unshift({ urls: [stunUrl] });
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
