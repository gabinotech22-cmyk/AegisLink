/**
 * AegisLink — Delivery token store (Phase 1, mobile)
 *
 * Anti-abuse gate for sealed-sender v2 (docs/SEALED-SENDER-ARCHITECTURE.md §3.3).
 * Because v2 submissions carry no sender identity, the relay can't rate-limit by
 * sender. Instead each recipient registers ONLY the hash of a high-entropy
 * delivery token; senders present the raw token to submit. The relay verifies
 * sha256(token) === storedHash without learning the sender.
 *
 * This module owns:
 *  - our OWN token: generated once, persisted in SecureStore, raw value shared
 *    with contacts over E2EE; only its hash is registered with the relay.
 *  - CONTACTS' tokens: the raw tokens contacts shared with us, persisted per
 *    contact so we can present them when sending v2.
 *
 * The hash matches the server's deliveryToken.ts exactly:
 *   base64( sha256( utf8(rawToken) ) ).
 */

import * as SecureStore from 'expo-secure-store';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha2';

const OWN_TOKEN_SLOT = 'aegis.deliveryToken.self';
const CONTACT_SLOT_PREFIX = 'aegis.deliveryToken.peer.';

/** 16 bytes = 128 bits of entropy (> Signal's 96-bit). */
const TOKEN_BYTES = 16;

/** Generate a fresh raw delivery token (standard base64). */
export function generateDeliveryToken(): string {
  return encodeBase64(nacl.randomBytes(TOKEN_BYTES));
}

/** Hash a raw token for relay registration — MUST match server hashDeliveryToken. */
export function hashDeliveryToken(rawToken: string): string {
  return encodeBase64(sha256(new TextEncoder().encode(rawToken)));
}

/** SecureStore key for a peer's token (aegisId is opaque, slot-safe). */
function peerSlot(aegisId: string): string {
  return CONTACT_SLOT_PREFIX + aegisId;
}

/**
 * Return our own raw delivery token, generating + persisting it on first use.
 * The raw value is a secret (whoever holds it can message us) → SecureStore.
 */
export async function getOwnDeliveryToken(): Promise<string> {
  const existing = await SecureStore.getItemAsync(OWN_TOKEN_SLOT);
  if (existing) return existing;
  const fresh = generateDeliveryToken();
  await SecureStore.setItemAsync(OWN_TOKEN_SLOT, fresh);
  return fresh;
}

/** Persist a contact's raw delivery token (received over E2EE). */
export async function setContactDeliveryToken(aegisId: string, rawToken: string): Promise<void> {
  await SecureStore.setItemAsync(peerSlot(aegisId), rawToken);
}

/** Fetch a contact's raw delivery token, or null if we don't have one yet. */
export async function getContactDeliveryToken(aegisId: string): Promise<string | null> {
  return SecureStore.getItemAsync(peerSlot(aegisId));
}
