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
