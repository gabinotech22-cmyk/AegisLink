import type { Server as SocketServer, Socket } from 'socket.io';
import { z } from 'zod';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { randomUUID } from 'node:crypto';

const { decodeBase64 } = naclUtil;
import { messageRepo, senderKeyDistRepo, prekeysRepo, pushRepo, devicesRepo, identityRepo, deliveryTokenRepo, workRepo, workChannelRepo, workMessageRepo, workAttachmentRepo, workChannelPermissionRepo, getPermissions, MESSAGE_TTL_MS, type WorkRole } from '../db/client.js';
import { issueChallenge, verifyResponse, challengeWire, type Challenge } from '../auth/challenge.js';
import { verifyDeliveryToken } from '../crypto/deliveryToken.js';
import { notifyRecipient, sendCallWakeUp, sendGroupCallWakeUp, type CallMedia } from '../push/expo.js';

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

/**
 * Sealed-sender wire format. Server only sees:
 *   - `id`: message identifier (random, opaque)
 *   - `to`: routing address (aegisId)
 *   - `ciphertext` / `nonce`: opaque payload (the recipient trial-decrypts
 *      against each known contact pubkey to learn the sender).
 *
 * No `from` field. The sender's identity is inside the encrypted body.
 */
const EnvelopeIn = z.object({
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
const EnvelopeV2In = z.object({
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
const DeliveryTokenRegister = z.object({
  tokenHashB64: z.string().min(1).max(128),
});

// UUID regex reused before the Work-section constants are declared
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const TypingEvent = z.object({
  to: z.string().regex(AEGIS_ID_RE),
  isTyping: z.boolean(),
  orgId: z.string().regex(UUID_RE).optional(),
  channelId: z.string().regex(UUID_RE).optional(),
});

const MsgRead = z.object({
  to: z.string().regex(AEGIS_ID_RE),
  msgIds: z.array(z.string().min(1).max(64)).max(500),
});

const MsgDelete = z.object({
  to: z.string().regex(AEGIS_ID_RE),
  msgId: z.string().min(1).max(64),
});

const PushRegister = z.object({
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

const PreKeyUpload = z.object({
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

const PreKeyFetch = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE)
});

// ── Work channel schemas ──────────────────────────────────────────────────────
const CHANNEL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORG_ID_RE = CHANNEL_ID_RE; // both are UUIDs

const ChannelJoin = z.object({
  channelId: z.string().regex(CHANNEL_ID_RE),
  orgId: z.string().regex(ORG_ID_RE),
});

const ChannelMsgAttachment = z.object({
  blobId: z.string().uuid(),
  filename: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(127),
  sizeBytes: z.number().int().min(1).max(50 * 1024 * 1024), // 50 MB per file
});

const ChannelMsg = z.object({
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

// ── Work E2EE SenderKey distribution schemas ──────────────────────────────────

const SenderKeyRecipient = z.object({
  aegisId: z.string().min(1).max(64),
  ciphertextB64: z.string().max(1024),
  nonceB64: z.string().length(44),
  iteration: z.number().int().min(0),
  senderAegisId: z.string().min(1).max(64),
});

const SenderKeyDistEvent = z.object({
  channelId: z.string().uuid(),
  orgId: z.string().uuid(),
  recipients: z.array(SenderKeyRecipient).min(1).max(100),
});

const RequestSenderKeyEvent = z.object({
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
const GroupRekeyDistribution = z.object({
  aegisId: z.string().min(1).max(64),
  ciphertextB64: z.string().max(1024),
  nonceB64: z.string().length(44),
  iteration: z.number().int().min(0),
});

// Cap raised to 512 for large groups. Clients with >512 members MUST chunk the
// re-key into multiple `group:rekey` calls (each carries up to 512 per-recipient
// blobs). The rate limit (30/min) gives ~15,360 recipients per minute, sufficient
// for groups of up to ~512 members with one immediate re-key + one retry window.
const GROUP_REKEY_MAX_DIST = 512;

const GroupRekeyEvent = z.object({
  groupId: z.string().min(1).max(64),
  distributions: z.array(GroupRekeyDistribution).min(1).max(GROUP_REKEY_MAX_DIST),
});

// Rate-limit buckets for channel:msg — keyed by aegisId, max 120/min
const channelMsgRateLimit = new Map<string, { count: number; reset: number }>();
// TODO (A-1, deferred): migrate to Redis ONLY when running >1 relay instance.
// Single-instance today, so in-memory is correct; the cap below bounds memory.
const RATE_LIMIT_MAP_MAX = 10_000;

/**
 * Bound the size of an in-memory rate-limit map WITHOUT letting an attacker reset
 * a victim's counter. The old code evicted the oldest-INSERTED key (plain FIFO):
 * flooding the map with fresh keys would evict an active victim entry and hand
 * them a clean bucket. Instead, evict only entries whose window has already
 * elapsed (their counter is meaningless anyway); active buckets are never
 * dropped to make room. As a last resort under a pathological all-active map we
 * stop inserting churn rather than evicting a live limit. Keyed by aegisId, all
 * authenticated — and registration now costs an 18-bit PoW (A-2), so minting the
 * thousands of identities needed to fill this map is already expensive.
 */
function evictExpired(map: Map<string, { count: number; reset: number }>): void {
  if (map.size <= RATE_LIMIT_MAP_MAX) return;
  const now = Date.now();
  for (const [key, entry] of map) {
    if (entry.reset <= now) map.delete(key);
    if (map.size <= RATE_LIMIT_MAP_MAX) return;
  }
}

function checkChannelMsgRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = channelMsgRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  channelMsgRateLimit.set(aegisId, entry);
  evictExpired(channelMsgRateLimit);
  return entry.count <= 120;
}

// ── Shared low-frequency rate-limit (FIX D) ───────────────────────────────────
// typing + msg:read + msg:delete share a single bucket: 30 ops / 10 s per socket.
// group:rekey has its own stricter bucket: 10 ops / 60 s per aegisId.
// Keyed by aegisId — no IP involved.
const lowFreqRateLimit = new Map<string, { count: number; reset: number }>();
const rekeyRateLimit   = new Map<string, { count: number; reset: number }>();

function checkLowFreqRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = lowFreqRateLimit.get(aegisId) ?? { count: 0, reset: now + 10_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 10_000; }
  entry.count++;
  lowFreqRateLimit.set(aegisId, entry);
  evictExpired(lowFreqRateLimit);
  return entry.count <= 30;
}

// Raised from 10 to 30 per minute to support large-group re-keys.
// Rationale: with GROUP_REKEY_MAX_DIST=512, an admin re-keying a 512-member
// group needs exactly 1 call (fits in one batch). The extra headroom (30 calls)
// covers concurrent group memberships and retry attempts without opening a
// meaningful DoS vector — sustained abuse would only exhaust the attacker's own
// per-identity bucket, not others'.
function checkRekeyRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = rekeyRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  rekeyRateLimit.set(aegisId, entry);
  evictExpired(rekeyRateLimit);
  return entry.count <= 30;
}

const AUTH_TIMEOUT_MS = 5000;
const DEVICE_LINK_TTL_MS = 2 * 60 * 1000; // 2 minutes

// Zod schemas for device linking
//
// desktop → relay (unauthenticated): { desktopPubKey, targetAegisId }
// relay   → mobile (authenticated):  { desktopPubKey, tempSocketId }
//
// mobile  → relay (authenticated):   { desktopPubKey, encryptedPayload, nonceB64 }
// relay   → desktop (unauthenticated): { encryptedPayload, nonceB64, mobilePubKey }
const DeviceLink = z.object({
  /** AegisID the desktop wants to link to. */
  targetAegisId: z.string().regex(AEGIS_ID_RE),
  desktopPubKey: z.string().min(1).max(128),
});

const DeviceLinkApprove = z.object({
  desktopPubKey: z.string().min(1).max(128),
  encryptedPayload: z.string().min(1).max(4096),
  nonceB64: z.string().min(1).max(64),
});

const DeviceRevoke = z.object({
  deviceId: z.string().min(1).max(128),
});

// ── Online presence (ephemeral — never persisted, zero metadata) ─────────────
// orgId → Set of aegisIds currently online in that org
const orgPresence = new Map<string, Set<string>>();

// socketId → orgIds this socket has joined (for cleanup on disconnect)
const socketOrgMembership = new Map<string, string[]>();

// In-memory socket data (never persisted)
type Platform = 'mobile' | 'desktop' | 'unknown';

interface SocketMeta {
  platform: Platform;
  /** Opaque device UUID supplied by the client at handshake time.
   *  `undefined` for legacy clients that do not send a deviceId — drain uses
   *  the legacy path (hard-delete immediately instead of per-device tracking). */
  deviceId: string | undefined;
}

const socketMeta = new WeakMap<Socket, SocketMeta>();

export function attachRelay(io: SocketServer) {
  // authed aegisId -> set of sockets (multiple devices/tabs allowed)
  const sockets = new Map<string, Set<Socket>>();

  // Temporary map for sockets in device-linking flow (unauthenticated desktop sockets)
  // desktopPubKey -> { socket, timer }
  const linkingSockets = new Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout> }>();

  function deliver(env: SealedEnvelope, recipientSockets: Set<Socket>): boolean {
    if (recipientSockets.size === 0) return false;
    for (const s of recipientSockets) s.emit('envelope', env);
    // Notify the sender that delivery succeeded (if they are still online)
    const senderSockets = sockets.get(env.from);
    if (senderSockets) {
      for (const s of senderSockets) s.emit('msg:delivered', { msgId: env.id, to: env.to });
    }
    return true;
  }

  io.on('connection', (socket) => {
    const auth = socket.handshake.auth as { aegisId?: unknown; platform?: unknown; deviceId?: unknown };
    const claimed = auth?.aegisId;
    if (typeof claimed !== 'string' || !AEGIS_ID_RE.test(claimed)) {
      socket.emit('error_msg', { code: 'bad_handshake' });
      socket.disconnect(true);
      return;
    }
    const me = claimed;
    const rawPlatform = auth?.platform;
    const platform: Platform =
      rawPlatform === 'mobile' || rawPlatform === 'desktop' ? rawPlatform : 'unknown';
    // deviceId is an opaque UUID the client supplies at handshake time.
    // When absent, we leave it undefined so the drain path falls back to
    // hard-delete (legacy behaviour) instead of per-device tracking.
    // We intentionally do NOT fall back to socket.id — that changes on every
    // reconnection and would corrupt drained_by / MAX_DRAIN_DEVICES accounting.
    const rawDeviceId = auth?.deviceId;
    const deviceId: string | undefined = typeof rawDeviceId === 'string' && rawDeviceId.length > 0
      ? rawDeviceId
      : undefined;
    socketMeta.set(socket, { platform, deviceId });

    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) {
        socket.emit('error_msg', { code: 'auth_timeout' });
        socket.disconnect(true);
      }
    }, AUTH_TIMEOUT_MS);
    // Never let a pending auth handshake keep the process/event loop alive
    // (e.g. during test teardown when the HTTP/Socket.IO server is closed
    // before this timer would otherwise fire).
    authTimer.unref?.();

    // issueChallenge is async (DB lookup). We must set up the auth:response
    // listener inside the .then() so the challenge is in scope.
    issueChallenge(me).then((challenge) => {
      if (!challenge) {
        clearTimeout(authTimer);
        socket.emit('error_msg', { code: 'unknown_identity' });
        socket.disconnect(true);
        return;
      }
      socket.emit('auth:challenge', challengeWire(challenge));

      socket.once('auth:response', (raw: unknown) => {
        const ok =
          typeof raw === 'object' &&
          raw !== null &&
          verifyResponse(challenge, (raw as { plain?: unknown }).plain);
        if (!ok) {
          socket.emit('error_msg', { code: 'auth_failed' });
          socket.disconnect(true);
          return;
        }
        authenticated = true;
        clearTimeout(authTimer);
        onAuthenticated(socket, me, deviceId, challenge).then(async () => {
          const opkCount = await prekeysRepo.countOneTime(me, deviceId); // M-2: per-device count
          socket.emit('auth:ok', { opkCount });
        }).catch(() => {
          socket.emit('error_msg', { code: 'internal_error' });
          socket.disconnect(true);
        });
      });
    }).catch(() => {
      clearTimeout(authTimer);
      socket.emit('error_msg', { code: 'unknown_identity' });
      socket.disconnect(true);
    });

    // Allow unauthenticated sockets to register as a linking-pending desktop.
    socket.on('device:link', (raw: unknown) => {
      const parsed = DeviceLink.safeParse(raw);
      if (!parsed.success) {
        socket.emit('error_msg', { code: 'invalid_device_link' });
        return;
      }
      const { targetAegisId, desktopPubKey } = parsed.data;

      if (linkingSockets.has(desktopPubKey)) {
        clearTimeout(linkingSockets.get(desktopPubKey)!.timer);
      }
      const timer = setTimeout(() => {
        linkingSockets.delete(desktopPubKey);
        socket.emit('error_msg', { code: 'device_link_expired' });
        socket.disconnect(true);
      }, DEVICE_LINK_TTL_MS);
      // Never let a pending device-link request keep the process alive.
      timer.unref?.();
      linkingSockets.set(desktopPubKey, { socket, timer });

      // Neutral response regardless of whether target is online — prevents
      // binary online/offline oracle for unauthenticated sockets (FND-06).
      // If the target is online we forward immediately; if not, the pending
      // entry stays in linkingSockets until the TTL expires or the target
      // authenticates and picks up the link request via its own flow.
      const targetSockets = sockets.get(targetAegisId);
      if (targetSockets && targetSockets.size > 0) {
        for (const s of targetSockets) {
          s.emit('device:link', { desktopPubKey, tempSocketId: socket.id });
        }
      }
      // Always emit 'pending' — same response online or offline
      socket.emit('device:link', { status: 'pending' });
    });

    socket.on('disconnect', () => {
      clearTimeout(authTimer);
    });
  });

  // Per-socket token bucket for the 'envelope' event (prevents flooding).
  // 60 messages/minute with a burst allowance of 20.
  function makeEnvelopeLimiter() {
    let tokens = 20;
    const MAX = 20;
    const REFILL_INTERVAL = 60_000 / 60; // 1 token per second
    const timer = setInterval(() => { if (tokens < MAX) tokens++; }, REFILL_INTERVAL);
    timer.unref?.();
    return {
      consume(): boolean { if (tokens <= 0) return false; tokens--; return true; },
      destroy() { clearInterval(timer); },
    };
  }

  async function onAuthenticated(socket: Socket, me: string, deviceId: string | undefined, _challenge: Challenge) {
    const envelopeLimiter = makeEnvelopeLimiter();
    socket.on('disconnect', () => envelopeLimiter.destroy());

    const set = sockets.get(me) ?? new Set<Socket>();
    set.add(socket);
    sockets.set(me, set);
    // Join a named Socket.IO room so HTTP routes can emit to all devices of this
    // identity without needing direct access to the relay's internal sockets Map.
    void socket.join(`aegis:${me}`);
    // No identity-linked logs in production — zero metadata principle.

    // Look up the sender's X25519 public key once at auth time.
    // Cached in the closure and injected into every delivered envelope so
    // recipients can decrypt messages from unknown senders without a separate
    // HTTP round-trip. Non-fatal if the lookup fails.
    let mySenderPublicKeyB64: string | undefined;
    try {
      const myIdentity = await identityRepo.get(me);
      mySenderPublicKeyB64 = myIdentity?.public_key_b64 ?? undefined;
    } catch { /* non-fatal — omit field from envelopes */ }

    // Drain offline queue for this specific device. Sender identity is NOT
    // stored in DB (FND-05) so the queued envelopes are forwarded without a
    // `from` field — the recipient's sealed-sender logic recovers the sender
    // from the ciphertext itself.
    const pending = await messageRepo.drainFor(me, deviceId);
    for (const row of pending) {
      if (row.epk_b64) {
        // Sealed-sender v2 queued envelope — carries an ephemeral key and no
        // sender identity at all. Emitted on the v2 channel.
        const queuedV2: SealedEnvelopeV2 = {
          id: row.id,
          to: row.recipient,
          ciphertext: row.ciphertext_b64,
          nonce: row.nonce_b64,
          epk: row.epk_b64,
          createdAt: row.created_at,
        };
        socket.emit('envelope:v2', queuedV2);
      } else {
        const queued: QueuedEnvelope = {
          id: row.id,
          to: row.recipient,
          ciphertext: row.ciphertext_b64,
          nonce: row.nonce_b64,
          createdAt: row.created_at,
        };
        // Attach the sender's public key for first-contact (`init`) messages so the
        // recipient can identify+decrypt them even though sealed-sender queue
        // drains otherwise carry no sender info. Only set for init messages.
        if (row.sender_pub_b64) queued.senderPublicKeyB64 = row.sender_pub_b64;
        socket.emit('envelope', queued);
      }
      await messageRepo.delete(row.id, deviceId);
    }

    // Drain queued SenderKey distributions for this device. Each distribution was
    // sealed individually per recipient before leaving the sender's device — the
    // relay forwards the opaque blob verbatim as `group:rekey_dist`. The client
    // MUST ack each distribution via `group:rekey_drain_ack` so the server can
    // purge fully-drained rows. Distributions for which no ack arrives within the
    // TTL are purged by the background cron (same lifecycle as messageRepo).
    const pendingDists = await senderKeyDistRepo.drainFor(me, deviceId);
    for (const dist of pendingDists) {
      // Sealed sender (Phase 3b): no senderAegisId on the wire — the distributor
      // identity is sealed inside ciphertext_b64.
      socket.emit('group:rekey_dist', {
        distId: dist.id,
        groupId: dist.group_id,
        ciphertextB64: dist.ciphertext_b64,
        nonceB64: dist.nonce_b64,
        iteration: dist.iteration,
      });
      // Immediately mark this device as having drained the row so repeated
      // reconnects don't re-deliver the same distribution. The row is hard-deleted
      // once MAX_DRAIN_DEVICES devices have drained it, matching messageRepo.
      await senderKeyDistRepo.delete(dist.id, deviceId);
    }

    // Re-deliver any call:invite that arrived while this device was offline, so a
    // call accepted from the killed-state push wake-up can still connect. Held in
    // memory with a short TTL (see pendingCallInvites / queueCallInvite).
    // After the invite, drain any trickle ICE candidates that arrived while
    // the callee was still offline — emit them in order so the callee's peer
    // connection can begin processing candidates immediately.
    const takenInvite = takePendingCallInvite(me);
    if (takenInvite) {
      const inviteEvent = takenInvite.version === 'v2' ? 'call:invite:v2' : 'call:invite';
      const iceEvent = takenInvite.version === 'v2' ? 'call:ice:v2' : 'call:ice';
      socket.emit(inviteEvent, takenInvite.payload);
      for (const candidate of takenInvite.ice) {
        socket.emit(iceEvent, candidate);
      }
    }

    socket.on(
      'envelope',
      (raw, ack?: (response: { ok: boolean; queued?: boolean; error?: string }) => void) => {
        if (!envelopeLimiter.consume()) {
          ack?.({ ok: false, error: 'rate_limited' });
          return;
        }
        const parsed = EnvelopeIn.safeParse(raw);
        if (!parsed.success) {
          ack?.({ ok: false, error: 'invalid_envelope' });
          return;
        }
        const env: SealedEnvelope = {
          id: parsed.data.id,
          to: parsed.data.to,
          from: me,
          ciphertext: parsed.data.ciphertext,
          nonce: parsed.data.nonce,
          createdAt: Date.now(),
          senderPublicKeyB64: mySenderPublicKeyB64,
        };

        const isSelfSend = env.to === me;
        const recipientSockets = sockets.get(env.to);

        if (isSelfSend) {
          // Self-send: deliver to all OTHER sockets of this aegisId (other devices).
          // The originating socket already has the message locally.
          if (recipientSockets && recipientSockets.size > 1) {
            for (const s of recipientSockets) {
              if (s === socket) continue;
              s.emit('envelope', env);
            }
          }
          ack?.({ ok: true, queued: false });
        } else {
          const delivered = recipientSockets ? deliver(env, recipientSockets) : false;
          if (!delivered) {
            // Sender aegisId is intentionally omitted — the relay must not persist
            // the social graph (FND-05). EXCEPTION: for X3DH-initial (`init`)
            // messages we persist ONLY the sender's public key, so a first
            // message to a new contact survives the offline queue (otherwise the
            // recipient has no way to identify/decrypt it). Bounded to first
            // contact; all normal messages still store no sender info.
            void messageRepo.enqueue({
              id: env.id,
              recipient: env.to,
              ciphertext_b64: env.ciphertext,
              nonce_b64: env.nonce,
              created_at: env.createdAt,
              // A-3: ephemeral messages expire from the queue at createdAt+ttl;
              // 0 signals "use default TTL" — messageRepo.enqueue applies MESSAGE_TTL_MS.
              expires_at: parsed.data.ephemeralTtl ? env.createdAt + parsed.data.ephemeralTtl : 0,
              sender_pub_b64: parsed.data.init ? (mySenderPublicKeyB64 ?? null) : null,
            }).then((result) => {
              if (!result.ok) {
                ack?.({ ok: false, error: result.reason ?? 'queue_full' });
                return;
              }
              // Fire silent push wake-up so the recipient's app reconnects and drains.
              void notifyRecipient(env.to);
              ack?.({ ok: true, queued: true });
            });
            return; // ack will be called in the .then()
          } else {
            ack?.({ ok: true, queued: false });
          }

          // Echo sent-confirmation to other devices of the sender so they can
          // mark the conversation as "sent from this account".
          // NOTE: ciphertext is intentionally omitted — the body travels via a
          // separate self-addressed envelope (env.to === me).
          const mySockets = sockets.get(me);
          if (mySockets && mySockets.size > 1) {
            for (const s of mySockets) {
              if (s === socket) continue;
              s.emit('envelope:sent', {
                id: env.id,
                to: env.to,
                createdAt: env.createdAt,
              });
            }
          }
        }
      }
    );

    // ─── Sealed-sender v2: delivery token registration ───────────────────
    // The authenticated owner registers/rotates the hash of their own delivery
    // token. Only the hash is stored; the raw token is shared with contacts over
    // E2EE (X3DH) and never reaches the relay. See SEALED-SENDER-ARCHITECTURE §3.3.
    socket.on(
      'deliveryToken:register',
      (raw, ack?: (res: { ok: boolean; error?: string }) => void) => {
        const parsed = DeliveryTokenRegister.safeParse(raw);
        if (!parsed.success) {
          ack?.({ ok: false, error: 'invalid_payload' });
          return;
        }
        void deliveryTokenRepo
          .set(me, parsed.data.tokenHashB64, Date.now())
          .then(() => ack?.({ ok: true }))
          .catch(() => ack?.({ ok: false, error: 'store_failed' }));
      }
    );

    // ─── Sealed-sender v2: envelope submission ───────────────────────────
    // The relay NEVER stamps or stores a `from` here — the sender's identity is
    // sealed inside `ciphertext` and recovered only by the recipient. The socket
    // is still authenticated (temporal-correlation limit, §6), but no explicit
    // social-graph edge is ever processed or persisted. Anti-abuse is the
    // recipient's delivery token (validated by hash), not sender authentication.
    socket.on(
      'envelope:v2',
      (raw, ack?: (response: { ok: boolean; queued?: boolean; error?: string }) => void) => {
        if (!envelopeLimiter.consume()) {
          ack?.({ ok: false, error: 'rate_limited' });
          return;
        }
        const parsed = EnvelopeV2In.safeParse(raw);
        if (!parsed.success) {
          ack?.({ ok: false, error: 'invalid_envelope' });
          return;
        }
        const data = parsed.data;
        void (async () => {
          // Anti-abuse gate: the sender must present the recipient's raw delivery
          // token. The relay verifies it against the stored hash in constant time
          // (golden rule #8) without learning who is sending.
          const storedHash = await deliveryTokenRepo.getHash(data.to);
          if (!storedHash || !verifyDeliveryToken(data.deliveryToken, storedHash)) {
            ack?.({ ok: false, error: 'bad_delivery_token' });
            return;
          }
          const env: SealedEnvelopeV2 = {
            id: data.id,
            to: data.to,
            ciphertext: data.ciphertext,
            nonce: data.nonce,
            epk: data.epk,
            createdAt: Date.now(),
          };

          const isSelfSend = env.to === me;
          const recipientSockets = sockets.get(env.to);

          if (isSelfSend) {
            if (recipientSockets && recipientSockets.size > 1) {
              for (const s of recipientSockets) {
                if (s === socket) continue;
                s.emit('envelope:v2', env);
              }
            }
            ack?.({ ok: true, queued: false });
            return;
          }

          const delivered = recipientSockets && recipientSockets.size > 0;
          if (delivered) {
            for (const s of recipientSockets) s.emit('envelope:v2', env);
            // Confirm delivery to the sender's own (authenticated) socket — this
            // is the sender's own device, not a social-graph leak.
            socket.emit('msg:delivered', { msgId: env.id, to: env.to });
            ack?.({ ok: true, queued: false });
            return;
          }

          // Offline: queue with epk so the recipient can open it on drain. No
          // sender identity is stored (FND-05); epk is non-secret ephemeral key.
          const result = await messageRepo.enqueue({
            id: env.id,
            recipient: env.to,
            ciphertext_b64: env.ciphertext,
            nonce_b64: env.nonce,
            created_at: env.createdAt,
            // A-3: clamp queue lifetime for ephemeral messages (see EnvelopeIn).
            expires_at: data.ephemeralTtl ? env.createdAt + data.ephemeralTtl : 0,
            sender_pub_b64: null,
            epk_b64: env.epk,
          });
          if (!result.ok) {
            ack?.({ ok: false, error: result.reason ?? 'queue_full' });
            return;
          }
          void notifyRecipient(env.to);
          ack?.({ ok: true, queued: true });
        })();
      }
    );

    // ─── PreKeys (X3DH) ──────────────────────────────────────────────────
    socket.on('prekeys:upload', (raw, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const parsed = PreKeyUpload.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }

      // Verify SPK signature server-side — defence in depth against DB tampering.
      // identityRepo.get is async so the entire upload flow runs inside the promise chain.
      void identityRepo.get(me).then(async (uploaderIdentity) => {
        if (uploaderIdentity?.signing_public_key_b64) {
          const spkBytes = decodeBase64(parsed.data.signedPreKey.publicKeyB64);
          const sigBytes = decodeBase64(parsed.data.signedPreKey.signatureB64);
          const signingKey = decodeBase64(uploaderIdentity.signing_public_key_b64);
          if (!nacl.sign.detached.verify(spkBytes, sigBytes, signingKey)) {
            ack?.({ ok: false, error: 'invalid_spk_signature' });
            return;
          }

          // PQXDH (v2): verify the Ed25519 signature over the PQ signed prekey the
          // SAME way as the classic SPK above — defence in depth. The relay never
          // inspects the ML-KEM public key itself beyond this signature check; it
          // is stored and served as an opaque blob. Optional field: absent ⇒ this
          // upload stays v1-only, no rejection.
          if (parsed.data.pqSignedPreKey) {
            const pqBytes = decodeBase64(parsed.data.pqSignedPreKey.publicKeyB64);
            const pqSigBytes = decodeBase64(parsed.data.pqSignedPreKey.signatureB64);
            if (!nacl.sign.detached.verify(pqBytes, pqSigBytes, signingKey)) {
              ack?.({ ok: false, error: 'invalid_pq_spk_signature' });
              return;
            }
          }
        }
        const now = Date.now();
        await prekeysRepo.upsertSigned({
          aegis_id: me,
          device_id: parsed.data.deviceId ?? deviceId ?? 'default',
          key_id: parsed.data.signedPreKey.keyId,
          public_key_b64: parsed.data.signedPreKey.publicKeyB64,
          signature_b64: parsed.data.signedPreKey.signatureB64,
          created_at: now,
        });
        if (parsed.data.pqSignedPreKey) {
          await prekeysRepo.upsertPqSigned({
            aegis_id: me,
            device_id: parsed.data.deviceId ?? deviceId ?? 'default',
            key_id: parsed.data.pqSignedPreKey.keyId,
            public_key_b64: parsed.data.pqSignedPreKey.publicKeyB64,
            signature_b64: parsed.data.pqSignedPreKey.signatureB64,
            created_at: now,
          });
        }
        for (const opk of parsed.data.oneTimePreKeys) {
          await prekeysRepo.insertOneTime({
            aegis_id: me,
            device_id: parsed.data.deviceId ?? deviceId ?? 'default', // M-2: per-device OPK
            key_id: opk.keyId,
            public_key_b64: opk.publicKeyB64,
            created_at: now,
          });
        }
        ack?.({ ok: true });
      }).catch(() => {
        ack?.({ ok: false, error: 'db_error' });
      });
    });

    socket.on('prekeys:fetch', (raw, ack?: (res: { ok: boolean; bundle?: PreKeyBundle; error?: string }) => void) => {
      const parsed = PreKeyFetch.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      prekeysRepo.getBundle(parsed.data.aegisId).then((bundle) => {
        if (!bundle) {
          ack?.({ ok: false, error: 'not_found' });
          return;
        }
        ack?.({ ok: true, bundle });
      }).catch(() => {
        ack?.({ ok: false, error: 'db_error' });
      });
    });

    // ─── Typing indicators ───────────────────────────────────────────────────
    socket.on('typing', (raw) => {
      if (!checkLowFreqRateLimit(me)) {
        socket.emit('error_msg', { code: 'rate_limited', for: 'typing' });
        return;
      }
      const parsed = TypingEvent.safeParse(raw);
      if (!parsed.success) return;
      // 1:1 DM path — forward directly to the target user's sockets
      const target = sockets.get(parsed.data.to);
      if (target) {
        for (const s of target) s.emit('typing', { from: me, isTyping: parsed.data.isTyping });
      }
      // Work channel path — also broadcast to the channel room so Work clients
      // can display per-channel "X is typing" indicators
      if (parsed.data.channelId) {
        socket.to(`channel:${parsed.data.channelId}`).emit('typing', {
          from: me,
          isTyping: parsed.data.isTyping,
          orgId: parsed.data.orgId,
          channelId: parsed.data.channelId,
        });
      }
    });

    // ─── Read receipts ───────────────────────────────────────────────────────
    socket.on('msg:read', (raw) => {
      if (!checkLowFreqRateLimit(me)) {
        socket.emit('error_msg', { code: 'rate_limited', for: 'msg:read' });
        return;
      }
      const parsed = MsgRead.safeParse(raw);
      if (!parsed.success) return;
      const target = sockets.get(parsed.data.to);
      if (!target) return;
      for (const s of target) s.emit('msg:read', { from: me, msgIds: parsed.data.msgIds });
    });

    // ─── Remote delete ───────────────────────────────────────────────────────
    socket.on('msg:delete', (raw) => {
      if (!checkLowFreqRateLimit(me)) {
        socket.emit('error_msg', { code: 'rate_limited', for: 'msg:delete' });
        return;
      }
      const parsed = MsgDelete.safeParse(raw);
      if (!parsed.success) return;
      const target = sockets.get(parsed.data.to);
      if (!target) return;
      for (const s of target) s.emit('msg:delete', { from: me, msgId: parsed.data.msgId });
    });

    // ─── Push token registration ─────────────────────────────────────────────
    socket.on('push:register', (raw) => {
      const parsed = PushRegister.safeParse(raw);
      if (!parsed.success) return;
      void pushRepo.upsert({
        aegis_id: me,
        expo_token: parsed.data.token,
        platform: parsed.data.platform,
        updated_at: Date.now(),
      }).catch(() => { /* silent — do not log token or aegisId */ });
    });

    // ─── Device linking (mobile side — approve) ──────────────────────────────
    // Mobile emits this after scanning the desktop QR code and approving.
    // The relay routes the encrypted response to the waiting desktop socket
    // and persists the linked device record in SQLite.
    socket.on('device:link:approve', (raw: unknown) => {
      const parsed = DeviceLinkApprove.safeParse(raw);
      if (!parsed.success) {
        socket.emit('error_msg', { code: 'invalid_device_link_approve' });
        return;
      }
      const { desktopPubKey, encryptedPayload, nonceB64 } = parsed.data;
      const entry = linkingSockets.get(desktopPubKey);
      if (!entry) {
        socket.emit('error_msg', { code: 'device_link_not_found' });
        return;
      }

      // Obtain the mobile's X25519 public key from the identity store so the
      // desktop can verify the encrypted payload came from the correct identity.
      void identityRepo.get(me).then((identity) => {
      const mobilePubKey = identity?.public_key_b64 ?? '';

      // Deliver approval to the waiting desktop and clean up the ephemeral map.
      // Relay never persists desktopPubKey, tempSocketId, or this payload.
      entry.socket.emit('device:link:approved', { encryptedPayload, nonceB64, mobilePubKey });
      clearTimeout(entry.timer);
      linkingSockets.delete(desktopPubKey);
      }).catch(() => { /* silent */ });
    });

    // ─── Device list (in-memory) ─────────────────────────────────────────────
    // Returns how many sockets are currently authenticated under this aegisId
    // and which platforms they declared at handshake time.
    // Never exposes IPs or socket IDs — metadata-free by design.
    socket.on('device:list', (ack: unknown) => {
      if (typeof ack !== 'function') return;
      const mySet = sockets.get(me);
      const platforms: string[] = [];
      if (mySet) {
        for (const s of mySet) {
          const meta = socketMeta.get(s);
          platforms.push(meta?.platform ?? 'unknown');
        }
      }
      (ack as (res: { count: number; platforms: string[] }) => void)({
        count: platforms.length,
        platforms,
      });
    });

    // ─── Device revocation ───────────────────────────────────────────────────
    // Mobile emits { deviceId } to revoke a linked device.
    // Server marks it revoked in DB and disconnects the device's socket if online.
    socket.on('device:revoke', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const parsed = DeviceRevoke.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const { deviceId } = parsed.data;
      devicesRepo.revoke(deviceId, me).then((revoked) => {
        if (!revoked) {
          ack?.({ ok: false, error: 'not_found' });
          return;
        }
        // Disconnect the revoked device's socket if it is currently online under `me`.
        const mySet = sockets.get(me);
        if (mySet) {
          for (const s of mySet) {
            const meta = socketMeta.get(s);
            if (meta?.platform === 'desktop' && s !== socket) {
              s.emit('device:revoked', { deviceId });
              s.disconnect(true);
            }
          }
        }
        ack?.({ ok: true });
      }).catch(() => {
        ack?.({ ok: false, error: 'db_error' });
      });
    });

    // ─── Work channel events ─────────────────────────────────────────────────

    // work:join — join an org room and sync online presence
    socket.on('work:join', (raw: unknown) => {
      const parsed = z.object({ orgId: z.string().regex(UUID_RE) }).safeParse(raw);
      if (!parsed.success) {
        socket.emit('error_msg', { code: 'invalid_payload', for: 'work:join' });
        return;
      }
      const { orgId } = parsed.data;
      workRepo.getMember(orgId, me).then((member) => {
        if (!member) {
          socket.emit('error_msg', { code: 'forbidden', for: 'work:join' });
          return;
        }
        void socket.join(`org:${orgId}`);

        // Register presence
        const presenceSet = orgPresence.get(orgId) ?? new Set<string>();
        presenceSet.add(me);
        orgPresence.set(orgId, presenceSet);

        // Track which orgs this socket joined for disconnect cleanup
        const joined = socketOrgMembership.get(socket.id) ?? [];
        if (!joined.includes(orgId)) {
          joined.push(orgId);
          socketOrgMembership.set(socket.id, joined);
        }

        // Send current presence state to the joining socket only
        socket.emit('work:presence_sync', { orgId, onlineIds: [...presenceSet] });

        // Broadcast join to everyone else in the org room
        socket.to(`org:${orgId}`).emit('work:presence_join', { orgId, aegisId: me });
      }).catch(() => {
        socket.emit('error_msg', { code: 'internal_error', for: 'work:join' });
      });
    });

    // channel:join — subscribe to a channel room
    socket.on('channel:join', (raw: unknown) => {
      const parsed = ChannelJoin.safeParse(raw);
      if (!parsed.success) {
        socket.emit('error_msg', { code: 'invalid_payload', for: 'channel:join' });
        return;
      }
      const { channelId, orgId } = parsed.data;
      Promise.all([
        workRepo.getMember(orgId, me),
        workChannelRepo.get(channelId),
      ]).then(([member, channel]) => {
        if (!member) {
          socket.emit('error_msg', { code: 'forbidden', for: 'channel:join' });
          return;
        }
        // Verify channel actually belongs to the claimed org — prevents cross-org UUID guessing
        if (!channel || channel.org_id !== orgId) {
          socket.emit('error_msg', { code: 'forbidden', for: 'channel:join' });
          return;
        }
        void socket.join(`channel:${channelId}`);
        socket.emit('channel:joined', { channelId });
      }).catch(() => {
        socket.emit('error_msg', { code: 'internal_error', for: 'channel:join' });
      });
    });

    // channel:msg — send a message to a channel
    socket.on('channel:msg', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const parsed = ChannelMsg.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      if (!checkChannelMsgRateLimit(me)) {
        ack?.({ ok: false, error: 'rate_limited' });
        return;
      }
      const { id, channelId, orgId, body, type, parent_id, attachments, encrypted, nonce: msgNonce } = parsed.data;
      // M-6: Work channel bodies must be E2EE. The relay refuses to persist a
      // cleartext body — it never stores readable channel content. A message
      // must declare `encrypted: true` and carry its `nonce`; anything else is
      // rejected (fail-closed, golden rule #1: encryption never degrades).
      if (encrypted !== true || !msgNonce) {
        ack?.({ ok: false, error: 'encryption_required' });
        return;
      }
      // Validate membership and channel in parallel
      Promise.all([
        workRepo.getMember(orgId, me),
        workChannelRepo.get(channelId),
      ]).then(async ([member, channel]) => {
        if (!member) {
          ack?.({ ok: false, error: 'forbidden' });
          return;
        }
        if (!channel || channel.org_id !== orgId) {
          ack?.({ ok: false, error: 'channel_not_found' });
          return;
        }
        // Org-level permission check
        if (!getPermissions(member.role as WorkRole).canSendAnnouncements && channel.is_announcements === 1) {
          ack?.({ ok: false, error: 'forbidden_announcements' });
          return;
        }
        // Channel-level permission check (can_send)
        const channelPerm = await workChannelPermissionRepo.getForRole(channelId, member.role as WorkRole);
        if (channelPerm && channelPerm.can_send === 0) {
          ack?.({ ok: false, error: 'no_send_permission' });
          return;
        }
        // Channel-level upload check
        if (attachments && attachments.length > 0) {
          if (channelPerm && channelPerm.can_upload === 0) {
            ack?.({ ok: false, error: 'no_upload_permission' });
            return;
          }
        }
        // Validate parent exists in same channel when provided
        if (parent_id !== undefined) {
          const parentMsg = await workMessageRepo.getById(parent_id);
          if (!parentMsg || parentMsg.channel_id !== channelId) {
            ack?.({ ok: false, error: 'parent_not_found' });
            return;
          }
        }
        const createdAt = Date.now();
        const createdAtIso = new Date(createdAt).toISOString();
        await workMessageRepo.insert({
          id,
          channel_id: channelId,
          org_id: orgId,
          sender_id: me,
          body,
          type,
          created_at: createdAt,
          parent_id: parent_id ?? null,
        });
        // Persist each attachment record referencing the already-uploaded blob.
        // Clients must upload blobs via POST /blob/upload first, then pass the
        // returned blobId here. The relay never stores file content itself.
        const insertedAttachments: Array<{ id: string; blobId: string; filename: string; mimeType: string; sizeBytes: number }> = [];
        if (attachments && attachments.length > 0) {
          for (const att of attachments) {
            const attId = randomUUID();
            await workAttachmentRepo.insert({
              id: attId,
              message_id: id,
              channel_id: channelId,
              org_id: orgId,
              blob_id: att.blobId,
              filename: att.filename,
              mime_type: att.mimeType,
              size_bytes: att.sizeBytes,
              uploaded_by: me,
              created_at: createdAtIso,
            });
            insertedAttachments.push({ id: attId, blobId: att.blobId, filename: att.filename, mimeType: att.mimeType, sizeBytes: att.sizeBytes });
          }
        }
        const broadcast: {
          id: string;
          channelId: string;
          orgId: string;
          senderId: string;
          body: string;
          type: string;
          createdAt: number;
          parentId: string | null;
          attachments: Array<{ id: string; blobId: string; filename: string; mimeType: string; sizeBytes: number }>;
          encrypted?: boolean;
          nonce?: string;
        } = {
          id,
          channelId,
          orgId,
          senderId: me,
          body,
          type,
          createdAt,
          parentId: parent_id ?? null,
          attachments: insertedAttachments,
        };
        if (encrypted !== undefined) broadcast.encrypted = encrypted;
        if (msgNonce !== undefined) broadcast.nonce = msgNonce;
        io.to(`channel:${channelId}`).emit('channel:msg', broadcast);
        if (parent_id !== undefined) {
          const updatedParent = await workMessageRepo.getById(parent_id);
          io.to(`channel:${channelId}`).emit('channel:thread_update', {
            channelId,
            parentId: parent_id,
            replyCount: updatedParent?.reply_count ?? 1,
          });
        }
        ack?.({ ok: true });
      }).catch(() => {
        ack?.({ ok: false, error: 'internal_error' });
      });
    });

    // channel:delete_msg — soft-delete a channel message
    // Admin can delete any message; member can only delete their own.
    const ChannelDeleteMsg = z.object({
      messageId: z.string().uuid(),
      channelId: z.string().regex(CHANNEL_ID_RE),
      orgId: z.string().regex(ORG_ID_RE),
    });

    socket.on('channel:delete_msg', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const parsed = ChannelDeleteMsg.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const { messageId, channelId, orgId } = parsed.data;
      Promise.all([
        workRepo.getMember(orgId, me),
        workMessageRepo.getById(messageId),
      ]).then(async ([member, message]) => {
        if (!member) {
          ack?.({ ok: false, error: 'forbidden' });
          return;
        }
        if (!message || message.channel_id !== channelId) {
          ack?.({ ok: false, error: 'not_found' });
          return;
        }
        // Only admin/owner may delete others' messages; member may only delete their own
        const isAdmin = getPermissions(member.role as WorkRole).canManageMembers;
        const isOwnMessage = message.sender_id === me;
        if (!isAdmin && !isOwnMessage) {
          ack?.({ ok: false, error: 'forbidden' });
          return;
        }
        await workMessageRepo.softDelete(messageId);
        io.to(`channel:${channelId}`).emit('channel:msg_deleted', { channelId, messageId });
        ack?.({ ok: true });
      }).catch(() => {
        ack?.({ ok: false, error: 'internal_error' });
      });
    });

    // ─── Work E2EE SenderKey distribution ────────────────────────────────────
    // The relay is a blind router: it never inspects, logs, or stores any key
    // material. Ciphertexts, nonces, and chain keys are forwarded opaquely to
    // the intended recipients. If a recipient is offline the distribution is
    // silently dropped — clients re-distribute on next channel join.

    socket.on('work:sender_key_dist', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const parsed = SenderKeyDistEvent.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const { channelId, orgId, recipients } = parsed.data;

      Promise.all([
        workRepo.getMember(orgId, me),
        workChannelRepo.get(channelId),
      ]).then(([member, channel]) => {
        if (!member) {
          ack?.({ ok: false, error: 'forbidden' });
          return;
        }
        if (!channel || channel.org_id !== orgId) {
          ack?.({ ok: false, error: 'channel_not_found' });
          return;
        }

        // Route each per-recipient sealed envelope to the recipient's sockets.
        // The relay only touches the `aegisId` routing field — ciphertextB64,
        // nonceB64, and iteration are never read or stored.
        for (const recipient of recipients) {
          const recipientSockets = sockets.get(recipient.aegisId);
          if (!recipientSockets || recipientSockets.size === 0) {
            // Silently drop — client handles re-distribution on next join.
            continue;
          }
          for (const s of recipientSockets) {
            s.emit('work:sender_key_dist', {
              channelId,
              orgId,
              ciphertextB64: recipient.ciphertextB64,
              nonceB64: recipient.nonceB64,
              iteration: recipient.iteration,
              senderAegisId: recipient.senderAegisId,
            });
          }
        }
        ack?.({ ok: true });
      }).catch(() => {
        ack?.({ ok: false, error: 'internal_error' });
      });
    });

    socket.on('work:request_sender_key', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const parsed = RequestSenderKeyEvent.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const { channelId, orgId, fromAegisId } = parsed.data;

      workRepo.getMember(orgId, me).then((member) => {
        if (!member) {
          ack?.({ ok: false, error: 'forbidden' });
          return;
        }

        const holderSockets = sockets.get(fromAegisId);
        if (!holderSockets || holderSockets.size === 0) {
          // Key holder is offline — notify requester so UI can handle gracefully.
          socket.emit('work:sender_key_unavailable', { channelId, fromAegisId });
          ack?.({ ok: true });
          return;
        }

        // Forward the request to the key holder. The holder responds by emitting
        // a targeted work:sender_key_dist back. The relay never sees the key.
        for (const s of holderSockets) {
          s.emit('work:sender_key_requested', { channelId, requestedBy: me });
        }
        ack?.({ ok: true });
      }).catch(() => {
        ack?.({ ok: false, error: 'internal_error' });
      });
    });

    // ─── Group re-key fan-out (forward secrecy on member removal) ────────────
    // The relay holds no group state (zero metadata), so it cannot consult a
    // membership table. The trust model is: a re-key distribution is only
    // honoured when the emitter sealed it themselves — i.e. every entry's
    // `senderAegisId` MUST equal the authenticated socket identity `me`. This
    // prevents a member from spoofing a re-key on another admin's behalf. The
    // recipient additionally verifies the sealed box opens against the
    // distributor's identity key, and the signed group metadata (group_msg
    // path) governs who is recognised as admin client-side.
    socket.on('group:rekey', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
      if (!checkRekeyRateLimit(me)) {
        ack?.({ ok: false, error: 'rate_limited' });
        return;
      }
      const parsed = GroupRekeyEvent.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const { groupId, distributions } = parsed.data;

      // Sealed sender (Phase 3b): there is no `senderAegisId` to validate — the
      // distributor's identity is sealed inside each blob and the relay never
      // sees it. The old "claimed sender must equal the emitter" guard is gone
      // precisely because the relay must not know the sender. Anti-abuse is the
      // per-`me` rekey rate limit (checkRekeyRateLimit above).
      const now = Date.now();
      const enqueuePromises: Promise<void>[] = [];

      for (const d of distributions) {
        if (d.aegisId === me) continue; // never echo to self

        const recipientSockets = sockets.get(d.aegisId);
        if (recipientSockets && recipientSockets.size > 0) {
          // Recipient is online — forward the opaque blob (no sender identity).
          const distId = randomUUID();
          for (const s of recipientSockets) {
            s.emit('group:rekey_dist', {
              distId,
              groupId,
              ciphertextB64: d.ciphertextB64,
              nonceB64: d.nonceB64,
              iteration: d.iteration,
            });
          }
        } else {
          // Recipient is offline — enqueue the sealed distribution for deferred
          // delivery. The relay stores the blob opaquely; the sender identity is
          // INSIDE ciphertext_b64, so sender_aegis_id is stored empty (the column
          // is retained for schema compatibility / older rows only).
          const distId = randomUUID();
          enqueuePromises.push(
            senderKeyDistRepo.enqueue({
              id: distId,
              recipient: d.aegisId,
              group_id: groupId,
              sender_aegis_id: '',    // sealed sender — relay does not learn the distributor
              ciphertext_b64: d.ciphertextB64,
              nonce_b64: d.nonceB64,
              iteration: d.iteration,
              created_at: now,
              expires_at: 0,          // 0 → apply default MESSAGE_TTL_MS in repo
            }).then(() => { /* enqueue result is advisory — never reveal to sender */ })
          );
        }
      }

      // Fire-and-forget: enqueues run in parallel; we ack immediately so the
      // sender is not blocked waiting for DB writes for potentially hundreds of
      // offline recipients.
      void Promise.all(enqueuePromises);
      ack?.({ ok: true });
    });

    // ─── Group re-key drain ack ──────────────────────────────────────────────
    // The client emits this after successfully processing a `group:rekey_dist`
    // received from the offline queue. The relay uses it to track per-device drain
    // progress and hard-delete the row once all known devices have acked.
    //
    // For online-delivered distributions (emitted directly in `group:rekey`) the
    // client also emits this ack; the relay tolerates a no-op if the row is
    // already gone (it was never persisted for online recipients).
    const RekeyDrainAck = z.object({
      distId: z.string().uuid(),
    });

    socket.on('group:rekey_drain_ack', (raw: unknown) => {
      const parsed = RekeyDrainAck.safeParse(raw);
      if (!parsed.success) {
        socket.emit('error_msg', { code: 'invalid_payload', for: 'group:rekey_drain_ack' });
        return;
      }
      // Fire-and-forget: delete is idempotent and non-fatal if the row is gone.
      // Do not log distId or aegisId — zero-metadata principle.
      void senderKeyDistRepo.delete(parsed.data.distId, deviceId);
    });

    // ─── WebRTC signaling (Fase 3c/3d) ─────────────────────────────────────
    // The server is a dumb forwarder — it never inspects offer/answer/ICE.
    // Media itself is E2EE via DTLS-SRTP (built into WebRTC), independent of
    // anything the server can see. Signaling currently includes `from` so the
    // recipient knows who's calling (sealed call signaling is Fase 4+).
    attachCallSignaling(socket, me, sockets);
    attachGroupCallSignaling(socket, me, sockets);

    socket.on('disconnect', () => {
      const s = sockets.get(me);
      if (s) {
        s.delete(socket);
        if (s.size === 0) sockets.delete(me);
      }
      // Do not log identity on disconnect — metadata leak.
      // Clean up this socket from linking map if it was also registered there
      // (edge case: socket that registered a device:link then authenticated).
      for (const [key, entry] of linkingSockets) {
        if (entry.socket === socket) {
          clearTimeout(entry.timer);
          linkingSockets.delete(key);
          break;
        }
      }

      // Presence cleanup — only remove from org if this was the last socket for `me`
      const remainingSockets = sockets.get(me);
      const isLastSocket = !remainingSockets || remainingSockets.size === 0;
      if (isLastSocket) {
        const orgs = socketOrgMembership.get(socket.id) ?? [];
        for (const orgId of orgs) {
          const presenceSet = orgPresence.get(orgId);
          if (presenceSet) {
            presenceSet.delete(me);
            // Broadcast departure to the org room before pruning the empty set
          io.to(`org:${orgId}`).emit('work:presence_leave', { orgId, aegisId: me });
            if (presenceSet.size === 0) {
              orgPresence.delete(orgId);
            }
          }
        }
      }
      socketOrgMembership.delete(socket.id);
    });
  }
}

