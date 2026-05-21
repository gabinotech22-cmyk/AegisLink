import type { Server as SocketServer, Socket } from 'socket.io';
import { z } from 'zod';
import { messageRepo, prekeysRepo, pushRepo, devicesRepo, identityRepo } from '../db/client.js';
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

const TypingEvent = z.object({
  to: z.string().regex(AEGIS_ID_RE),
  isTyping: z.boolean(),
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

// In-memory socket data (never persisted)
type Platform = 'mobile' | 'desktop' | 'unknown';

interface SocketMeta {
  platform: Platform;
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
    const auth = socket.handshake.auth as { aegisId?: unknown; platform?: unknown };
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
    socketMeta.set(socket, { platform });

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
        onAuthenticated(socket, me, challenge).then(async () => {
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

  async function onAuthenticated(socket: Socket, me: string, _challenge: Challenge) {
    const set = sockets.get(me) ?? new Set<Socket>();
    set.add(socket);
    sockets.set(me, set);
    // Join a named Socket.IO room so HTTP routes can emit to all devices of this
    // identity without needing direct access to the relay's internal sockets Map.
    void socket.join(`aegis:${me}`);
    // No identity-linked logs in production — zero metadata principle.

    // Drain offline queue. Sender identity is NOT stored in DB (FND-05) so the
    // queued envelopes are forwarded without a `from` field — the recipient's
    // sealed-sender logic recovers the sender from the ciphertext itself.
    const pending = await messageRepo.drainFor(me);
    for (const row of pending) {
      const queued: QueuedEnvelope = {
        id: row.id,
        to: row.recipient,
        ciphertext: row.ciphertext_b64,
        nonce: row.nonce_b64,
        createdAt: row.created_at,
      };
      socket.emit('envelope', queued);
      await messageRepo.delete(row.id);
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
        };

        const recipientSockets = sockets.get(env.to);
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
      const target = sockets.get(parsed.data.to);
      if (!target) return;
      for (const s of target) s.emit('typing', { from: me, isTyping: parsed.data.isTyping });
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
    });
  }
}

const CallTo = z.object({ to: z.string().regex(AEGIS_ID_RE), callId: z.string().min(1).max(128) });
const CallInvite = CallTo.extend({
  media: z.enum(['audio', 'video']),
  offer: z.string().min(1).max(16384),
});
const CallOffer = CallTo.extend({
  sdp: z.string().min(1).max(16384),
  media: z.enum(['audio', 'video']).optional(),
});
const CallAnswer = CallTo.extend({ answer: z.string().min(1).max(16384) });
const CallAnswerSdp = CallTo.extend({ sdp: z.string().min(1).max(16384) });
const CallIce = CallTo.extend({ candidate: z.string().min(1).max(4096) });
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
