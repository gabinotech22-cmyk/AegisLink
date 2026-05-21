/**
 * LightningPayment.ts
 *
 * Client-side Lightning Network payment flow for AegisLink Work subscriptions.
 *
 * Privacy model:
 *   - The server generates an invoice (BOLT11) identified only by a paymentHash.
 *   - The client pays the invoice and receives the preimage.
 *   - The client sends only the preimage to /web3/subscription/activate.
 *   - The server verifies SHA-256(preimage) === paymentHash and activates.
 *   - At no point does the server learn the user's wallet address or aegisId.
 *
 * Warning to users (displayed in UI before payment):
 *   "Lightning payments are pseudonymous. Your node/wallet may leak routing
 *    information. For maximum privacy, use a non-custodial wallet over Tor."
 */

import { sha256 } from '@noble/hashes/sha256';

export interface InvoiceRequest {
  /** Duration of the subscription in days. */
  planDays: number;
  /** Optional: a client-generated opaque token to bind the invoice to this session. */
  clientNonce?: string;
}

export interface InvoiceResponse {
  /** BOLT11-encoded Lightning invoice string. */
  bolt11: string;
  /** SHA-256 hash of the payment preimage (hex). */
  paymentHash: string;
  /** Invoice expiry as Unix ms timestamp. */
  expiresAt: number;
  /** Amount in satoshis. */
  amountSats: number;
}

export interface ActivationRequest {
  /** The preimage revealed by completing the Lightning payment (hex). */
  preimage: string;
  /** The paymentHash from the invoice (hex). */
  paymentHash: string;
}

export interface ActivationResult {
  active: boolean;
  expiresAt: number;
  planDays: number;
}

/**
 * Verifies that SHA-256(preimage) === paymentHash.
 * Use this client-side before sending the preimage to the server,
 * and server-side before activating the subscription.
 *
 * @param preimage - 32-byte preimage as a lowercase hex string.
 * @param paymentHash - Expected SHA-256 hash as a lowercase hex string.
 */
export function verifyPreimage(preimage: string, paymentHash: string): boolean {
  try {
    const preimageBytes = hexToBytes(preimage);
    if (preimageBytes.length !== 32) return false;
    const computed = sha256(preimageBytes);
    const computedHex = bytesToHex(computed);
    return computedHex === paymentHash.toLowerCase();
  } catch {
    return false;
  }
}

function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error('hex string must have even length');
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    const byte = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (isNaN(byte)) throw new Error(`invalid hex character at position ${i * 2}`);
    bytes[i] = byte;
  }
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Requests a Lightning invoice from the relay.
 * The relay generates the invoice without knowing who is requesting it
 * (no aegisId is sent in this request).
 *
 * @param relayBase - Base URL of the relay (e.g. "https://relay.aegislink.net").
 */
export async function requestInvoice(
  relayBase: string,
  opts: InvoiceRequest
): Promise<InvoiceResponse> {
  const res = await fetch(`${relayBase}/web3/subscription/invoice`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`invoice request failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<InvoiceResponse>;
}

/**
 * Activates a subscription by presenting the Lightning payment preimage.
 * The server verifies SHA-256(preimage) === paymentHash.
 *
 * This call does NOT include the user's aegisId. Activation is
 * keyed only on the paymentHash — the server correlates payment to
 * subscription without knowing the payer's identity.
 */
export async function activateSubscription(
  relayBase: string,
  req: ActivationRequest
): Promise<ActivationResult> {
  // Verify preimage locally first — don't send garbage to the server.
  if (!verifyPreimage(req.preimage, req.paymentHash)) {
    throw new Error('preimage does not hash to paymentHash — payment may not be complete');
  }
  const res = await fetch(`${relayBase}/web3/subscription/activate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`subscription activation failed (${res.status}): ${body}`);
  }
  return res.json() as Promise<ActivationResult>;
}