const CallTo = z.object({ to: z.string().regex(AEGIS_ID_RE), callId: z.string().min(1).max(128) });
// Sealed call signaling: SDP offers/answers and ICE candidates are E2EE-encrypted
// by the client (NaCl box, sealed-sender) BEFORE they reach the relay. The relay
// only ever sees opaque ciphertext + nonce and forwards them verbatim. It never
// inspects, parses, or stores SDP or ICE content. `media` stays in cleartext only
// so the relay can fire the correct (audio/video) CallKit push wake-up.
const SealedSignal = z.object({
  ciphertext: z.string().min(1).max(32768),
  nonce: z.string().min(1).max(64),
});
const CallInvite = CallTo.extend({
  media: z.enum(['audio', 'video']),
}).merge(SealedSignal);
const CallAnswer = CallTo.merge(SealedSignal);
const CallIce = CallTo.merge(SealedSignal);
const CallHangup = CallTo.extend({ reason: z.string().max(64).optional() });
const CallEnd = CallTo.extend({ reason: z.string().max(64).optional() });
const CallReject = CallTo.extend({ reason: z.string().max(64).optional() });

// ─── Sealed-sender v2 call signaling (Fase 2) ────────────────────────────────
// The relay NEVER stamps `from` on these — the caller's identity is sealed inside
// the invite ciphertext (ephemeral box + Ed25519 sig, recovered only by the
// callee). The invite adds `epk` (per-call ephemeral pubkey); answer/ICE carry a
// secretbox under the call session key established by the invite, so they reuse
// the plain {ciphertext, nonce} shape with no `epk` and no `from`.
const SealedSignalV2 = SealedSignal.extend({ epk: z.string().min(1).max(64) });
const CallInviteV2 = CallTo.extend({ media: z.enum(['audio', 'video']) }).merge(SealedSignalV2);
const CallAnswerV2 = CallTo.merge(SealedSignal);
const CallIceV2 = CallTo.merge(SealedSignal);
const CallHangupV2 = CallTo.extend({ reason: z.string().max(64).optional() });

