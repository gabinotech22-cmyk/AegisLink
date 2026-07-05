import type { Server as SocketServer, Socket } from 'socket.io';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  UUID_RE,
  ChannelJoin,
  ChannelMsg,
  ChannelDeleteMsg,
  SenderKeyDistEvent,
  RequestSenderKeyEvent,
  GroupRekeyEvent,
  RekeyDrainAck,
} from '../schemas.js';
import {
  checkChannelMsgRateLimit,
  checkRekeyRateLimit,
} from '../rateLimits.js';
import {
  workRepo,
  workChannelRepo,
  workMessageRepo,
  workAttachmentRepo,
  workChannelPermissionRepo,
  senderKeyDistRepo,
  getPermissions,
  type WorkRole,
} from '../../db/client.js';

export interface ChannelsDeps {
  me: string;
  deviceId: string | undefined;
  sockets: Map<string, Set<Socket>>;
  io: SocketServer;
  /** Maps orgId to the set of aegisIds currently online in that org (presence). */
  orgPresence: Map<string, Set<string>>;
  /** Maps socket.id to the list of orgIds the socket joined, for cleanup. */
  socketOrgMembership: Map<string, string[]>;
}

export function attachChannels(socket: Socket, deps: ChannelsDeps): void {
  const { me, deviceId, sockets, io, orgPresence, socketOrgMembership } = deps;

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
  socket.on('channel:msg', async (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    const parsed = ChannelMsg.safeParse(raw);
    if (!parsed.success) {
      ack?.({ ok: false, error: 'invalid_payload' });
      return;
    }
    if (!(await checkChannelMsgRateLimit(me))) {
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

  // ─── Work E2EE SenderKey distribution ──────────────────────────────────────
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
            // Authenticated identity from the socket, never the client-supplied
            // field — a member cannot spoof a distribution as another member
            // (golden rule #7: trust derived server-side, not client-supplied).
            senderAegisId: me,
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

  // ─── Group re-key fan-out (forward secrecy on member removal) ──────────────
  // The relay holds no group state (zero metadata), so it cannot consult a
  // membership table. The trust model is: a re-key distribution is only
  // honoured when the emitter sealed it themselves — i.e. every entry's
  // `senderAegisId` MUST equal the authenticated socket identity `me`. This
  // prevents a member from spoofing a re-key on another admin's behalf. The
  // recipient additionally verifies the sealed box opens against the
  // distributor's identity key, and the signed group metadata (group_msg
  // path) governs who is recognised as admin client-side.
  socket.on('group:rekey', async (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    if (!(await checkRekeyRateLimit(me))) {
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

  // ─── Group re-key drain ack ────────────────────────────────────────────────
  // The client emits this after successfully processing a `group:rekey_dist`
  // received from the offline queue. The relay uses it to track per-device drain
  // progress and hard-delete the row once all known devices have acked.
  //
  // For online-delivered distributions (emitted directly in `group:rekey`) the
  // client also emits this ack; the relay tolerates a no-op if the row is
  // already gone (it was never persisted for online recipients).
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
}
