import { z } from 'zod';
import { MESSAGE_TTL_MS } from '../db/client.js';

export const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// UUID regex reused across several schemas below.
export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Sealed-sender wire format. Server only sees:
 *   - `id`: message identifier (random, opaque)
 *   - `to`: routing address (aegisId)
 *   - `ciphertext` / `nonce`: opaque payload (the recipient trial-decrypts
 *      against each known contact pubkey to learn the sender).
 *
 * No `from` field. The sender's identity is inside the encrypted body.
 */
export const EnvelopeIn = z.object({
  id: z.string().min(1).max(64),
  to: z.string().regex(AEGIS_ID_RE),
  ciphertext: z.string().min(1).max(2097152), // 2 MB — accommodates voice/file messages
  nonce: z.string().min(1).max(64),
  /**
   * Set by the sender on X3DH-initial (first-contact) messages. When true and
   * the recipient is offline, the relay attaches the sender's public key to the
   * queued copy so the recipient can identify+decrypt a first message it would
   * otherwise be unable to (no sender info on sealed-sender queue drains).
   */
  init: z.boolean().optional(),
  /**
   * A-3: ephemeral (disappearing) message TTL in ms. When the recipient is
   * offline and the message is queued, the relay clamps the queue lifetime to
   * this value instead of the 30-day default, so a disappearing message cannot
   * linger in the offline queue far beyond its intended life. The only metadata
   * this leaks to the relay is the coarse TTL bucket — accepted in the roadmap.
   * Bounded to (0, MESSAGE_TTL_MS]; a value over the default is meaningless.
   */
  ephemeralTtl: z.number().int().positive().max(MESSAGE_TTL_MS).optional(),
});

/**
 * Sealed-sender v2 submission (docs/SEALED-SENDER-ARCHITECTURE.md §3, Phase 1).
 * Unlike v1, there is NO `from` anywhere on the wire and the relay never stamps
 * one. The sender's identity is sealed inside `ciphertext` (recovered+verified
 * by the recipient). `epk` is the per-message ephemeral X25519 public key needed
 * to open the box. `deliveryToken` is the raw anti-abuse token the recipient
 * shared over E2EE — the relay checks its hash without learning the sender.
 *
 * v2 is for ESTABLISHED contacts only: the recipient authenticates the sealed
 * `from` against a signing key it already holds. First-contact bootstrap (X3DH
 * `init`) stays on the v1 `envelope` path, which can attach the sender pubkey.
 */
export const EnvelopeV2In = z.object({
  id: z.string().min(1).max(64),
  to: z.string().regex(AEGIS_ID_RE),
  ciphertext: z.string().min(1).max(2097152),
  nonce: z.string().min(1).max(64),
  epk: z.string().min(1).max(64),
  deliveryToken: z.string().min(1).max(256),
  /** A-3: ephemeral TTL in ms — see EnvelopeIn.ephemeralTtl. Clamps queue life. */
  ephemeralTtl: z.number().int().positive().max(MESSAGE_TTL_MS).optional(),
});

/** Owner registers/rotates the hash of their own delivery token (authenticated). */
export const DeliveryTokenRegister = z.object({
  tokenHashB64: z.string().min(1).max(128),
});

export const TypingEvent = z.object({
  to: z.string().regex(AEGIS_ID_RE),
  isTyping: z.boolean(),
  orgId: z.string().regex(UUID_RE).optional(),
  channelId: z.string().regex(UUID_RE).optional(),
});

export const MsgRead = z.object({
  to: z.string().regex(AEGIS_ID_RE),
  msgIds: z.array(z.string().min(1).max(64)).max(500),
});

export const MsgDelete = z.object({
  to: z.string().regex(AEGIS_ID_RE),
  msgId: z.string().min(1).max(64),
});

export const PushRegister = z.object({
  token: z.string().min(1).max(256),
  platform: z.enum(['ios', 'android', 'unknown']).default('unknown'),
});

export interface PreKeyBundle {
  /** Ed25519 identity key of the recipient — required to verify the SPK signature in X3DH. */
  signingPublicKeyB64: string;
  signedPreKey: {
    keyId: number;
    publicKeyB64: string;
    signatureB64: string;
  };
  oneTimePreKey: {
    keyId: number;
    publicKeyB64: string;
  } | null;
  /**
   * PQXDH (v2): optional signed PQ prekey (ML-KEM-768). Present iff the device
   * has published one — absent for legacy v1-only devices/clients. The relay
   * never inspects this beyond the Ed25519 signature check at upload time
   * (defence in depth); it is stored and served as an opaque blob, same as
   * the classic signedPreKey.
   */
  pqSignedPreKey?: {
    keyId: number;
    publicKeyB64: string;
    signatureB64: string;
  } | null;
}