// ─── Group call Zod schemas ──────────────────────────────────────────────────
const AEGIS_ID_ARRAY = z.array(z.string().regex(AEGIS_ID_RE)).min(1).max(7);
const GroupCallInvite = z.object({
  to: AEGIS_ID_ARRAY,
  callId: z.string().uuid(),
  groupId: z.string().min(1).max(128),
  groupName: z.string().min(1).max(64),
  media: z.enum(['audio', 'video']),
});
const GroupCallAccept  = z.object({ to: z.string().regex(AEGIS_ID_RE), callId: z.string().uuid() });
const GroupCallDecline = z.object({ to: z.string().regex(AEGIS_ID_RE), callId: z.string().uuid() });
const GroupCallOffer   = z.object({ to: z.string().regex(AEGIS_ID_RE), callId: z.string().uuid(), ciphertext: z.string().min(1).max(65536), nonce: z.string().min(1).max(64) });
const GroupCallAnswer  = GroupCallOffer;
const GroupCallIce     = GroupCallOffer;
const GroupCallHangup  = z.object({ to: AEGIS_ID_ARRAY, callId: z.string().uuid(), reason: z.string().max(64).optional() });
// Channel heartbeat announces an open voice channel to the WHOLE group (not just
// the ≤8 mesh), so its recipient list is wider than AEGIS_ID_ARRAY. groupName +
// participants are surfaced only on already-trusting clients (the receiver
// re-checks governance locally); the relay never persists them.
const GROUP_MEMBER_ARRAY = z.array(z.string().regex(AEGIS_ID_RE)).min(1).max(512);
const GroupCallChannel = z.object({
  to: GROUP_MEMBER_ARRAY,
  callId: z.string().uuid(),
  groupId: z.string().min(1).max(128),
  groupName: z.string().min(1).max(64),
  participants: z.array(z.string().regex(AEGIS_ID_RE)).max(512).optional(),
  media: z.enum(['audio', 'video']),
});

