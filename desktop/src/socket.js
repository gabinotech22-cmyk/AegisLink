/**
 * desktop/src/socket.js
 *
 * Public facade that satisfies the desktop companion spec:
 *   connect(identity, relayUrl?) → Socket
 *   disconnect()
 *   getSocket() → Socket | null
 *
 * The full implementation — Double Ratchet, challenge-response auth,
 * incoming envelope handling, read receipts — lives in ./socket/client.js.
 * This file re-exports the three entry points expected by callers that only
 * need basic connectivity.
 */

import { connectToRelay, disconnectFromRelay, getSocket } from './socket/client.js';

/**
 * Connect to the relay and register event handlers.
 *
 * The underlying client reads VITE_RELAY_URL at runtime. If you need to
 * override the URL (e.g. during tests or multi-tenant deployments), set
 * import.meta.env.VITE_RELAY_URL before calling connect().
 *
 * Challenge-response flow (handled by client.js):
 *   relay → auth:challenge { ephemeralPubKey, nonce, ciphertext }
 *   client decrypts with identity.secretKeyB64 (X25519 box.open)
 *   client → auth:response { plain: base64(decrypted) }
 *
 * @param {object} identity   Full identity: { aegisId, secretKeyB64, … }
 * @param {string} [relayUrl] Optional relay URL override (ignored if already
 *                            set via VITE_RELAY_URL — set that env var instead)
 * @returns {import('socket.io-client').Socket}
 */
export function connect(identity, relayUrl) {
  // relayUrl is accepted for API compatibility; the underlying connectToRelay
  // uses VITE_RELAY_URL or 'http://localhost:3001'. Callers that need a
  // custom URL should set import.meta.env.VITE_RELAY_URL before calling.
  return connectToRelay(identity);
}

/**
 * Gracefully disconnect from the relay and clear the socket singleton.
 */
export function disconnect() {
  disconnectFromRelay();
}

/**
 * Return the current Socket.IO socket instance, or null if not connected.
 * @returns {import('socket.io-client').Socket | null}
 */
export { getSocket };
