import type { Server as SocketServer, Socket } from 'socket.io';
import { z } from 'zod';
import { messageRepo, prekeysRepo, pushRepo, devicesRepo, identityRepo, workRepo, workChannelRepo, workMessageRepo, workAttachmentRepo, workChannelPermissionRepo, getPermissions, type WorkRole } from '../db/client.js';
import { issueChallenge, verifyResponse, challengeWire, type Challenge } from '../auth/challenge.js';
import { notifyRecipient, sendCallWakeUp, type CallMedia } from '../push/expo.js';

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
  })).max(100)
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
  chainKeyB64: z.string().length(44),
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
const GroupRekeyDistribution = z.object({
  aegisId: z.string().min(1).max(64),
  ciphertextB64: z.string().max(1024),
  nonceB64: z.string().length(44),
  chainKeyB64: z.string().length(44),
  iteration: z.number().int().min(0),
  senderAegisId: z.string().min(1).max(64),
});

const GroupRekeyEvent = z.object({
  groupId: z.string().min(1).max(64),
  distributions: z.array(GroupRekeyDistribution).min(1).max(256),
});

// Rate-limit buckets for channel:msg — keyed by aegisId, max 120/min
const channelMsgRateLimit = new Map<string, { count: number; reset: number }>();

function checkChannelMsgRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = channelMsgRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  channelMsgRateLimit.set(aegisId, entry);
  return entry.count <= 120;
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

  (globalThis as any).aegisEmitPollUpdate = (pollId: string, counts: number[]) => {
    io.emit('poll:update', { pollId, counts });
  };

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
          const opkCount = await prekeysRepo.countOneTime(me);
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
      linkingSockets.set(desktopPubKey, { socket, timer });

      const targetSockets = sockets.get(targetAegisId);
      if (!targetSockets || targetSockets.size === 0) {
        socket.emit('error_msg', { code: 'peer_offline' });
        clearTimeout(timer);
        linkingSockets.delete(desktopPubKey);
        return;
      }
      for (const s of targetSockets) {
        s.emit('device:link', { desktopPubKey, tempSocketId: socket.id });
      }
    });

    socket.on('disconnect', () => {
      clearTimeout(authTimer);
    });
  });

  async function onAuthenticated(socket: Socket, me: string, deviceId: string | undefined, _challenge: Challenge) {
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
      const queued: QueuedEnvelope = {
        id: row.id,
        to: row.recipient,
        ciphertext: row.ciphertext_b64,
        nonce: row.nonce_b64,
        createdAt: row.created_at,
      };
      socket.emit('envelope', queued);
      await messageRepo.delete(row.id, deviceId);
    }

    socket.on(
      'envelope',
      (raw, ack?: (response: { ok: boolean; queued?: boolean; error?: string }) => void) => {
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
            // sender is intentionally omitted — relay must not persist the social graph (FND-05).
            void messageRepo.enqueue({
              id: env.id,
              recipient: env.to,
              ciphertext_b64: env.ciphertext,
              nonce_b64: env.nonce,
              created_at: env.createdAt,
              // 0 signals "use default TTL" — messageRepo.enqueue applies MESSAGE_TTL_MS
              expires_at: 0,
            });
            // Fire silent push wake-up so the recipient's app reconnects and drains.
            void notifyRecipient(env.to);
            ack?.({ ok: true, queued: true });
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

    // ─── PreKeys (X3DH) ──────────────────────────────────────────────────
    socket.on('prekeys:upload', (raw, ack?: (res: { ok: boolean; error?: string }) => void) => {
      const parsed = PreKeyUpload.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const now = Date.now();
      prekeysRepo.upsertSigned({
        aegis_id: me,
        device_id: parsed.data.deviceId ?? deviceId ?? 'default',
        key_id: parsed.data.signedPreKey.keyId,
        public_key_b64: parsed.data.signedPreKey.publicKeyB64,
        signature_b64: parsed.data.signedPreKey.signatureB64,
        created_at: now
      }).then(async () => {
        for (const opk of parsed.data.oneTimePreKeys) {
          await prekeysRepo.insertOneTime({
            aegis_id: me,
            key_id: opk.keyId,
            public_key_b64: opk.publicKeyB64,
            created_at: now
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
      const parsed = MsgRead.safeParse(raw);
      if (!parsed.success) return;
      const target = sockets.get(parsed.data.to);
      if (!target) return;
      for (const s of target) s.emit('msg:read', { from: me, msgIds: parsed.data.msgIds });
    });

    // ─── Remote delete ───────────────────────────────────────────────────────
    socket.on('msg:delete', (raw) => {
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
      workRepo.getMember(orgId, me).then((member) => {
        if (!member) {
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
          const { randomUUID } = await import('node:crypto');
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
        // nonceB64, chainKeyB64, and iteration are never read or stored.
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
              chainKeyB64: recipient.chainKeyB64,
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
      const parsed = GroupRekeyEvent.safeParse(raw);
      if (!parsed.success) {
        ack?.({ ok: false, error: 'invalid_payload' });
        return;
      }
      const { groupId, distributions } = parsed.data;

      // Reject if any distribution claims a different sender than the emitter.
      if (distributions.some((d) => d.senderAegisId !== me)) {
        ack?.({ ok: false, error: 'forbidden' });
        return;
      }

      for (const d of distributions) {
        if (d.aegisId === me) continue; // never echo to self
        const recipientSockets = sockets.get(d.aegisId);
        if (!recipientSockets || recipientSockets.size === 0) continue; // offline — client retries
        for (const s of recipientSockets) {
          s.emit('group:rekey_dist', {
            groupId,
            senderAegisId: me,
            ciphertextB64: d.ciphertextB64,
            nonceB64: d.nonceB64,
            chainKeyB64: d.chainKeyB64,
            iteration: d.iteration,
          });
        }
      }
      ack?.({ ok: true });
    });

    // ─── WebRTC signaling (Fase 3c/3d) ─────────────────────────────────────
    // The server is a dumb forwarder — it never inspects offer/answer/ICE.
    // Media itself is E2EE via DTLS-SRTP (built into WebRTC), independent of
    // anything the server can see. Signaling currently includes `from` so the
    // recipient knows who's calling (sealed call signaling is Fase 4+).
    attachCallSignaling(socket, me, sockets);

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
const CallOffer = CallTo.extend({
  sdp: z.string().min(1).max(16384),
  media: z.enum(['audio', 'video']).optional(),
});
const CallAnswer = CallTo.merge(SealedSignal);
const CallAnswerSdp = CallTo.extend({ sdp: z.string().min(1).max(16384) });
const CallIce = CallTo.merge(SealedSignal);
const CallHangup = CallTo.extend({ reason: z.string().max(64).optional() });
const CallEnd = CallTo.extend({ reason: z.string().max(64).optional() });
const CallReject = CallTo.extend({ reason: z.string().max(64).optional() });

// Rate-limit buckets for call:offer — keyed by aegisId, max 5 per minute
const callOfferRateLimit = new Map<string, { count: number; reset: number }>();

function checkCallOfferRateLimit(aegisId: string): boolean {
  const now = Date.now();
  const entry = callOfferRateLimit.get(aegisId) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  callOfferRateLimit.set(aegisId, entry);
  return entry.count <= 5;
}

function attachCallSignaling(socket: Socket, me: string, sockets: Map<string, Set<Socket>>) {
  function forward<T extends { to: string }>(eventOut: string, parsed: T) {
    const target = sockets.get(parsed.to);
    if (!target || target.size === 0) {
      socket.emit('error_msg', { code: 'peer_offline', for: eventOut });
      return false;
    }
    const { to: _to, ...rest } = parsed;
    for (const s of target) s.emit(eventOut, { ...rest, from: me });
    return true;
  }

  // ── Legacy invite-style signaling (Fase 3c) ──────────────────────────────
  socket.on('call:invite', (raw) => {
    const parsed = CallInvite.safeParse(raw);
    if (!parsed.success) return;
    if (!checkCallOfferRateLimit(me)) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'call:invite' });
      return;
    }
    const delivered = forward('call:invite', parsed.data);
    if (!delivered) {
      // Recipient offline — fire high-priority push so the OS wakes their app.
      // The call:invite will be re-delivered via socket once they reconnect and
      // emit call:invite again, or they can answer from the CallKit/Notification UI.
      void sendCallWakeUp(
        parsed.data.to,
        me,
        parsed.data.media as CallMedia,
        parsed.data.callId,
      ).catch(() => { /* push subsystem unavailable — call will be missed */ });
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
    forward('call:ice', parsed.data);
  });
  socket.on('call:hangup', (raw) => {
    const parsed = CallHangup.safeParse(raw);
    if (!parsed.success) return;
    forward('call:hangup', parsed.data);
  });

  // ── SDP-style signaling (offer/answer/ice/end/reject) ────────────────────
  // Relay is a dumb forwarder — SDPs and ICE candidates are never stored.
  socket.on('call:offer', (raw) => {
    const parsed = CallOffer.safeParse(raw);
    if (!parsed.success) {
      socket.emit('error_msg', { code: 'invalid_payload', for: 'call:offer' });
      return;
    }
    if (!checkCallOfferRateLimit(me)) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'call:offer' });
      return;
    }
    const target = sockets.get(parsed.data.to);
    if (!target || target.size === 0) {
      socket.emit('error_msg', { code: 'peer_offline', for: 'call:offer' });
      // Fire push wake-up so the OS wakes the callee's app for the SDP-style flow.
      void sendCallWakeUp(
        parsed.data.to,
        me,
        (parsed.data.media ?? 'audio') as CallMedia,
        parsed.data.callId,
      ).catch(() => { /* push subsystem unavailable */ });
      return;
    }
    const { to: _to, ...rest } = parsed.data;
    for (const s of target) s.emit('call:offer', { ...rest, from: me, type: 'offer' });
  });

  socket.on('call:sdp:answer', (raw) => {
    const parsed = CallAnswerSdp.safeParse(raw);
    if (!parsed.success) {
      socket.emit('error_msg', { code: 'invalid_payload', for: 'call:sdp:answer' });
      return;
    }
    const target = sockets.get(parsed.data.to);
    if (!target || target.size === 0) {
      socket.emit('error_msg', { code: 'peer_offline', for: 'call:sdp:answer' });
      return;
    }
    const { to: _to, ...rest } = parsed.data;
    for (const s of target) s.emit('call:sdp:answer', { ...rest, from: me, type: 'answer' });
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

  // ── Group call mesh signaling ────────────────────────────────────────────
  // The relay blindly forwards offer/answer/ICE to the named peer inside the
  // group call. SDPs and ICE candidates are never stored or inspected.
  const GroupSignal = z.object({
    callId: z.string().min(1).max(128),
    toAegisId: z.string().regex(AEGIS_ID_RE),
    sdp: z.string().min(1).max(16384).optional(),
    candidate: z.string().min(1).max(4096).optional(),
  });

  function forwardGroupSignal(event: string, raw: unknown) {
    const parsed = GroupSignal.safeParse(raw);
    if (!parsed.success) {
      socket.emit('error_msg', { code: 'invalid_payload', for: event });
      return;
    }
    const { callId, toAegisId, ...rest } = parsed.data;
    const target = sockets.get(toAegisId);
    if (!target || target.size === 0) {
      socket.emit('error_msg', { code: 'peer_offline', for: event });
      return;
    }
    for (const s of target) {
      s.emit(event, { callId, fromAegisId: me, ...rest });
    }
  }

  socket.on('group_offer',  (raw) => forwardGroupSignal('group_offer',  raw));
  socket.on('group_answer', (raw) => forwardGroupSignal('group_answer', raw));
  socket.on('group_ice',    (raw) => forwardGroupSignal('group_ice',    raw));
}
