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
 * mobile. 'v2' (default, A-6 Fases 1-3) or 'v1' (opt-out escape hatch) via
 * VITE_SEALED_VERSION=v1. v2 degrades to v1 per-contact when the contact's
 * signing key / delivery token isn't available. See docs/SEALED-SENDER-ARCHITECTURE.md.
 */
export const SEALED_TRANSPORT_VERSION: 'v1' | 'v2' =
  (import.meta.env.VITE_SEALED_VERSION as string | undefined) === 'v1' ? 'v1' : 'v2';

/**
 * ONION_URL — relay Tor hidden service address (parity with mobile). Set
 * VITE_ONION_URL in a .env at desktop/ root. Required for mailbox mode below.
 */
export const ONION_URL: string | null =
  (import.meta.env.VITE_ONION_URL as string | undefined) ?? null;

/**
 * MAILBOX_MODE / MAILBOX_ENABLED — sealed-sender Fase 4: hide the recipient
 * (`to`) from the relay by addressing a rotating, opaque mailbox id over a
 * dedicated delivery socket. Parity with mobile/src/config.ts. Opt IN via
 * VITE_MAILBOX_MODE=on. Live cutover is validated by the 2-device test, not unit
 * tests. Default OFF.
 *
 * Fail-closed: enabling it REQUIRES Tor (ONION_URL present), so the opaque
 * mailbox socket can't be relinked to our IP next to the aegisId control socket.
 * Without Tor, MAILBOX_ENABLED is false and delivery stays on the aegisId
 * transport rather than ship a relinkable "private" mode.
 */
export const MAILBOX_MODE: boolean =
  (import.meta.env.VITE_MAILBOX_MODE as string | undefined) === 'on';

export const MAILBOX_ENABLED: boolean = MAILBOX_MODE && ONION_URL !== null;