export interface SealedEnvelope {
  id: string;
  to: string;
  /** In-memory only — never persisted to disk. Present when sender is online. */
  from: string;
  ciphertext: string;
  nonce: string;
  createdAt: number;
  /**
   * X25519 public key of the sender, looked up once at auth time and injected
   * by the relay into every delivered envelope.  Public keys are non-secret
   * (available via GET /identity/:aegisId) so including them here is safe.
   * Allows recipients to auto-add unknown senders and decrypt their first
   * message without a separate HTTP round-trip to the identity directory.
   * Only present on online-delivered envelopes; absent from offline-queue drains
   * because the sender's aegisId is intentionally NOT stored in the queue (FND-05).
   */
  senderPublicKeyB64?: string;
}

/** Wire format delivered to the recipient from the offline queue (no `from`). */
export interface QueuedEnvelope {
  id: string;
  to: string;
  ciphertext: string;
  nonce: string;
  createdAt: number;
  /** Present ONLY on first-contact (`init`) messages — lets the recipient decrypt a queued first message. */
  senderPublicKeyB64?: string;
}

/**
 * Sealed-sender v2 envelope as delivered to the recipient (online or drained).
 * Carries NO sender identity — not even injected by the relay. `epk` is required
 * to open the per-message box. Same shape for online delivery and queue drain.
 */
export interface SealedEnvelopeV2 {
  id: string;
  to: string;
  ciphertext: string;
  nonce: string;
  epk: string;
  createdAt: number;
}

export const PreKeyUpload = z.object({
  /** Optional device identifier. Defaults to 'default' for legacy single-device clients. */
  deviceId: z.string().min(1).max(128).optional(),
  signedPreKey: z.object({
    keyId: z.number(),
    publicKeyB64: z.string().min(1),
    signatureB64: z.string().min(1)
  }),
  oneTimePreKeys: z.array(z.object({
    keyId: z.number(),
    publicKeyB64: z.string().min(1)
  })).max(100),
  /**
   * PQXDH (v2): optional signed PQ prekey (ML-KEM-768). Nullable/optional so
   * legacy v1 clients (and the legacy uploadPreKeys path that hasn't been
   * updated yet) keep working unchanged — interop requirement.
   * Sizes (base64): publicKeyB64 ~1184 bytes raw, signatureB64 64 bytes raw.
   */
  pqSignedPreKey: z.object({
    keyId: z.number(),
    publicKeyB64: z.string().min(1).max(2048),
    signatureB64: z.string().min(1).max(128),
  }).optional(),
});

export const PreKeyFetch = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE)
});

// ── Work channel schemas ──────────────────────────────────────────────────────
export const CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ORG_ID_RE = CHANNEL_ID_RE; // both are UUIDs

export const ChannelJoin = z.object({
  channelId: z.string().regex(CHANNEL_ID_RE),
  orgId: z.string().regex(ORG_ID_RE),
});

export const ChannelMsgAttachment = z.object({
  blobId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  sizeBytes: z.number().int().min(1).max(50 * 1024 * 1024), // 50 MB per file
});

export const ChannelMsg = z.object({
  id: z.string().uuid(),
  channelId: z.string().regex(CHANNEL_ID_RE),
  orgId: z.string().regex(ORG_ID_RE),
  body: z.string().min(1).max(65536),
  type: z.enum(['text', 'image', 'file']).default('text'),
  parent_id: z.string().uuid().optional(),
  attachments: z.array(ChannelMsgAttachment).max(5).optional(),
  // E2EE Work channel fields — opaque to the relay, passed through verbatim
  encrypted: z.boolean().optional(),
  nonce: z.string().max(128).optional(),
});

export const ChannelDeleteMsg = z.object({
  messageId: z.string().uuid(),
  channelId: z.string().regex(CHANNEL_ID_RE),
  orgId: z.string().regex(ORG_ID_RE),
});

// ── Work E2EE SenderKey distribution schemas ──────────────────────────────────

