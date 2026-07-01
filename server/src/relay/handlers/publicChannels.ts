// Public Channels relay events (Phase 1, docs/SEALED-PUBLIC-CHANNELS.md).
// Extracted from relay/handler.ts into its own module to match the modular
// handler layout (parity with handlers/channels.ts, prekeys.ts, etc.).
// The relay is a blind forwarder — no `from` field in any pubchannel event.
import type { Server as SocketServer, Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import naclUtil from 'tweetnacl-util';
import {
  publicChannelRepo,
  publicChannelPostRepo,
  publicChannelJoinRepo,
} from '../../db/client.js';
import { evictExpired } from '../rateLimits.js';
import {
  verifyChannelDeliveryToken,
  verifyTombstone,
  verifyDelete,
  verifyBan,
  extractChannelSignerPub,
} from '../../crypto/publicChannelKey.js';

const { decodeBase64 } = naclUtil;

const PUBCHANNEL_FLAG = () => (process.env['PUBLIC_CHANNELS'] ?? 'off').toLowerCase() === 'on';

// Rate limit for pubchannel:msg — keyed by delivery token hash, 120/min
const pubchannelMsgRateLimit = new Map<string, { count: number; reset: number }>();

function checkPubchannelMsgRateLimit(tokenHash: string): boolean {
  const now = Date.now();
  const entry = pubchannelMsgRateLimit.get(tokenHash) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  pubchannelMsgRateLimit.set(tokenHash, entry);
  evictExpired(pubchannelMsgRateLimit);
  return entry.count <= 120;
}

// Rate limit for pubchannel:join — keyed by token hash, 10/min
const pubchannelJoinRateLimit = new Map<string, { count: number; reset: number }>();

function checkPubchannelJoinRateLimit(tokenHash: string): boolean {
  const now = Date.now();
  const entry = pubchannelJoinRateLimit.get(tokenHash) ?? { count: 0, reset: now + 60_000 };
  if (now > entry.reset) { entry.count = 0; entry.reset = now + 60_000; }
  entry.count++;
  pubchannelJoinRateLimit.set(tokenHash, entry);
  evictExpired(pubchannelJoinRateLimit);
  return entry.count <= 10;
}

// Zod schemas for public channel events
const PubChannelJoinSchema = z.object({
  channelId: z.string().min(1).max(64),
  deliveryToken: z.string().min(1).max(256),
});

const PubChannelApplySchema = z.object({
  channelId: z.string().min(1).max(64),
  joinEpk: z.string().min(1).max(128),
});

const PubChannelMsgSchema = z.object({
  channelId: z.string().min(1).max(64),
  ciphertext: z.string().min(1).max(2097152),
  nonce: z.string().min(1).max(64),
  deliveryToken: z.string().min(1).max(256),
});

const PubChannelPullSchema = z.object({
  channelId: z.string().min(1).max(64),
  sinceSeqNum: z.number().int().min(-1),
});

// Admin actions carry NO channelPub on the wire — the relay derives the
// authoritative signing key from the stored manifest. Trusting a client-supplied
// pubkey would let anyone who knows the public channelId forge admin actions by
// signing with their own key (golden rules #3, #7).
const PubChannelDeleteSchema = z.object({
  channelId: z.string().min(1).max(64),
  seqNum: z.number().int().min(0),
  sig: z.string().min(1).max(256),
});

const PubChannelBanSchema = z.object({
  channelId: z.string().min(1).max(64),
  banRecord: z.string().min(1).max(4096),
  banSig: z.string().min(1).max(256),
});

const PubChannelTombstoneSchema = z.object({
  channelId: z.string().min(1).max(64),
  ts: z.number().int().positive(),
  sig: z.string().min(1).max(256),
});

export function attachPublicChannelEvents(socket: Socket, io: SocketServer) {
  // ── pubchannel:join ─────────────────────────────────────────────────────
  socket.on('pubchannel:join', (raw: unknown, ack?: (res: { ok: boolean; manifest?: string; contentKeyEnvelope?: string; error?: string }) => void) => {
    if (!PUBCHANNEL_FLAG()) { ack?.({ ok: false, error: 'feature_disabled' }); return; }
    const parsed = PubChannelJoinSchema.safeParse(raw);
    if (!parsed.success) { ack?.({ ok: false, error: 'invalid_payload' }); return; }
    const { channelId, deliveryToken } = parsed.data;

    void (async () => {
      const channel = await publicChannelRepo.get(channelId);
      if (!channel) { ack?.({ ok: false, error: 'channel_not_found' }); return; }

      // Rate limit by token hash (anonymous — not by aegisId)
      const tokenHash = channel.delivery_token_hash_b64;
      if (!checkPubchannelJoinRateLimit(tokenHash)) { ack?.({ ok: false, error: 'rate_limited' }); return; }

      // Constant-time delivery token verification (golden rule #5)
      if (!verifyChannelDeliveryToken(deliveryToken, channel.delivery_token_hash_b64)) {
        ack?.({ ok: false, error: 'bad_delivery_token' });
        return;
      }

      void socket.join(`pubchannel:${channelId}`);
      // Return the wrapped CEK so a capability-holder can unwrap it (docs §10.1).
      // The relay forwards it opaquely — it never holds the capability/CEK.
      ack?.({ ok: true, manifest: channel.signed_manifest_blob, contentKeyEnvelope: channel.content_key_envelope });
    })();
  });

  // ── pubchannel:apply ────────────────────────────────────────────────────
  socket.on('pubchannel:apply', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    if (!PUBCHANNEL_FLAG()) { ack?.({ ok: false, error: 'feature_disabled' }); return; }
    const parsed = PubChannelApplySchema.safeParse(raw);
    if (!parsed.success) { ack?.({ ok: false, error: 'invalid_payload' }); return; }
    const { channelId, joinEpk } = parsed.data;

    void (async () => {
      const channel = await publicChannelRepo.get(channelId);
      if (!channel) { ack?.({ ok: false, error: 'channel_not_found' }); return; }

      const result = await publicChannelJoinRepo.enqueue(joinEpk, channelId);
      if (!result.ok) { ack?.({ ok: false, error: result.reason ?? 'enqueue_failed' }); return; }
      ack?.({ ok: true });
    })();
  });

  // ── pubchannel:msg ──────────────────────────────────────────────────────
  //
  // Channel role/type enforcement (readonly / moderated / approval) is CLIENT-SIDE
  // by design, NOT server-enforced — this is intentional, not a gap (audit 2026-06-30
  // M1). A single per-channel delivery token gates posting; the relay verifies only
  // "holds a valid token for this channel", never *who* is posting or their role.
  // Enforcing roles server-side would require the relay to (a) know each channel's
  // role table and (b) bind a poster identity to each message — both are metadata the
  // sealed-sender / zero-metadata model deliberately refuses to hold. The manifest
  // (signed by the owner, verified by clients) is the source of truth for who may
  // post; a misbehaving client can be dropped by peers on manifest-signature grounds,
  // not by the blind relay. If server-enforced write roles are ever required, mint a
  // SEPARATE write-capability token distinct from the read/delivery token rather than
  // teaching the relay about identities. See docs/SEALED-PUBLIC-CHANNELS.md.
  socket.on('pubchannel:msg', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    if (!PUBCHANNEL_FLAG()) { ack?.({ ok: false, error: 'feature_disabled' }); return; }
    const parsed = PubChannelMsgSchema.safeParse(raw);
    if (!parsed.success) { ack?.({ ok: false, error: 'invalid_payload' }); return; }
    const { channelId, ciphertext, nonce, deliveryToken } = parsed.data;

    void (async () => {
      const channel = await publicChannelRepo.get(channelId);
      if (!channel) { ack?.({ ok: false, error: 'channel_not_found' }); return; }

      // Rate limit by token hash (preserves sender anonymity)
      const tokenHash = channel.delivery_token_hash_b64;
      if (!checkPubchannelMsgRateLimit(tokenHash)) { ack?.({ ok: false, error: 'rate_limited' }); return; }

      // Constant-time delivery token verification (golden rule #5)
      if (!verifyChannelDeliveryToken(deliveryToken, channel.delivery_token_hash_b64)) {
        ack?.({ ok: false, error: 'bad_delivery_token' });
        return;
      }

      // Assign next seq_num and persist
      const highestSeq = await publicChannelPostRepo.highestSeq(channelId);
      const seqNum = highestSeq + 1;
      const postId = randomUUID();
      const now = Date.now();

      await publicChannelPostRepo.append({
        id: postId,
        channel_id: channelId,
        seq_num: seqNum,
        ciphertext_b64: ciphertext,
        nonce_b64: nonce,
        post_hash_b64: '', // hash computed client-side, relay is blind
        created_at: now,
        expires_at: 0,
      });

      // Fan-out to all room members — NO `from` field (sealed sender)
      io.to(`pubchannel:${channelId}`).emit('pubchannel:msg', {
        channelId,
        seqNum,
        ciphertext,
        nonce,
        createdAt: now,
      });

      ack?.({ ok: true });
    })();
  });

  // ── pubchannel:pull ─────────────────────────────────────────────────────
  socket.on('pubchannel:pull', (raw: unknown, ack?: (res: { ok: boolean; posts?: Array<Record<string, unknown>>; error?: string }) => void) => {
    if (!PUBCHANNEL_FLAG()) { ack?.({ ok: false, error: 'feature_disabled' }); return; }
    const parsed = PubChannelPullSchema.safeParse(raw);
    if (!parsed.success) { ack?.({ ok: false, error: 'invalid_payload' }); return; }
    const { channelId, sinceSeqNum } = parsed.data;

    void (async () => {
      const posts = await publicChannelPostRepo.listSince(channelId, sinceSeqNum);
      ack?.({ ok: true, posts: posts as unknown as Array<Record<string, unknown>> });
    })();
  });

  // ── pubchannel:delete ───────────────────────────────────────────────────
  socket.on('pubchannel:delete', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    if (!PUBCHANNEL_FLAG()) { ack?.({ ok: false, error: 'feature_disabled' }); return; }
    const parsed = PubChannelDeleteSchema.safeParse(raw);
    if (!parsed.success) { ack?.({ ok: false, error: 'invalid_payload' }); return; }
    const { channelId, seqNum, sig: sigB64 } = parsed.data;

    void (async () => {
      const channel = await publicChannelRepo.get(channelId);
      if (!channel) { ack?.({ ok: false, error: 'channel_not_found' }); return; }
      // Authoritative signing key from the STORED manifest — never from the wire.
      const channelPub = extractChannelSignerPub(channel.signed_manifest_blob);
      if (!channelPub) { ack?.({ ok: false, error: 'invalid_channel' }); return; }

      let sig: Uint8Array;
      try {
        sig = decodeBase64(sigB64);
      } catch { ack?.({ ok: false, error: 'invalid_payload' }); return; }

      if (!verifyDelete(channelId, seqNum, sig, channelPub)) {
        ack?.({ ok: false, error: 'invalid_signature' });
        return;
      }

      await publicChannelPostRepo.deleteBySeq(channelId, seqNum);
      // Fan-out delete notification to room members
      io.to(`pubchannel:${channelId}`).emit('pubchannel:delete', { channelId, seqNum });
      ack?.({ ok: true });
    })();
  });

  // ── pubchannel:ban ──────────────────────────────────────────────────────
  socket.on('pubchannel:ban', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    if (!PUBCHANNEL_FLAG()) { ack?.({ ok: false, error: 'feature_disabled' }); return; }
    const parsed = PubChannelBanSchema.safeParse(raw);
    if (!parsed.success) { ack?.({ ok: false, error: 'invalid_payload' }); return; }
    const { channelId, banRecord, banSig: banSigB64 } = parsed.data;

    void (async () => {
      const channel = await publicChannelRepo.get(channelId);
      if (!channel) { ack?.({ ok: false, error: 'channel_not_found' }); return; }
      const channelPub = extractChannelSignerPub(channel.signed_manifest_blob);
      if (!channelPub) { ack?.({ ok: false, error: 'invalid_channel' }); return; }

      let banSig: Uint8Array;
      try {
        banSig = decodeBase64(banSigB64);
      } catch { ack?.({ ok: false, error: 'invalid_payload' }); return; }

      // Verify signature over the ban record against the authoritative channel key.
      if (!verifyBan(channelId, banRecord, banSig, channelPub)) {
        ack?.({ ok: false, error: 'invalid_signature' });
        return;
      }

      // Fan-out ban to room members
      io.to(`pubchannel:${channelId}`).emit('pubchannel:ban', { channelId, banRecord, banSig: banSigB64 });
      ack?.({ ok: true });
    })();
  });

  // ── pubchannel:tombstone ────────────────────────────────────────────────
  socket.on('pubchannel:tombstone', (raw: unknown, ack?: (res: { ok: boolean; error?: string }) => void) => {
    if (!PUBCHANNEL_FLAG()) { ack?.({ ok: false, error: 'feature_disabled' }); return; }
    const parsed = PubChannelTombstoneSchema.safeParse(raw);
    if (!parsed.success) { ack?.({ ok: false, error: 'invalid_payload' }); return; }
    const { channelId, ts, sig: sigB64 } = parsed.data;

    void (async () => {
      const channel = await publicChannelRepo.get(channelId);
      if (!channel) { ack?.({ ok: false, error: 'channel_not_found' }); return; }
      // Authoritative signing key from the STORED manifest — never from the wire.
      const channelPub = extractChannelSignerPub(channel.signed_manifest_blob);
      if (!channelPub) { ack?.({ ok: false, error: 'invalid_channel' }); return; }

      let sig: Uint8Array;
      try {
        sig = decodeBase64(sigB64);
      } catch { ack?.({ ok: false, error: 'invalid_payload' }); return; }

      // Verify tombstone signature against the authoritative channel key (golden rule #3)
      if (!verifyTombstone(channelId, ts, sig, channelPub)) {
        ack?.({ ok: false, error: 'invalid_signature' });
        return;
      }

      // Delete channel + all posts + pending joins
      await publicChannelRepo.delete(channelId);

      // Fan-out tombstone to room members, then clear the room
      io.to(`pubchannel:${channelId}`).emit('pubchannel:tombstone', { channelId, ts });
      // Disconnect all sockets from the room
      const roomSockets = await io.in(`pubchannel:${channelId}`).fetchSockets();
      for (const s of roomSockets) s.leave(`pubchannel:${channelId}`);

      ack?.({ ok: true });
    })();
  });
}
