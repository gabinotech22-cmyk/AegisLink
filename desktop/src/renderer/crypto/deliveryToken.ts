/**
 * AegisLink — Delivery token store (Phase 1, desktop)
 *
 * Parity with mobile/src/crypto/deliveryToken.ts. Anti-abuse gate for
 * sealed-sender v2 (docs/SEALED-SENDER-ARCHITECTURE.md §3.3). The relay stores
 * ONLY the hash of a recipient's token; senders present the raw token to submit.
 * Hash matches the server exactly: base64( sha256( utf8(rawToken) ) ).
 *
 * Persists via window.aegis.secureStorage (same channel as identity secrets).
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha2.js';
import './ipc-types';

const OWN_TOKEN_SLOT = 'aegis.deliveryToken.self';
const CONTACT_SLOT_PREFIX = 'aegis.deliveryToken.peer.';
const TOKEN_BYTES = 16;

const secureStorage = (): Window['aegis']['secureStorage'] => window.aegis.secureStorage;

/** Generate a fresh raw delivery token (standard base64). */
export function generateDeliveryToken(): string {
  return encodeBase64(nacl.randomBytes(TOKEN_BYTES));
}

/** Hash a raw token for relay registration — MUST match server hashDeliveryToken. */
export function hashDeliveryToken(rawToken: string): string {
  return encodeBase64(sha256(new TextEncoder().encode(rawToken)));
}

function peerSlot(aegisId: string): string {
  return CONTACT_SLOT_PREFIX + aegisId;
}

/** Return our own raw delivery token, generating + persisting it on first use. */
export async function getOwnDeliveryToken(): Promise<string> {
  const existing = await secureStorage().get(OWN_TOKEN_SLOT);
  if (existing) return existing;
  const fresh = generateDeliveryToken();
  await secureStorage().set(OWN_TOKEN_SLOT, fresh);
  return fresh;
}

/** Persist a contact's raw delivery token (received over E2EE). */
export async function setContactDeliveryToken(aegisId: string, rawToken: string): Promise<void> {
  await secureStorage().set(peerSlot(aegisId), rawToken);
}

/** Fetch a contact's raw delivery token, or null if we don't have one yet. */
export async function getContactDeliveryToken(aegisId: string): Promise<string | null> {
  return secureStorage().get(peerSlot(aegisId));
}
