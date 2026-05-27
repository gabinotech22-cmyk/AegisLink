/**
 * Environment-aware relay configuration.
 *
 * Dev  → defaults to the Android Emulator loopback alias (10.0.2.2) or LAN IP
 *        set in .env via EXPO_PUBLIC_SERVER_URL.
 * Prod → defaults to the Oracle Cloud VM IP running the relay + coturn.
 *        Override via EXPO_PUBLIC_SERVER_URL in a .env.production file or EAS
 *        secret if the IP changes.
 *
 * Oracle Cloud VM (relay + coturn): set EXPO_PUBLIC_ORACLE_IP in .env or
 * EAS secrets. All production URLs are derived from that single constant.
 */

/** Oracle Cloud public IP. Override via EAS secret or .env.production. */
const ORACLE_IP = (process.env.EXPO_PUBLIC_ORACLE_IP as string | undefined) ?? '';

/** Relay port on the Oracle VM (matches docker-compose / server config). */
const RELAY_PORT = (process.env.EXPO_PUBLIC_RELAY_PORT as string | undefined) ?? '3001';

/**
 * SERVER_URL — relay/identity backend.
 *
 * Dev default:  http://10.0.2.2:3001  (Android Emulator → host machine)
 * Prod default: http://<ORACLE_IP>:<RELAY_PORT>  (Oracle Cloud VM)
 *
 * Override at any time via EXPO_PUBLIC_SERVER_URL.
 */
const SERVER_URL_DEV = 'http://10.0.2.2:3001';
const SERVER_URL_PROD = ORACLE_IP ? `http://${ORACLE_IP}:${RELAY_PORT}` : SERVER_URL_DEV;

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
 * TURN server URL for coturn on the Oracle VM.
 *
 * Default: turn:<ORACLE_IP>:3478
 * Override via EXPO_PUBLIC_TURN_URL.
 */
export const TURN_SERVER_URL: string =
  (process.env.EXPO_PUBLIC_TURN_URL as string | undefined) ??
  // eslint-disable-next-line no-undef
  (__DEV__ ? '' : ORACLE_IP ? `turn:${ORACLE_IP}:3478` : '');

/**
 * ONION_URL — relay Tor hidden service address.
 * Set EXPO_PUBLIC_ONION_URL in .env.production or EAS secrets.
 * Only used when routeViaTor=true in user preferences.
 * null means onion URL not configured (still benefits from Orbot VPN mode).
 */
export const ONION_URL: string | null =
  (process.env.EXPO_PUBLIC_ONION_URL as string | undefined) ?? null;
