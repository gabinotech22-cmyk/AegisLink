import type { Server as SocketServer, Socket } from 'socket.io';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { decodeBase64, encodeBase64 } = naclUtil;
import { messageRepo, senderKeyDistRepo, prekeysRepo, identityRepo, deliveryTokenRepo, pushEndpointRepo, pushMailboxTokenRepo } from '../db/client.js';
import { issueChallenge, verifyResponse, challengeWire, type Challenge } from '../auth/challenge.js';
import { verifyDeliveryToken } from '../crypto/deliveryToken.js';
import { mailboxIdForSignPublicKey, verifyMailboxAuth } from '../crypto/mailbox.js';
import { notifyRecipient } from '../push/expo.js';
import { notifyMailbox, isSafeUpEndpoint, isExpoWakeToken, isTokenWakeEnabled } from '../push/ntfy.js';
import {
  AEGIS_ID_RE,
  EnvelopeIn,
  EnvelopeV2In,
  DeliveryTokenRegister,
  AUTH_TIMEOUT_MS,
  DEVICE_LINK_TTL_MS,
  DeviceLink,
  MailboxEnvelopeIn,
  type SealedEnvelope,
  type QueuedEnvelope,
  type SealedEnvelopeV2,
} from './schemas.js';

export type { PreKeyBundle, SealedEnvelope, QueuedEnvelope, SealedEnvelopeV2 } from './schemas.js';



import { attachCallSignaling, attachGroupCallSignaling, takePendingCallInvite } from './callSignaling.js';
import { checkDeviceLinkRateLimit, RATE_LIMIT_MAP_MAX } from './rateLimits.js';
import { liveSockets } from './liveSockets.js';
import { attachPrekeys } from './handlers/prekeys.js';
import { attachMessagingEphemeral } from './handlers/messaging.js';
import { attachChannels } from './handlers/channels.js';
import { attachPublicChannelEvents } from './handlers/publicChannels.js';
import { attachDevices } from './handlers/devices.js';