// Rate-limit buckets for call:offer — keyed by aegisId, max 5 per minute
const callOfferRateLimit = new Map<string, { count: number; reset: number }>();

function checkCallOfferRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = callOfferRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  callOfferRateLimit.set(aegisId, entry);
  // LRU eviction to prevent unbounded memory growth
  if (callOfferRateLimit.size > RATE_LIMIT_MAP_MAX) {
    const oldest = callOfferRateLimit.keys().next().value;
    if (oldest !== undefined) callOfferRateLimit.delete(oldest);
  }
  return entry.count <= 5;
}

// Rate-limit buckets for group_call:invite — keyed by aegisId, max 3 per minute
const groupCallInviteRateLimit = new Map<string, { count: number; reset: number }>();

function checkGroupCallInviteRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = groupCallInviteRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  groupCallInviteRateLimit.set(aegisId, entry);
  if (groupCallInviteRateLimit.size > RATE_LIMIT_MAP_MAX) {
    const oldest = groupCallInviteRateLimit.keys().next().value;
    if (oldest !== undefined) groupCallInviteRateLimit.delete(oldest);
  }
  return entry.count <= 3;
}

// Rate-limit buckets for group_call:channel heartbeats — keyed by aegisId. A
// channel re-broadcasts every ~20s and joiners emit their own, so allow more
// headroom than the one-shot invite: 20 per minute.
const groupCallChannelRateLimit = new Map<string, { count: number; reset: number }>();

function checkGroupCallChannelRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = groupCallChannelRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  groupCallChannelRateLimit.set(aegisId, entry);
  if (groupCallChannelRateLimit.size > RATE_LIMIT_MAP_MAX) {
    const oldest = groupCallChannelRateLimit.keys().next().value;
    if (oldest !== undefined) groupCallChannelRateLimit.delete(oldest);
  }
  return entry.count <= 20;
}

// Dedupe offline wake-up pushes per (callId, member): the channel heartbeat
// repeats every ~20s, but an offline member should be woken at most once per
// minute per channel — otherwise a long call would push them every 20s. In
// memory only (zero metadata at rest), TTL 60s, bounded.
const GROUPCALL_PUSH_TTL_MS = 60_000;
const GROUPCALL_PUSH_MAP_MAX = 10_000;
const groupCallPushedAt = new Map<string, number>();

function shouldPushGroupCallWake(callId: string, aegisId: string): boolean {
  const key = `${callId}|${aegisId}`;
  const now = Date.now();
  const last = groupCallPushedAt.get(key);
  if (last !== undefined && now - last < GROUPCALL_PUSH_TTL_MS) return false;
  groupCallPushedAt.set(key, now);
  if (groupCallPushedAt.size > GROUPCALL_PUSH_MAP_MAX) {
    const oldest = groupCallPushedAt.keys().next().value;
    if (oldest !== undefined) groupCallPushedAt.delete(oldest);
  }
  return true;
}

