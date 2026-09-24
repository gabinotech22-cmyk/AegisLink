/**
 * AegisLink — DB row types & shared constants
 *
 * Extracted from db/client.ts (M4 god-file split). Pure type/constant
 * relocation — no logic changes. Re-exported by db/client.ts so existing
 * `import { MessageRow } from '../db/client'` call sites keep working.
 */

export interface IdentityRow {
  aegis_id: string;
  public_key_b64: string;
  signing_public_key_b64: string;
  created_at: number;
}

export interface MessageRow {
  id: string;
  recipient: string;
  ciphertext_b64: string;
  nonce_b64: string;
  created_at: number;
  expires_at: number;
  /** JSON-serialized string[]. Device IDs that have already drained this message. */
  drained_by: string;
  /**
   * How many times this row has been handed out for delivery. Deletion is
   * ack-driven (see relay/handler.ts), so a row the client can never process
   * would otherwise be re-emitted on every reconnect forever. Past
   * MAX_DELIVERY_ATTEMPTS the row is treated as poison and dropped.
   */
  delivery_attempts?: number;
  /**
   * Sender's X25519 public key (base64), attached ONLY for X3DH-initial (`init`)
   * messages so the recipient can identify+decrypt a first-contact message that
   * had to be queued. null for all normal sealed-sender messages — the relay
   * never persists the social graph for those (FND-05).
   */
  sender_pub_b64?: string | null;
  /**
   * Sealed-sender v2 ephemeral X25519 public key (base64). Present ONLY on v2
   * sealed envelopes — required to open the box on drain. null for v1 messages.
   * Its presence is what distinguishes a queued v2 envelope from a v1 one.
   */
  epk_b64?: string | null;
}

export interface PushTokenRow {
  aegis_id: string;
  expo_token: string;
  platform: 'ios' | 'android' | 'unknown';
  updated_at: number;
}

export interface VoipTokenRow {
  aegis_id: string;
  /** Raw APNs VoIP device token (hex string), NOT an Expo token. */
  voip_token: string;
  updated_at: number;
}

export interface ApnsTokenRow {
  aegis_id: string;
  /** Raw APNs standard device token (hex), for apns-push-type: alert. */
  apns_token: string;
  updated_at: number;
}

export interface SignedPreKeyRow {
  aegis_id: string;
  /** Device identifier for this prekey. Defaults to 'default' for legacy single-device clients. */
  device_id: string;
  key_id: number;
  public_key_b64: string;
  signature_b64: string;
  created_at: number;
}

export interface OneTimePreKeyRow {
  aegis_id: string;
  /** Device identifier for this OPK. Defaults to 'default' for legacy single-device clients. */
  device_id: string;
  key_id: number;
  public_key_b64: string;
  created_at: number;
}

/**
 * PQXDH signed PQ prekey (ML-KEM-768). Mirrors SignedPreKeyRow's shape so it
 * shares the same upsert/migration pattern. The relay only verifies the
 * Ed25519 signature (defence in depth) and stores+serves the blob verbatim —
 * it never inspects or correlates the ML-KEM public key itself.
 */
export interface PqSignedPreKeyRow {
  aegis_id: string;
  /** Device identifier for this prekey. Defaults to 'default' for legacy single-device clients. */
  device_id: string;
  key_id: number;
  /** base64 of the 1184-byte ML-KEM-768 public key. */
  public_key_b64: string;
  /** base64 of the 64-byte Ed25519 detached signature over the raw pubkey bytes. */
  signature_b64: string;
  created_at: number;
}

export interface LinkedDeviceRow {
  device_id: string;
  aegis_id: string;
  device_pub_key: string;
  device_name: string;
  platform: string;
  linked_at: number;
  revoked: number;
}

// TTL for queued messages: 30 days in ms
export const MESSAGE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * How many times a queued row may be handed out for delivery before the relay
 * gives up on it (audit 2026-08-08).
 *
 * Deletion is ack-driven on purpose: deleting on emit lost messages over Tor
 * (relay/handler.ts). The cost is that a row the recipient can NEVER ack —
 * permanently undecryptable envelope, ratchet state gone after a reinstall — is
 * re-emitted on every reconnect for the full 30-day TTL. The recipient re-grinds
 * that whole backlog through the ratchet before the genuinely new message, which
 * is what made every iOS cold start stall for 10-15 s.
 *
 * 5 keeps at-least-once for any realistic transient failure (a dropped emit, a
 * busy database, a decrypt that needs an earlier message that itself retries)
 * while bounding the storm to something that dies out within a few sessions.
 */
export const MAX_DELIVERY_ATTEMPTS = 5;