// Fixed sha256-length (32-byte) dummy hash. The sealed-sender v2 submission gate
// runs its constant-time delivery-token check against this when `to` has no
// token registered, so the response time can't reveal whether `to` is a v2
// recipient — closes a low-severity existence oracle. (The `getHash` DB lookup
// is a weaker residual timing oracle, out of scope for this application guard.)
const DUMMY_DELIVERY_TOKEN_HASH = Buffer.alloc(32).toString('base64');

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

  // Fase 4: mailboxIdB64 -> set of sockets authenticated for that mailbox.
  // The relay holds no aegisId for these — routing is purely by opaque mailbox id.
  const mailboxSockets = new Map<string, Set<Socket>>();

  // Temporary map for sockets in device-linking flow (unauthenticated desktop sockets)
  // desktopPubKey -> { socket, timer }
  const linkingSockets = new Map<string, { socket: Socket; timer: ReturnType<typeof setTimeout> }>();

  function deliver(env: SealedEnvelope, recipientSockets: Set<Socket>): boolean {
    const live = liveSockets(recipientSockets);
    if (live.length === 0) return false;
    for (const s of live) s.emit('envelope', env);
    // Notify the sender that delivery succeeded (if they are still online)
    const senderSockets = sockets.get(env.from);
    if (senderSockets) {
      for (const s of liveSockets(senderSockets)) s.emit('msg:delivered', { msgId: env.id, to: env.to });
    }
    return true;
  }

  io.on('connection', (socket) => {
    const auth = socket.handshake.auth as {
      aegisId?: unknown; platform?: unknown; deviceId?: unknown;
      mailboxId?: unknown; mailboxSignPubKey?: unknown; binds?: unknown;
    };

    // ── Fase 4: mailbox-mode handshake ────────────────────────────────────────
    // Authenticate the socket by proving possession of a mailbox signing key —
    // the relay never receives the aegisId. Selected when the client presents a
    // mailbox instead of an aegisId. Additive: aegisId clients are unaffected.
    // `binds` (Slice 5b) carries additional epoch mailboxes to bind+drain in the
    // same handshake (catch-up across an offline epoch boundary).
    if (typeof auth?.mailboxId === 'string' && typeof auth?.mailboxSignPubKey === 'string') {
      // `binds` may arrive as a real array (the JS socket.io client) or as a JSON
      // string (the native socket.io-client-java transport used for Tor, whose
      // handshake auth is typed Map<String,String> and cannot carry a nested
      // array). Tolerate both — a malformed string is treated as no extra binds.
      let binds: unknown = auth.binds;
      if (typeof binds === 'string') {
        try { binds = JSON.parse(binds); } catch { binds = undefined; }
      }
      handleMailboxConnection(socket, auth.mailboxId, auth.mailboxSignPubKey, binds);
      return;
    }

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
    // reconnection and would corrupt drained_by / drain-cap accounting.
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
    socket.on('device:link', async (raw: unknown) => {
      const parsed = DeviceLink.safeParse(raw);
      if (!parsed.success) {
        socket.emit('error_msg', { code: 'invalid_device_link' });
        return;
      }
      const { targetAegisId, desktopPubKey } = parsed.data;

      // Throttle per target identity so an unauthenticated socket can't spam
      // link requests at a victim. Silent drop — no oracle signal on excess.
      if (!(await checkDeviceLinkRateLimit(targetAegisId))) {
        return;
      }
      // Bound the pending-link map independently of the rate-limit maps: refuse
      // new entries past the cap rather than evicting a live pending link.
      if (!linkingSockets.has(desktopPubKey) && linkingSockets.size >= RATE_LIMIT_MAP_MAX) {
        return;
      }

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

  // Fase 4 Slice 1 + Slice 5b: authenticate a socket as one or more MAILBOXES via
  // possession proofs (Ed25519) over a SINGLE challenge, bind each by its
  // recomputed id, drain each offline queue, then deliver mailbox-addressed
  // envelopes online. The relay never learns the aegisId.
  //
  // Multi-bind (Slice 5b) reconciles daily id rotation with the 30-day offline
  // queue: a reconnecting client binds its CURRENT epoch plus any epoch it was
  // offline across (and the just-passed one, for sender clock skew), so messages
  // queued under a past epoch's id still drain. Each id is proven independently
  // (one signature per id over the same challenge) — binding an id whose root you
  // don't hold is impossible. Capped to bound work. Live rotation is handled
  // client-side by reconnecting at each epoch boundary (fresh circuit + re-derive).
  const MAX_MAILBOX_BINDS = 32; // >= MESSAGE_TTL/epoch (30d) + skew grace

  function handleMailboxConnection(
    socket: Socket,
    claimedMailboxId: string,
    signPubKeyB64: string,
    extraBindsRaw?: unknown,
  ) {
    // Validate the primary mailbox id ↔ signing key binding. Any mismatch is an
    // attempt to claim an id not derived from this key (hijack) → reject.
    let primarySignPub: Uint8Array;
    try { primarySignPub = decodeBase64(signPubKeyB64); } catch {
      socket.emit('error_msg', { code: 'bad_handshake' }); socket.disconnect(true); return;
    }
    if (primarySignPub.length !== 32 || mailboxIdForSignPublicKey(primarySignPub) !== claimedMailboxId) {
      socket.emit('error_msg', { code: 'bad_handshake' }); socket.disconnect(true); return;
    }

    // Additional epoch binds (catch-up + skew window): de-duped, capped, and each
    // id↔key binding validated up front. A bad binding is a hijack attempt on that
    // id → reject the whole handshake (a correct client never sends one).
    const binds = new Map<string, Uint8Array>([[claimedMailboxId, primarySignPub]]);
    if (Array.isArray(extraBindsRaw)) {
      if (extraBindsRaw.length > MAX_MAILBOX_BINDS) {
        socket.emit('error_msg', { code: 'bad_handshake' }); socket.disconnect(true); return;
      }
      for (const e of extraBindsRaw) {
        const id = (e as { mailboxId?: unknown })?.mailboxId;
        const pkB64 = (e as { mailboxSignPubKey?: unknown })?.mailboxSignPubKey;
        if (typeof id !== 'string' || typeof pkB64 !== 'string') {
          socket.emit('error_msg', { code: 'bad_handshake' }); socket.disconnect(true); return;
        }
        if (binds.has(id)) continue; // already counted (primary or repeat)
        let pk: Uint8Array;
        try { pk = decodeBase64(pkB64); } catch {
          socket.emit('error_msg', { code: 'bad_handshake' }); socket.disconnect(true); return;
        }
        if (pk.length !== 32 || mailboxIdForSignPublicKey(pk) !== id) {
          socket.emit('error_msg', { code: 'bad_handshake' }); socket.disconnect(true); return;
        }
        binds.set(id, pk);
      }
    }

    const challenge = nacl.randomBytes(32);
    let authenticated = false;
    const authTimer = setTimeout(() => {
      if (!authenticated) { socket.emit('error_msg', { code: 'auth_timeout' }); socket.disconnect(true); }
    }, AUTH_TIMEOUT_MS);
    authTimer.unref?.();

    socket.emit('mailbox:challenge', { nonce: encodeBase64(challenge) });

    socket.once('mailbox:auth:response', (raw: unknown) => {
      // Primary possession proof (signs the challenge with the primary key).
      const sigB64 = (raw as { sig?: unknown })?.sig;
      let primarySig: Uint8Array | null = null;
      if (typeof sigB64 === 'string') { try { primarySig = decodeBase64(sigB64); } catch { primarySig = null; } }
      if (!primarySig || !verifyMailboxAuth(primarySignPub, challenge, primarySig)) {
        socket.emit('error_msg', { code: 'auth_failed' }); socket.disconnect(true); return;
      }

      // Per-id proofs for the extra binds (each signs the SAME challenge).
      const extraSigById = new Map<string, Uint8Array>();
      const extraSigs = (raw as { extraSigs?: unknown })?.extraSigs;
      if (Array.isArray(extraSigs)) {
        for (const s of extraSigs) {
          const id = (s as { mailboxId?: unknown })?.mailboxId;
          const sg = (s as { sig?: unknown })?.sig;
          if (typeof id !== 'string' || typeof sg !== 'string') continue;
          try { extraSigById.set(id, decodeBase64(sg)); } catch { /* skip malformed */ }
        }
      }
      const boundIds: string[] = [claimedMailboxId];
      for (const [id, pk] of binds) {
        if (id === claimedMailboxId) continue;
        const sg = extraSigById.get(id);
        if (!sg || !verifyMailboxAuth(pk, challenge, sg)) {
          // A claimed extra bind that fails its proof aborts the whole handshake:
          // the client asked to drain an id it cannot prove it owns.
          socket.emit('error_msg', { code: 'auth_failed' }); socket.disconnect(true); return;
        }
        boundIds.push(id);
      }

      authenticated = true;
      clearTimeout(authTimer);

      for (const id of boundIds) {
        const set = mailboxSockets.get(id) ?? new Set<Socket>();
        set.add(socket);
        mailboxSockets.set(id, set);
      }

      const limiter = makeEnvelopeLimiter();

      socket.on('envelope:mb', async (
        rawEnv: unknown,
        ack?: (r: { ok: boolean; delivered?: boolean; queued?: boolean; error?: string }) => void,
      ) => {
        if (!limiter.consume()) { ack?.({ ok: false, error: 'rate_limited' }); return; }
        const parsed = MailboxEnvelopeIn.safeParse(rawEnv);
        if (!parsed.success) { ack?.({ ok: false, error: 'invalid_envelope' }); return; }
        const d = parsed.data;
        // The relay never stamps a sender — the source mailbox is sealed inside.
        const env = { id: d.id, to: d.to, ciphertext: d.ciphertext, nonce: d.nonce, epk: d.epk, createdAt: Date.now() };
        // AT-LEAST-ONCE (audit 2026-07-24): ALWAYS enqueue first — a durable backup
        // under the opaque mailbox id — THEN attempt live delivery. The row is
        // deleted only when the recipient confirms receipt via 'envelope:ack'; if a
        // live emit is lost over Tor (or the recipient drops before persisting), the
        // row survives and re-drains on the next connect. The client dedups by id.
        // No sender info is stored (only the sealed ciphertext + epk).
        const result = await messageRepo.enqueue({
          id: d.id, recipient: d.to,
          ciphertext_b64: d.ciphertext, nonce_b64: d.nonce,
          created_at: env.createdAt,
          // Slice 5: ephemeral messages expire from the queue at createdAt+ttl;
          // 0 → messageRepo applies the default MESSAGE_TTL_MS. Mirrors the aegisId path.
          expires_at: d.ephemeralTtl ? env.createdAt + d.ephemeralTtl : 0,
          sender_pub_b64: null, epk_b64: d.epk,
        });
        if (!result.ok) { ack?.({ ok: false, error: result.reason ?? 'queue_full' }); return; }
        const recipients = mailboxSockets.get(d.to);
        const liveRecipients = recipients ? liveSockets(recipients).filter((s) => s !== socket) : [];
        if (liveRecipients.length > 0) {
          for (const s of liveRecipients) s.emit('envelope:mb', env);
          ack?.({ ok: true, delivered: true });
        } else {
          // Slice 2b: best-effort, zero-metadata wake-up publish to the ntfy
          // topic = d.to (co-hosted ntfy, docs/FASE4-SLICE2B-PUSH-DESIGN.md §5.1
          // v1). Flag-gated (PUSH_MAILBOX_ENABLED); never blocks the ack.
          void notifyMailbox(d.to);
          ack?.({ ok: true, delivered: false, queued: true });
        }
      });

      // Slice 2b.3b: register/clear a UnifiedPush endpoint for one of THIS
      // socket's authenticated mailbox ids. Possession of the mailbox signing
      // key was already proven above (golden rule #3) — a caller can only bind
      // endpoints for ids it authenticated, never for arbitrary mailboxes.
      // endpoint: string → bind (validated against SSRF); null → unbind.
      socket.on('mailbox:push:endpoint', async (
        raw: unknown,
        ack?: (r: { ok: boolean; error?: string }) => void,
      ) => {
        if (!limiter.consume()) { ack?.({ ok: false, error: 'rate_limited' }); return; }
        const mailboxId = (raw as { mailboxId?: unknown })?.mailboxId;
        const endpoint = (raw as { endpoint?: unknown })?.endpoint;
        if (typeof mailboxId !== 'string' || !boundIds.includes(mailboxId)) {
          ack?.({ ok: false, error: 'not_authenticated_for_mailbox' }); return;
        }
        try {
          if (endpoint === null) {
            await pushEndpointRepo.delete(mailboxId);
            ack?.({ ok: true }); return;
          }
          if (typeof endpoint !== 'string' || !isSafeUpEndpoint(endpoint)) {
            ack?.({ ok: false, error: 'invalid_endpoint' }); return;
          }
          await pushEndpointRepo.set(mailboxId, endpoint, Date.now());
          ack?.({ ok: true });
        } catch {
          ack?.({ ok: false, error: 'internal' });
        }
      });

      // Slice 2b.4: register/clear an Expo/APNs wake token for one of THIS
      // socket's authenticated mailbox ids (iOS app-killed path — no
      // UnifiedPush on iOS). Same possession rule as mailbox:push:endpoint.
      // The wake only ever fires when PUSH_MAILBOX_TOKEN_WAKE is on
      // server-side; storing the binding is harmless without the flag.
      socket.on('mailbox:push:token', async (
        raw: unknown,
        ack?: (r: { ok: boolean; error?: string }) => void,
      ) => {
        if (!limiter.consume()) { ack?.({ ok: false, error: 'rate_limited' }); return; }
        const mailboxId = (raw as { mailboxId?: unknown })?.mailboxId;
        const expoToken = (raw as { expoToken?: unknown })?.expoToken;
        if (typeof mailboxId !== 'string' || !boundIds.includes(mailboxId)) {
          ack?.({ ok: false, error: 'not_authenticated_for_mailbox' }); return;
        }
        try {
          if (expoToken === null) {
            // Deletion is ALWAYS allowed, flag or no flag — a client must be
            // able to retract its binding even after the operator disables
            // the feature.
            await pushMailboxTokenRepo.delete(mailboxId);
            ack?.({ ok: true }); return;
          }
          // Fail-closed at PERSISTENCE, not just delivery: a relay with the
          // flag off never collects stable tokens (nothing to leak, nothing
          // to activate later if the flag flips on).
          if (!isTokenWakeEnabled()) {
            ack?.({ ok: false, error: 'feature_disabled' }); return;
          }
          if (typeof expoToken !== 'string' || !isExpoWakeToken(expoToken)) {
            ack?.({ ok: false, error: 'invalid_token' }); return;
          }
          await pushMailboxTokenRepo.set(mailboxId, expoToken, Date.now());
          ack?.({ ok: true });
        } catch {
          ack?.({ ok: false, error: 'internal' });
        }
      });

      socket.on('disconnect', () => {
        limiter.destroy();
        for (const id of boundIds) {
          const cur = mailboxSockets.get(id);
          if (cur) { cur.delete(socket); if (cur.size === 0) mailboxSockets.delete(id); }
        }
      });

      // AT-LEAST-ONCE ack (audit 2026-07-24): the client emits 'envelope:ack' after
      // it has PERSISTED an incoming mailbox envelope. Only then do we hard-delete
      // the queued row (a mailbox is a single logical inbox → no deviceId). This is
      // the transport-safe (works over Tor) counterpart of the drain below, which no
      // longer deletes on emit. Delete-if-present: a no-op for live messages that
      // were never queued. Un-acked rows survive and re-drain on the next connect.
      socket.on('envelope:ack', (raw: unknown) => {
        const id = typeof (raw as { id?: unknown } | null)?.id === 'string'
          ? (raw as { id: string }).id
          : null;
        if (id) void messageRepo.delete(id);
      });

      // Drain every bound id (current epoch + catch-up epochs), THEN signal ready —
      // mirrors the aegisId drain order (drain → auth:ok). We emit WITHOUT deleting:
      // over Tor an emit can be lost mid-drain, and deleting here loses the message
      // forever (this was the root cause of "some messages never arrive"). Deletion
      // now happens only on the client's 'envelope:ack' above; the client dedups by
      // id (INSERT OR REPLACE) so a re-drain of an un-acked row is harmless.
      void (async () => {
        for (const id of boundIds) {
          const pending = await messageRepo.drainFor(id);
          for (const row of pending) {
            socket.emit('envelope:mb', {
              id: row.id, to: id,
              ciphertext: row.ciphertext_b64, nonce: row.nonce_b64,
              epk: row.epk_b64 ?? '', createdAt: row.created_at,
            });
          }
        }
        socket.emit('auth:ok', {});
      })();
    });

    socket.on('disconnect', () => clearTimeout(authTimer));
  }

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

    // AT-LEAST-ONCE ack (audit 2026-07-24): the client emits 'envelope:ack' after
    // it has PERSISTED an incoming envelope (live or drained). Mark this device as
    // having drained the row (delete(id, deviceId) hard-deletes once all the
    // recipient's devices have acked, matching the queue's per-device model). We do
    // this ONLY here — never on emit — so a lost delivery re-drains instead of being
    // lost. Delete-if-present: a no-op for a live message that was never queued.
    socket.on('envelope:ack', (raw: unknown) => {
      const id = typeof (raw as { id?: unknown } | null)?.id === 'string'
        ? (raw as { id: string }).id
        : null;
      if (id) void messageRepo.delete(id, deviceId);
    });

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
      // AT-LEAST-ONCE (audit 2026-07-24): do NOT mark drained on emit. Deletion
      // (per-device via delete(id, deviceId)) happens only on the client's
      // 'envelope:ack' (handler registered below), so a lost emit does not lose
      // the message — it re-drains on the next connect. Client dedups by id.
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
      // once the recipient's full set of devices has drained it, matching messageRepo.
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
      // v2-only (Fase C): the relay never re-delivers legacy v1 call events.
      socket.emit('call:invite:v2', takenInvite.payload);
      for (const candidate of takenInvite.ice) {
        socket.emit('call:ice:v2', candidate);
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
          // Run the constant-time verify even when no token is registered (against
          // a fixed dummy) so the response time does not reveal whether `to` is a
          // v2 recipient. The `!storedHash` check still decides the outcome.
          const tokenOk = verifyDeliveryToken(
            data.deliveryToken,
            storedHash ?? DUMMY_DELIVERY_TOKEN_HASH
          );
          if (!storedHash || !tokenOk) {
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

          const liveRecipients = recipientSockets ? liveSockets(recipientSockets) : [];
          if (liveRecipients.length > 0) {
            for (const s of liveRecipients) s.emit('envelope:v2', env);
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
    attachPrekeys(socket, { me, deviceId });

    // ─── Typing / read receipts / remote delete / push registration ─────────
    attachMessagingEphemeral(socket, { me, sockets });

    // ─── Device linking (approve / list / revoke) ────────────────────────────
    attachDevices(socket, { me, sockets, linkingSockets, socketMeta });

    // ─── Work channels / SenderKey / group re-key ────────────────────────────
    attachChannels(socket, { me, deviceId, sockets, io, orgPresence, socketOrgMembership });

    // ─── Public channels (sealed, blind-forwarded — no `from`) ───────────────
    attachPublicChannelEvents(socket, io);

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
