/**
 * RELAY_URL — relay/identity backend for Electron renderer.
 *
 * Override by setting VITE_RELAY_URL in a .env file at desktop/ root.
 * Defaults to localhost:3001 (dev server running on same machine).
 */
const CLEARNET_RELAY_URL =
  (import.meta.env.VITE_RELAY_URL as string | undefined) ?? 'http://localhost:3001';

/**
 * ONION_URL — relay Tor hidden service address (parity with mobile). Set
 * VITE_ONION_URL in a .env at desktop/ root. Required for mailbox mode below.
 */
export const ONION_URL: string | null =
  (import.meta.env.VITE_ONION_URL as string | undefined) ?? null;

/**
 * FEDERATION — "choose your relay" (docs/FEDERATION-DESIGN.md). OFF by default
 * until slice F7 (parity with mobile EXPO_PUBLIC_FEDERATION). Opt in via
 * VITE_FEDERATION=on for development builds of the slices.
 */
export const FEDERATION: boolean =
  (import.meta.env.VITE_FEDERATION as string | undefined) === 'on';

/**
 * Tor always-on (desktop): the main process proxies the whole session through
 * the embedded Tor, so when the relay's .onion is configured EVERYTHING — the
 * aegisId control socket, HTTP (PoW, prekeys, TURN creds), the mailbox socket —
 * targets the hidden service. No exit nodes, no TLS pin to rotate, no IP seen
 * by the relay. The clearnet URL is only used when no onion is configured
 * (local dev relay); it still rides Tor via exit nodes when reachable.
 */
export const TOR_RELAY: boolean = ONION_URL !== null;
export const RELAY_URL: string = ONION_URL ?? CLEARNET_RELAY_URL;

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
 * MAILBOX_MODE / MAILBOX_ENABLED — sealed-sender Fase 4: hide the recipient
 * (`to`) from the relay by addressing a rotating, opaque mailbox id over a
 * dedicated delivery socket. Parity with mobile/src/config.ts. Default ON
 * (federation F5b: the mailbox is the only transport between relays, so a
 * client without one is unreachable from any self-hosted relay); opt OUT via
 * VITE_MAILBOX_MODE=off (debug only).
 *
 * Fail-closed: it REQUIRES Tor (ONION_URL present), so the opaque mailbox
 * socket can't be relinked to our IP next to the aegisId control socket.
 * Without Tor, MAILBOX_ENABLED is false and delivery stays on the aegisId
 * transport rather than ship a relinkable "private" mode.
 */
export const MAILBOX_MODE: boolean =
  (import.meta.env.VITE_MAILBOX_MODE as string | undefined) !== 'off';

export const MAILBOX_ENABLED: boolean = MAILBOX_MODE && ONION_URL !== null;
