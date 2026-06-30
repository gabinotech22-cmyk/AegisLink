import type { Socket } from 'socket.io';
import { z } from 'zod';
import { sendCallWakeUp, sendGroupCallWakeUp, type CallMedia } from '../push/expo.js';
import { AEGIS_ID_RE } from './schemas.js';
import { RATE_LIMIT_MAP_MAX } from './rateLimits.js';

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
// Sealed signaling fields: opaque ciphertext+nonce. The sender's identity is
// sealed INSIDE the body (recovered by the recipient via trial-decryption against
// the call/group roster); the relay never sees `from`. ciphertext caps at 64 KB —
// a sealed channel roster of ≤512 aegisIds fits comfortably.
const sealedFields = { ciphertext: z.string().min(1).max(65536), nonce: z.string().min(1).max(64) };
// A sealed item addressed to one recipient — used by the per-recipient fan-outs
// (hangup, channel heartbeat), where every recipient gets its OWN ciphertext.
const SealedItem = z.object({ to: z.string().regex(AEGIS_ID_RE), ...sealedFields });

const GroupCallOffer   = z.object({ to: z.string().regex(AEGIS_ID_RE), callId: z.string().uuid(), ...sealedFields });
const GroupCallAnswer  = GroupCallOffer;
const GroupCallIce     = GroupCallOffer;
// accept/decline now carry the sender's identity SEALED (previously plaintext with
// a relay-stamped `from`, which leaked the group-call graph).
const GroupCallAccept  = GroupCallOffer;
const GroupCallDecline = GroupCallOffer;
// hangup fans a per-recipient sealed item out to each mesh peer (≤7), no `from`.
const GroupCallHangup  = z.object({
  callId: z.string().uuid(),
  reason: z.string().max(64).optional(),
  items: z.array(SealedItem).min(1).max(7),
});
// Channel heartbeat announces an open voice channel to the WHOLE group. The live
// roster, groupName and sender identity travel SEALED, one item per recipient, so
// the relay learns neither who is in the call nor who is heartbeating. groupId +
// media stay cleartext: the relay already fingerprints the group from the
// recipient set (the `to` of each item), so sealing them would add nothing.
const GroupCallChannel = z.object({
  callId: z.string().uuid(),
  groupId: z.string().min(1).max(128),
  media: z.enum(['audio', 'video']),
  items: z.array(SealedItem).min(1).max(512),
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

export function takePendingCallInvite(to: string): TakenCallInvite | null {
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

export function attachCallSignaling(socket: Socket, me: string, sockets: Map<string, Set<Socket>>) {
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

// ─── Group call mesh signaling (sealed-sender, Fase B) ──────────────────────
// The relay is a blind forwarder: every signaling body is E2EE-sealed (NaCl box)
// by the client, with the sender's identity SEALED INSIDE. The relay sees only
// opaque ciphertext+nonce and the routing `to`; it NEVER stamps `from`, so it
// learns no group-call graph (who calls/conferences with whom). The recipient
// recovers + authenticates the sender by trial-decrypting against its roster.
export function attachGroupCallSignaling(socket: Socket, me: string, sockets: Map<string, Set<Socket>>) {
  // Sealed forward to a single peer — routes by `to`, NEVER stamps `from`.
  // Mirror of the 1:1 v2 forwardSealed(): the caller's identity rides sealed
  // inside the ciphertext and is recovered only by the recipient.
  function fwdSealed<T extends { to: string }>(event: string, parsed: T) {
    const { to: _to, ...rest } = parsed;
    const target = sockets.get(parsed.to);
    if (target) for (const s of target) s.emit(event, rest);
  }

  socket.on('group_call:accept',  (raw) => { const p = GroupCallAccept.safeParse(raw);  if (p.success) fwdSealed('group_call:accept',  p.data); });
  socket.on('group_call:decline', (raw) => { const p = GroupCallDecline.safeParse(raw); if (p.success) fwdSealed('group_call:decline', p.data); });
  socket.on('group_call:offer',   (raw) => { const p = GroupCallOffer.safeParse(raw);   if (p.success) fwdSealed('group_call:offer',   p.data); });
  socket.on('group_call:answer',  (raw) => { const p = GroupCallAnswer.safeParse(raw);  if (p.success) fwdSealed('group_call:answer',  p.data); });
  socket.on('group_call:ice',     (raw) => { const p = GroupCallIce.safeParse(raw);     if (p.success) fwdSealed('group_call:ice',     p.data); });

  // Hangup: per-recipient sealed fan-out to each mesh peer (≤7), no `from`.
  socket.on('group_call:hangup', (raw) => {
    const p = GroupCallHangup.safeParse(raw);
    if (!p.success) return;
    const { callId, reason, items } = p.data;
    for (const it of items) {
      if (it.to === me) continue;
      const target = sockets.get(it.to);
      if (target) {
        const payload = reason === undefined
          ? { callId, ciphertext: it.ciphertext, nonce: it.nonce }
          : { callId, reason, ciphertext: it.ciphertext, nonce: it.nonce };
        for (const s of target) s.emit('group_call:hangup', payload);
      }
    }
  });

  // Voice-channel heartbeat: per-recipient sealed roster, no `from`. ONLINE
  // members get the sealed banner; OFFLINE members get a deduped zero-metadata
  // wake-up push so a backgrounded/killed app reconnects and re-receives it.
  socket.on('group_call:channel', (raw) => {
    const parsed = GroupCallChannel.safeParse(raw);
    if (!parsed.success) return;
    if (!checkGroupCallChannelRateLimit(me)) return;
    const { callId, groupId, media, items } = parsed.data;
    for (const it of items) {
      if (it.to === me) continue;
      const target = sockets.get(it.to);
      if (target && target.size > 0) {
        for (const s of target) s.emit('group_call:channel', { callId, groupId, media, ciphertext: it.ciphertext, nonce: it.nonce });
      } else if (shouldPushGroupCallWake(callId, it.to)) {
        // Offline (no live socket): wake them. Best-effort, never blocks the loop.
        void sendGroupCallWakeUp(it.to);
      }
    }
  });

  // group_call:invite (legacy ring-all) is unused by current clients — the
  // Discord-style `group_call:channel` heartbeat replaced it. Its fanout still
  // stamps `from`; left intact only so an old build can't crash the relay, and
  // slated for removal in the Fase C cleanup (drop legacy v1 handlers).
  socket.on('group_call:invite', (raw) => {
    const parsed = GroupCallInvite.safeParse(raw);
    if (!parsed.success) return;
    if (!checkGroupCallInviteRateLimit(me)) {
      socket.emit('error_msg', { code: 'rate_limited', for: 'group_call:invite' });
      return;
    }
    const { to, ...rest } = parsed.data;
    for (const id of to) {
      if (id === me) continue;
      const target = sockets.get(id);
      if (target) for (const s of target) s.emit('group_call:invite', { ...rest, from: me });
    }
  });
}