export const SenderKeyRecipient = z.object({
  aegisId: z.string().min(1).max(64),
  ciphertextB64: z.string().max(1024),
  nonceB64: z.string().length(44),
  iteration: z.number().int().min(0),
  // Server-derived (golden rule #7): the distributor identity is taken from the
  // authenticated socket, NOT from this client-supplied field, which is ignored
  // if present. The recipient also recovers + verifies the real distributor from
  // inside the sealed box (channelKey.ts, Phase 3b), so this never gates trust.
  senderAegisId: z.string().min(1).max(64).optional(),
});

export const SenderKeyDistEvent = z.object({
  channelId: z.string().uuid(),
  orgId: z.string().uuid(),
  recipients: z.array(SenderKeyRecipient).min(1).max(100),
});

export const RequestSenderKeyEvent = z.object({
  channelId: z.string().uuid(),
  orgId: z.string().uuid(),
  fromAegisId: z.string().min(1).max(64),
});

// ── Group (1:1 messaging) re-key after member removal ─────────────────────────
// Forward secrecy: when an admin removes a member they distribute a fresh
// SenderKey, sealed individually per remaining member. The relay is a blind
// router — it only reads each `aegisId` routing field and fans out the sealed
// blobs. No key material is read, logged, or stored.
// Sealed sender (Phase 3b): the distributor's identity is NOT a wire field — it
// is sealed inside `ciphertextB64`. The relay only routes by the recipient
// `aegisId` and never learns who re-keyed the group.
export const GroupRekeyDistribution = z.object({
  aegisId: z.string().min(1).max(64),
  ciphertextB64: z.string().max(1024),
  nonceB64: z.string().length(44),
  iteration: z.number().int().min(0),
});

// Cap raised to 512 for large groups. Clients with >512 members MUST chunk the
// re-key into multiple `group:rekey` calls (each carries up to 512 per-recipient
// blobs). The rate limit (30/min) gives ~15,360 recipients per minute, sufficient
// for groups of up to ~512 members with one immediate re-key + one retry window.
export const GROUP_REKEY_MAX_DIST = 512;

export const GroupRekeyEvent = z.object({
  groupId: z.string().min(1).max(64),
  distributions: z.array(GroupRekeyDistribution).min(1).max(GROUP_REKEY_MAX_DIST),
});

export const RekeyDrainAck = z.object({
  distId: z.string().uuid(),
});

export const AUTH_TIMEOUT_MS = 5000;
export const DEVICE_LINK_TTL_MS = 2 * 60 * 1000; // 2 minutes

// Zod schemas for device linking
//
// desktop → relay (unauthenticated): { desktopPubKey, targetAegisId }
// relay   → mobile (authenticated):  { desktopPubKey, tempSocketId }
//
// mobile  → relay (authenticated):   { desktopPubKey, encryptedPayload, nonceB64 }
// relay   → desktop (unauthenticated): { encryptedPayload, nonceB64, mobilePubKey }
export const DeviceLink = z.object({
  /** AegisID the desktop wants to link to. */
  targetAegisId: z.string().regex(AEGIS_ID_RE),
  desktopPubKey: z.string().min(1).max(128),
});

export const DeviceLinkApprove = z.object({
  desktopPubKey: z.string().min(1).max(128),
  encryptedPayload: z.string().min(1).max(4096),
  nonceB64: z.string().min(1).max(64),
});

export const DeviceRevoke = z.object({
  deviceId: z.string().min(1).max(128),
});

// Mailbox-addressed sealed envelope (Fase 4). Carries NO sender identity and
// NO real recipient aegisId — only the opaque mailbox routing id in `to`.
export const MailboxEnvelopeIn = z.object({
  id: z.string().min(1).max(128),
  to: z.string().min(1).max(64),          // recipient mailboxId (base64 of 16 bytes)
  ciphertext: z.string().min(1).max(65536),
  nonce: z.string().min(1).max(64),
  epk: z.string().min(1).max(64),
  // Slice 5: ephemeral TTL in ms — clamps the OFFLINE queue life so an ephemeral
  // message can't outlive its burn timer in the relay. Parity with EnvelopeIn.
  // Purely server-side queue expiry; the recipient reads the burn timer from the
  // decrypted payload, never from this wire field (so online delivery omits it).
  ephemeralTtl: z.number().int().positive().max(MESSAGE_TTL_MS).optional(),
});