// ── Ephemeral call:invite re-delivery queue ──────────────────────────────────
// When the callee is offline we fire a visible push wake-up, but the call only
// connects if the sealed call:invite can be re-delivered once the callee's app
// cold-starts from the push and reconnects. We hold the invite in MEMORY ONLY
// (zero metadata at rest), keyed by recipient aegisId, with a short TTL just
// under the caller's 45s ring window. Purged on drain, caller hangup/end, or TTL.
//
// `ice` accumulates trickle ICE candidates emitted by the caller while the
// callee is offline — bounded to ICE_BUFFER_CAP entries; silently discarded
// beyond that. Purged together with the invite on TTL / drain / cancel.
const ICE_BUFFER_CAP = 32;

interface PendingCallInvite {
  callId: string;
  payload: Record<string, unknown>; // exactly what forward() would emit ({ ...rest } [+ from for v1])
  ice: Record<string, unknown>[];   // buffered trickle ICE candidates (max ICE_BUFFER_CAP)
  timer: ReturnType<typeof setTimeout>;
  version: 'v1' | 'v2';             // which call:invite / call:ice events to drain on
}
const pendingCallInvites = new Map<string, PendingCallInvite>();
const CALL_INVITE_TTL_MS = 35_000;

function queueCallInvite(
  to: string,
  callId: string,
  payload: Record<string, unknown>,
  version: 'v1' | 'v2' = 'v1',
): void {
  const existing = pendingCallInvites.get(to);
  if (existing) clearTimeout(existing.timer);
  const t = setTimeout(() => { pendingCallInvites.delete(to); }, CALL_INVITE_TTL_MS);
  // Never let a ringing invite keep the event loop alive.
  (t as unknown as { unref?: () => void }).unref?.();
  pendingCallInvites.set(to, { callId, payload, ice: [], timer: t, version });
}

