/**
 * AegisLink — Group call HTTP routes
 *
 * Rooms are held in memory (Map) — they never touch SQLite.
 * The relay never inspects SDPs or ICE candidates; it is a blind forwarder.
 * No IPs, no caller identity pairs, no SDP content are logged.
 */

import { Router } from 'express';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import type { Server as SocketServer } from 'socket.io';

// ── In-memory room store ───────────────────────────────────────────────────────

export interface GroupCallRoom {
  callId: string;
  groupId: string;
  media: 'audio' | 'video';
  participants: Set<string>; // aegisIds currently in the call
  expiresAt: number;
}

// Exported so attachGroupCallSignaling can read/mutate it.
export const groupCallRooms = new Map<string, GroupCallRoom>();

const ROOM_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

// Purge expired rooms every 10 minutes (fire-and-forget).
setInterval(() => {
  const now = Date.now();
  for (const [id, room] of groupCallRooms) {
    if (room.expiresAt < now) groupCallRooms.delete(id);
  }
}, 10 * 60 * 1000).unref();

// ── Zod schemas ────────────────────────────────────────────────────────────────

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

const InitiateSchema = z.object({
  groupId: z.string().min(1).max(128),
  initiatorId: z.string().regex(AEGIS_ID_RE),
  media: z.enum(['audio', 'video']),
  // Optional list of member aegisIds to notify via socket.
  // If omitted the route just creates the room without emitting invites.
  memberIds: z.array(z.string().regex(AEGIS_ID_RE)).max(50).optional(),
});

const JoinSchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE),
});

const LeaveSchema = z.object({
  aegisId: z.string().regex(AEGIS_ID_RE),
});

// ── Factory ────────────────────────────────────────────────────────────────────

export function createGroupCallsRouter(io: SocketServer): Router {
  const router = Router();

  // Helper: resolve all active socketIds for an aegisId (multi-device aware).
  // We re-use the same lookup mechanism as the relay: iterate all sockets in
  // the room belonging to a given aegisId. Since we do not have direct access
  // to the relay's internal `sockets` Map we use the Socket.IO room mechanism
  // instead — each authenticated socket joins a private room named after its
  // aegisId (wired in attachRelay via socket.join).
  function emitToAegisId(aegisId: string, event: string, data: unknown) {
    io.to(`aegis:${aegisId}`).emit(event, data);
  }

  // POST /calls/group/initiate
  router.post('/initiate', (req, res) => {
    const parsed = InitiateSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    const { groupId, initiatorId, media, memberIds } = parsed.data;
    const callId = randomUUID();
    const expiresAt = Date.now() + ROOM_TTL_MS;

    const room: GroupCallRoom = {
      callId,
      groupId,
      media,
      participants: new Set([initiatorId]),
      expiresAt,
    };
    groupCallRooms.set(callId, room);

    // Emit group_call_invite to every member except the initiator.
    if (memberIds && memberIds.length > 0) {
      for (const memberId of memberIds) {
        if (memberId !== initiatorId) {
          emitToAegisId(memberId, 'group_call_invite', {
            callId,
            groupId,
            media,
            expiresAt,
          });
        }
      }
    }

    res.status(200).json({ callId, expiresAt });
  });

  // POST /calls/group/:callId/join
  router.post('/:callId/join', (req, res) => {
    const parsed = JoinSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    const { callId } = req.params;
    const room = groupCallRooms.get(callId);
    if (!room) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    if (room.expiresAt < Date.now()) {
      groupCallRooms.delete(callId);
      res.status(410).json({ error: 'CALL_EXPIRED' });
      return;
    }

    const { aegisId } = parsed.data;
    const existingParticipants = Array.from(room.participants);
    room.participants.add(aegisId);

    // Notify every current participant that a new peer has joined.
    for (const participantId of existingParticipants) {
      emitToAegisId(participantId, 'group_call_joined', { callId, aegisId });
    }

    res.status(200).json({ participants: Array.from(room.participants) });
  });

  // POST /calls/group/:callId/leave
  router.post('/:callId/leave', (req, res) => {
    const parsed = LeaveSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'INVALID_PAYLOAD' });
      return;
    }
    const { callId } = req.params;
    const room = groupCallRooms.get(callId);
    if (!room) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }

    const { aegisId } = parsed.data;
    room.participants.delete(aegisId);

    // Notify remaining participants.
    for (const participantId of room.participants) {
      emitToAegisId(participantId, 'group_call_left', { callId, aegisId });
    }

    // Clean up empty rooms immediately.
    if (room.participants.size === 0) groupCallRooms.delete(callId);

    res.status(200).json({ ok: true });
  });

  // GET /calls/group/:callId
  router.get('/:callId', (req, res) => {
    const { callId } = req.params;
    const room = groupCallRooms.get(callId);
    if (!room) {
      res.status(404).json({ error: 'NOT_FOUND' });
      return;
    }
    res.status(200).json({
      callId: room.callId,
      participants: Array.from(room.participants),
      media: room.media,
      expiresAt: room.expiresAt,
    });
  });

  return router;
}
