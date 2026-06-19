/**
 * Environment-aware relay configuration.
 *
 * Dev  → defaults to the Android Emulator loopback alias (10.0.2.2) or LAN IP
 *        set in .env via EXPO_PUBLIC_SERVER_URL.
 * Prod → defaults to the AWS EC2 instance running the relay + coturn
 *        (aegislink.duckdns.org). Override via EXPO_PUBLIC_SERVER_URL in a
 *        .env.production file or EAS secret if the host changes.
 *
 * AWS EC2 instance (relay + coturn): set EXPO_PUBLIC_RELAY_IP in .env or
 * EAS secrets. All production URLs are derived from that single constant.
 */

/** AWS relay public IP. Override via EAS secret or .env.production. */
const RELAY_IP = (process.env.EXPO_PUBLIC_RELAY_IP as string | undefined) ?? '';

/** Relay port on the AWS instance (matches docker-compose / server config). */
const RELAY_PORT = (process.env.EXPO_PUBLIC_RELAY_PORT as string | undefined) ?? '3001';

/**
 * SERVER_URL — relay/identity backend.
 *
 * Dev default:  http://10.0.2.2:3001  (Android Emulator → host machine)
 * Prod default: http://<RELAY_IP>:<RELAY_PORT>  (AWS EC2 instance)
 *
 * Override at any time via EXPO_PUBLIC_SERVER_URL.
 */
const SERVER_URL_DEV = 'http://10.0.2.2:3001';
// Prod fails CLOSED to the canonical HTTPS host (valid cert + pinning) — never
// cleartext and never the dev loopback, even if RELAY_IP is unset. The explicit
// EXPO_PUBLIC_SERVER_URL (eas.json) still takes precedence below.
const SERVER_URL_PROD = RELAY_IP ? `https://${RELAY_IP}` : 'https://aegislink.duckdns.org';

export const SERVER_URL: string =
  (process.env.EXPO_PUBLIC_SERVER_URL as string | undefined) ??
  // eslint-disable-next-line no-undef
  (__DEV__ ? SERVER_URL_DEV : SERVER_URL_PROD);

/**
 * RELAY_URL — canonical alias used by registration and crypto modules.
 * Falls back to SERVER_URL when EXPO_PUBLIC_RELAY_URL is not set.
 */
export const RELAY_URL: string =
  (process.env.EXPO_PUBLIC_RELAY_URL as string | undefined) ?? SERVER_URL;

/**
 * TURN server URL for coturn on the AWS instance.
 *
 * Default: turn:<RELAY_IP>:3478
 * Override via EXPO_PUBLIC_TURN_URL.
 */
export const TURN_SERVER_URL: string =
  (process.env.EXPO_PUBLIC_TURN_URL as string | undefined) ??
  // eslint-disable-next-line no-undef
  (__DEV__ ? '' : RELAY_IP ? `turn:${RELAY_IP}:3478` : '');

/**
 * ONION_URL — relay Tor hidden service address.
 * Set EXPO_PUBLIC_ONION_URL in .env.production or EAS secrets.
 * Only used when routeViaTor=true in user preferences.
 * null means onion URL not configured (still benefits from Orbot VPN mode).
 */
export const ONION_URL: string | null =
  (process.env.EXPO_PUBLIC_ONION_URL as string | undefined) ?? null;

/**
 * SEALED_TRANSPORT_VERSION — sealed-sender transport for 1:1 chat.
 *   'v1' (default): legacy envelope; the relay stamps `from` on online delivery.
 *   'v2': sealed-sender — the sender's identity never reaches the relay (sealed
 *         inside the box), submission gated by the recipient's delivery token.
 * Opt-in via EXPO_PUBLIC_SEALED_VERSION=v2. v2 degrades to v1 per-contact when
 * the contact's signing key or delivery token isn't available yet (first
 * contact / pre-upgrade peers). See docs/SEALED-SENDER-ARCHITECTURE.md.
 */
export const SEALED_TRANSPORT_VERSION: 'v1' | 'v2' =
  (process.env.EXPO_PUBLIC_SEALED_VERSION as string | undefined) === 'v2' ? 'v2' : 'v1';

/**
 * Fail-fast transport guard. In a production build every backend base URL MUST
 * be https — a misconfigured build that fell back to cleartext would defeat
 * cert pinning and leak identity keys / push tokens / blob ciphertext over the
 * wire. Refuse to run instead of silently downgrading. (`.onion` is exempt: Tor
 * provides its own transport encryption.)
 */
// Developer loopback hosts (emulator host 10.0.2.2 + localhost) are exempt:
// they mirror android/.../network_security_config.xml, which already whitelists
// exactly these for cleartext, and the app never contacts them in production.
// This lets a release APK reach a relay on the developer's machine for E2E tests.
const isLoopbackUrl = (url: string): boolean =>
  /^(https?|wss?):\/\/(10\.0\.2\.2|localhost|127\.0\.0\.1)(:|\/|$)/i.test(url);
// eslint-disable-next-line no-undef
if (!__DEV__) {
  for (const [name, url] of [
    ['SERVER_URL', SERVER_URL],
    ['RELAY_URL', RELAY_URL],
  ] as const) {
    if (!/^https:\/\//i.test(url) && !isLoopbackUrl(url)) {
      throw new Error(`[config] insecure ${name} in a production build: ${url}`);
    }
  }
}

/**
 * True when `url` is safe to load in a production build: https, or a Tor .onion
 * (Tor encrypts its own transport). In __DEV__ everything passes so localhost /
 * LAN dev servers keep working. Non-throwing — use at render/use boundaries for
 * external, relay- or message-derived URLs (OG preview images, GIF results).
 */
export function isSecureUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  // eslint-disable-next-line no-undef
  if (__DEV__) return true;
  return /^https:\/\//i.test(url) || /\.onion(\/|:|$)/i.test(url);
}

/**
 * Guard a (possibly attacker-influenced) URL before fetching it. Throws in a
 * production build on any insecure scheme. Use for URLs that originate from
 * message content / the relay rather than from compile-time env.
 */
export function secureUrl(url: string): string {
  if (!isSecureUrl(url)) {
    throw new Error('[config] refusing to fetch an insecure URL in production');
  }
  return url;
}