interface TakenCallInvite {
  payload: Record<string, unknown>;
  ice: Record<string, unknown>[];
  version: 'v1' | 'v2';
}

function takePendingCallInvite(to: string): TakenCallInvite | null {
  const pending = pendingCallInvites.get(to);
  if (!pending) return null;
  clearTimeout(pending.timer);
  pendingCallInvites.delete(to);
  return { payload: pending.payload, ice: pending.ice, version: pending.version };
}

function cancelCallInvite(to: string, callId: string): void {
  const pending = pendingCallInvites.get(to);
  if (pending && pending.callId === callId) {
    clearTimeout(pending.timer);
    pendingCallInvites.delete(to);
  }
}

function attachCallSignaling(socket: Socket, me: string, sockets: Map<string, Set<Socket>>) {
  // `silent`: when true, suppresses the peer_offline error_msg emit so callers
  // that handle offline specially (call:ice buffering) can avoid the false error.
  function forward<T extends { to: string }>(eventOut: string, parsed: T, silent = false): boolean {
    const target = sockets.get(parsed.to);
    if (!target || target.size === 0) {
      if (!silent) socket.emit('error_msg', { code: 'peer_offline', for: eventOut });
      return false;
    }
    const { to: _to, ...rest } = parsed;
    for (const s of target) s.emit(eventOut, { ...rest, from: me });
    return true;
  }

  // Sealed-sender v2 forward: identical routing by `to`, but NEVER stamps `from`.
  // The caller's identity is sealed inside the invite ciphertext and recovered
  // only by the callee (Fase 2). Returns the payload it would emit (sans `to`).
  function forwardSealed<T extends { to: string }>(
    eventOut: string,
    parsed: T,
    silent = false,
  ): { delivered: boolean; payload: Record<string, unknown> } {
    const { to: _to, ...rest } = parsed;
    const payload = rest as Record<string, unknown>;
    const target = sockets.get(parsed.to);
    if (!target || target.size === 0) {
      if (!silent) socket.emit('error_msg', { code: 'peer_offline', for: eventOut });
      return { delivered: false, payload };
    }
    for (const s of target) s.emit(eventOut, payload);
    return { delivered: true, payload };
  }

  // ── Legacy invite-style signaling (Fase 3c) ──────────────────────────────
  socket.on('call:invite', (raw) => {
    const parsed = CallInvite.safeParse(raw);
    if (!parsed.success) return;
    if (!checkCallOfferRateLimit(me)) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'call:invite' });
      return;
    }
    // Use silent=true: if the callee is offline we decide below whether to emit
    // peer_offline based on whether the push wake-up succeeded. An immediate
    // peer_offline from forward() would incorrectly tear the call down even when
    // the callee is reachable via push (Doze/killed app scenario).
    const delivered = forward('call:invite', parsed.data, /* silent */ true);
    if (!delivered) {
      // Recipient offline. Hold the sealed invite in memory so it can be
      // re-delivered when their app cold-starts from the push and reconnects
      // within the ring window, then fire the visible high-priority push so the
      // OS rings even when the app is killed.
      //
      // Critically: we only tell the caller peer_offline if we could not reach
      // the callee via push either (no tokens registered). If push succeeded we
      // stay silent — the caller's 45s no-answer timeout handles the case where
      // the callee never connects.
      const { to, ...rest } = parsed.data;
      queueCallInvite(to, parsed.data.callId, { ...rest, from: me });
      sendCallWakeUp(
        parsed.data.to,
        me,
        parsed.data.media as CallMedia,
        parsed.data.callId,
      ).then((pushed) => {
        if (!pushed) {
          // Callee unreachable: no push tokens — cancel the queued invite and
          // notify the caller immediately so they can tear down.
          cancelCallInvite(parsed.data.to, parsed.data.callId);
          socket.emit('error_msg', { code: 'peer_offline', for: 'call:invite' });
        }
        // pushed === true: silent — caller keeps ringing, 45s timeout covers it.
      }).catch(() => {
        // Push subsystem down — treat as unreachable.
        cancelCallInvite(parsed.data.to, parsed.data.callId);
        socket.emit('error_msg', { code: 'peer_offline', for: 'call:invite' });
      });
    }
  });
  socket.on('call:answer', (raw) => {
    const parsed = CallAnswer.safeParse(raw);
    if (!parsed.success) return;
    forward('call:answer', parsed.data);
  });
  socket.on('call:ice', (raw) => {
    const parsed = CallIce.safeParse(raw);
    if (!parsed.success) return;
    // Attempt delivery silently — never emit peer_offline for ICE candidates.
    // If the callee is offline but we have a matching pending call:invite,
    // buffer the candidate (up to ICE_BUFFER_CAP) so it can be drained when
    // the callee reconnects and the invite is re-delivered.
    const delivered = forward('call:ice', parsed.data, /* silent */ true);
    if (!delivered) {
      const pending = pendingCallInvites.get(parsed.data.to);
      if (pending && pending.callId === parsed.data.callId) {
        if (pending.ice.length < ICE_BUFFER_CAP) {
          const { to: _to, ...rest } = parsed.data;
          pending.ice.push({ ...rest, from: me });
        }
        // else: silently discard — cap reached
      }
      // No matching pending invite → silently discard. Never emit peer_offline.
    }
  });
  socket.on('call:hangup', (raw) => {
    const parsed = CallHangup.safeParse(raw);
    if (!parsed.success) return;
    // Caller gave up before the callee came online — drop any queued invite so a
    // late reconnect doesn't ring a phantom call.
    cancelCallInvite(parsed.data.to, parsed.data.callId);
    forward('call:hangup', parsed.data);
  });

  // ── Sealed-sender v2 call signaling (Fase 2) ─────────────────────────────
  // Same routing/offline/ICE-buffer behaviour as v1, but the relay NEVER stamps
  // `from`: the caller's identity is sealed inside the invite and recovered only
  // by the callee. The offline queue is tagged v2 so drain re-delivers on the
  // matching v2 events.
  socket.on('call:invite:v2', (raw) => {
    const parsed = CallInviteV2.safeParse(raw);
    if (!parsed.success) return;
    if (!checkCallOfferRateLimit(me)) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'call:invite' });
      return;
    }
    const { delivered, payload } = forwardSealed('call:invite:v2', parsed.data, /* silent */ true);
    if (!delivered) {
      queueCallInvite(parsed.data.to, parsed.data.callId, payload, 'v2');
      sendCallWakeUp(parsed.data.to, me, parsed.data.media as CallMedia, parsed.data.callId)
        .then((pushed) => {
          if (!pushed) {
            cancelCallInvite(parsed.data.to, parsed.data.callId);
            socket.emit('error_msg', { code: 'peer_offline', for: 'call:invite' });
          }
        })
        .catch(() => {
          cancelCallInvite(parsed.data.to, parsed.data.callId);
          socket.emit('error_msg', { code: 'peer_offline', for: 'call:invite' });
        });
    }
  });
  socket.on('call:answer:v2', (raw) => {
    const parsed = CallAnswerV2.safeParse(raw);
    if (!parsed.success) return;
    forwardSealed('call:answer:v2', parsed.data);
  });
  socket.on('call:ice:v2', (raw) => {
    const parsed = CallIceV2.safeParse(raw);
    if (!parsed.success) return;
    const { delivered, payload } = forwardSealed('call:ice:v2', parsed.data, /* silent */ true);
    if (!delivered) {
      const pending = pendingCallInvites.get(parsed.data.to);
      if (pending && pending.callId === parsed.data.callId && pending.version === 'v2') {
        if (pending.ice.length < ICE_BUFFER_CAP) pending.ice.push(payload);
        // else: silently discard — cap reached
      }
      // No matching pending invite → silently discard. Never emit peer_offline.
    }
  });
  socket.on('call:hangup:v2', (raw) => {
    const parsed = CallHangupV2.safeParse(raw);
    if (!parsed.success) return;
    cancelCallInvite(parsed.data.to, parsed.data.callId);
    forwardSealed('call:hangup:v2', parsed.data);
  });

  // ── SDP-style signaling (offer/answer/ice/end/reject) ────────────────────
  // Relay is a dumb forwarder — SDPs and ICE candidates are never stored.
  // call:offer and call:sdp:answer with plaintext SDP are REJECTED.
  // All call signaling must use the sealed NaCl box variants (call:invite / call:answer).
  // These handlers exist only to return a clear error to legacy clients.
  socket.on('call:offer', (_raw) => {
    socket.emit('error_msg', { code: 'plaintext_sdp_rejected', for: 'call:offer',
      message: 'Use call:invite with sealed NaCl box signaling' });
  });

  socket.on('call:sdp:answer', (_raw) => {
    socket.emit('error_msg', { code: 'plaintext_sdp_rejected', for: 'call:sdp:answer',
      message: 'Use call:answer with sealed NaCl box signaling' });
  });

  socket.on('call:end', (raw) => {
    const parsed = CallEnd.safeParse(raw);
    if (!parsed.success) {
      socket.emit('error_msg', { code: 'invalid_payload', for: 'call:end' });
      return;
    }
    // Notify both the recipient AND reflect back to the sender so both sides
    // tear down the peer connection simultaneously.
    const { to, callId, reason } = parsed.data;
    // Drop any queued invite so a late reconnect doesn't ring a phantom call.
    cancelCallInvite(to, callId);
    const target = sockets.get(to);
    if (target) {
      for (const s of target) s.emit('call:end', { callId, reason, from: me });
    }
    // Reflect to sender's other devices (multi-device awareness)
    const mySockets = sockets.get(me);
    if (mySockets) {
      for (const s of mySockets) {
        if (s !== socket) s.emit('call:end', { callId, reason, from: me });
      }
    }
  });

  socket.on('call:reject', (raw) => {
    const parsed = CallReject.safeParse(raw);
    if (!parsed.success) {
      socket.emit('error_msg', { code: 'invalid_payload', for: 'call:reject' });
      return;
    }
    forward('call:reject', parsed.data);
  });

}

