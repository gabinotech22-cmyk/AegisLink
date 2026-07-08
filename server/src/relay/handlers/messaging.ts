import type { Socket } from 'socket.io';
import { TypingEvent, MsgRead, PushRegister, VoipRegister } from '../schemas.js';
import { checkLowFreqRateLimit } from '../rateLimits.js';
import { pushRepo, voipTokenRepo } from '../../db/client.js';

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
  socket.on('push:register', async (raw) => {
    if (!(await checkLowFreqRateLimit(me))) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'push:register' });
      return;
    }
    const parsed = PushRegister.safeParse(raw);
    if (!parsed.success) return;
    void pushRepo.upsert({
      aegis_id: me,
      expo_token: parsed.data.token,
      platform: parsed.data.platform,
      updated_at: Date.now(),
    }).catch(() => { /* silent — do not log token or aegisId */ });
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
}
