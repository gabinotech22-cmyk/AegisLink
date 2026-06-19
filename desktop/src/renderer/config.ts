/**
 * RELAY_URL — relay/identity backend for Electron renderer.
 *
 * Override by setting VITE_RELAY_URL in a .env file at desktop/ root.
 * Defaults to localhost:3001 (dev server running on same machine).
 */
export const RELAY_URL =
  (import.meta.env.VITE_RELAY_URL as string | undefined) ?? 'http://localhost:3001';

export const SERVER_URL = RELAY_URL;

export const TURN_URL =
  (import.meta.env.VITE_TURN_URL as string | undefined) ?? '';

export const TURN_USERNAME =
  (import.meta.env.VITE_TURN_USERNAME as string | undefined) ?? '';

export const TURN_PASSWORD =
  (import.meta.env.VITE_TURN_PASSWORD as string | undefined) ?? '';

/**
 * SEALED_TRANSPORT_VERSION — sealed-sender transport for 1:1 chat. Parity with
 * mobile. 'v1' (default) or 'v2' via VITE_SEALED_VERSION=v2. v2 degrades to v1
 * per-contact when the contact's signing key / delivery token isn't available.
 * See docs/SEALED-SENDER-ARCHITECTURE.md.
 */
export const SEALED_TRANSPORT_VERSION: 'v1' | 'v2' =
  (import.meta.env.VITE_SEALED_VERSION as string | undefined) === 'v2' ? 'v2' : 'v1';