// ─── Group call mesh signaling (new sealed-sender protocol) ─────────────────
// The relay is a dumb forwarder: SDP offers/answers and ICE candidates are
// E2EE-sealed (NaCl box) by the client before sending. The relay only sees
// opaque ciphertext+nonce and routes them verbatim. It never stores or
// inspects any SDP or ICE content.
function attachGroupCallSignaling(socket: Socket, me: string, sockets: Map<string, Set<Socket>>) {
  // Forward to a single peer, injecting from: me
  function fwd<T extends { to: string }>(event: string, parsed: T) {
    const { to, ...rest } = parsed;
    const target = sockets.get(to);
    if (target) for (const s of target) s.emit(event, { ...rest, from: me });
  }

  // Fan-out to multiple peers, skipping self
  function fanout<T extends { to: string[] }>(event: string, parsed: T) {
    const { to, ...rest } = parsed;
    for (const id of to) {
      if (id === me) continue;
      const target = sockets.get(id);
      if (target) for (const s of target) s.emit(event, { ...rest, from: me });
    }
  }

  socket.on('group_call:invite', (raw) => {
    const parsed = GroupCallInvite.safeParse(raw);
    if (!parsed.success) return;
    if (!checkGroupCallInviteRateLimit(me)) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'group_call:invite' });
      return;
    }
    fanout('group_call:invite', parsed.data);
  });

  // Voice-channel heartbeat: fan out to ONLINE members (banner awareness) and
  // fire a deduped zero-metadata wake-up push to OFFLINE members so a backgrounded/
  // killed app reconnects and re-receives the heartbeat (→ local "Unirse" notif).
  socket.on('group_call:channel', (raw) => {
    const parsed = GroupCallChannel.safeParse(raw);
    if (!parsed.success) return;
    if (!checkGroupCallChannelRateLimit(me)) return;
    const { to, callId, ...rest } = parsed.data;
    for (const id of to) {
      if (id === me) continue;
      const target = sockets.get(id);
      if (target && target.size > 0) {
        for (const s of target) s.emit('group_call:channel', { ...rest, callId, from: me });
      } else if (shouldPushGroupCallWake(callId, id)) {
        // Offline (no live socket): wake them. Best-effort, never blocks the loop.
        void sendGroupCallWakeUp(id);
      }
    }
  });

  socket.on('group_call:accept',  (raw) => { const p = GroupCallAccept.safeParse(raw);  if (p.success) fwd('group_call:accept',  p.data); });
  socket.on('group_call:decline', (raw) => { const p = GroupCallDecline.safeParse(raw); if (p.success) fwd('group_call:decline', p.data); });
  socket.on('group_call:offer',   (raw) => { const p = GroupCallOffer.safeParse(raw);   if (p.success) fwd('group_call:offer',   p.data); });
  socket.on('group_call:answer',  (raw) => { const p = GroupCallAnswer.safeParse(raw);  if (p.success) fwd('group_call:answer',  p.data); });
  socket.on('group_call:ice',     (raw) => { const p = GroupCallIce.safeParse(raw);     if (p.success) fwd('group_call:ice',     p.data); });
  socket.on('group_call:hangup',  (raw) => { const p = GroupCallHangup.safeParse(raw);  if (p.success) fanout('group_call:hangup', p.data); });
}
