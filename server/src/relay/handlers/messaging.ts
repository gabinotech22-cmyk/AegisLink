import type { Socket } from 'socket.io';
import { TypingEvent, MsgRead, PushRegister, VoipRegister, ApnsRegister } from '../schemas.js';
import { checkLowFreqRateLimit } from '../rateLimits.js';
import { pushRepo, voipTokenRepo, apnsTokenRepo } from '../../db/client.js';

export interface MessagingEphemeralDeps {
  me: string;
  sockets: Map<string, Set<Socket>>;
}

/**
 * Attach short-lived messaging event handlers to an authenticated socket:
 * typing indicators, read receipts, remote deletes, and push-token registration.
 * None of these persist sender/recipient pairs (zero metadata principle).
 */
export function attachMessagingEphemeral(socket: Socket, { me, sockets }: MessagingEphemeralDeps): void {
  // ─── Typing indicators ──────────────────────────────────────────────────────
  socket.on('typing', async (raw) => {
    if (!(await checkLowFreqRateLimit(me))) {
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

  // ─── Read receipts ──────────────────────────────────────────────────────────
  socket.on('msg:read', async (raw) => {
    if (!(await checkLowFreqRateLimit(me))) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'msg:read' });
      return;
    }
    const parsed = MsgRead.safeParse(raw);
    if (!parsed.success) return;
    const target = sockets.get(parsed.data.to);
    if (!target) return;
    for (const s of target) s.emit('msg:read', { from: me, msgIds: parsed.data.msgIds });
  });

  // ─── Remote delete ──────────────────────────────────────────────────────────
  // The legacy plaintext `msg:delete` relay event was REMOVED. It leaked the
  // sender↔recipient pair to the relay (violating sealed-sender / zero-metadata)
  // and carried no proof-of-key-possession, so anyone able to emit it could
  // erase a peer's messages. Delete-for-everyone now travels sealed inside the
  // E2EE ratchet channel (`{type:'msg_delete'}`); the relay only ever sees an
  // opaque envelope. Do NOT reintroduce a plaintext delete event.

  // ─── Push token registration ─────────────────────────────────────────────
  // ACK after the write resolves (mirrors voip:register). Previously this was
  // fire-and-forget: the client emitted and cached the token as "registered"
  // immediately, so a lost frame or a rate-limited emit left the relay with NO
  // token for the identity while the client never retried — killed-app iOS then
  // had nothing to wake (notifyRecipient found zero tokens). The ack lets the
  // client re-register until the relay confirms. Never log the token/aegisId.
  socket.on('push:register', async (raw, ack) => {
    const sendAck = (ok: boolean): void => { if (typeof ack === 'function') ack({ ok }); };
    if (!(await checkLowFreqRateLimit(me))) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'push:register' });
      sendAck(false);
      return;
    }
    const parsed = PushRegister.safeParse(raw);
    if (!parsed.success) { sendAck(false); return; }
    try {
      await pushRepo.upsert({
        aegis_id: me,
        expo_token: parsed.data.token,
        platform: parsed.data.platform,
        updated_at: Date.now(),
      });
      sendAck(true);
    } catch {
      sendAck(false);
    }
  });

  // ─── iOS VoIP (PushKit) token registration ───────────────────────────────
  // Same authenticated path as push:register: the token is bound to `me`, the
  // aegisId proven via the Ed25519 challenge-response. Knowing an aegisId never
  // lets anyone else register a VoIP token for it (security golden rule #3).
  socket.on('voip:register', async (raw, ack) => {
    // ACK only after the write resolves so the client can safely mark the token
    // as registered; on any failure it retries on the next auth. Never log the
    // token or aegisId.
    const sendAck = (ok: boolean): void => { if (typeof ack === 'function') ack({ ok }); };
    if (!(await checkLowFreqRateLimit(me))) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'voip:register' });
      sendAck(false);
      return;
    }
    const parsed = VoipRegister.safeParse(raw);
    if (!parsed.success) { sendAck(false); return; }
    try {
      await voipTokenRepo.upsert({
        aegis_id: me,
        voip_token: parsed.data.token,
        updated_at: Date.now(),
      });
      sendAck(true);
    } catch {
      sendAck(false);
    }
  });

  // ─── iOS standard APNs token (direct-APNs message wake) ──────────────────────
  // Same authenticated path as push:register/voip:register: the raw APNs token is
  // bound to `me` (aegisId proven via Ed25519 challenge-response). Knowing an
  // aegisId never lets anyone register a token for it (security golden rule #3).
  socket.on('apns:register', async (raw, ack) => {
    const sendAck = (ok: boolean): void => { if (typeof ack === 'function') ack({ ok }); };
    if (!(await checkLowFreqRateLimit(me))) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'apns:register' });
      sendAck(false);
      return;
    }
    const parsed = ApnsRegister.safeParse(raw);
    if (!parsed.success) { sendAck(false); return; }
    try {
      await apnsTokenRepo.upsert({
        aegis_id: me,
        apns_token: parsed.data.token,
        updated_at: Date.now(),
      });
      sendAck(true);
    } catch {
      sendAck(false);
    }
  });
}
