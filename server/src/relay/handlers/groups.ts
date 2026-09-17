import type { Socket } from 'socket.io';
import { randomUUID } from 'node:crypto';
import { GroupRekeyEvent, RekeyDrainAck } from '../schemas.js';
import { checkRekeyRateLimit } from '../rateLimits.js';
import { liveSockets } from '../liveSockets.js';
import { senderKeyDistRepo } from '../../db/client.js';

// Group SenderKey re-key handlers for NORMAL groups (section 6). They used to
// live in handlers/channels.ts next to the AegisLink Work (enterprise org
// channels) handlers; Work was extracted from this repo (ROADMAP Hito 1,
// external audit 2026-09-16 AL-02/07/09) and these handlers moved here
// unchanged — same events, same schemas, same rate limits, same tests
// (group-rekey-offline.test.ts, drain-storm.test.ts, ackScoping.relay.test.ts).

export interface GroupsDeps {
  me: string;
  deviceId: string | undefined;
  sockets: Map<string, Set<Socket>>;
}

export function attachGroups(socket: Socket, deps: GroupsDeps): void {
  const { me, deviceId, sockets } = deps;

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

      // AT-LEAST-ONCE: enqueue FIRST, always, then attempt live delivery — the
      // same order the message paths use (handler.ts, audit 2026-08-08).
      //
      // This branch used to gate on `recipientSockets.size > 0`, which is the
      // ORIGINAL zombie-socket bug liveSockets was written to kill — this call
      // site was simply never migrated (see zombieSocket.relay.test.ts). And a
      // live-looking socket is no better: iOS tears an app down without closing
      // the TCP connection, so the entry reports `connected === true` for up to
      // ~35s afterwards. Either way the sealed SenderKey was emitted into a dead
      // transport and never stored.
      //
      // A lost message is bad; a lost SenderKey distribution is worse. Without
      // it the recipient cannot open ANY message for that group, so the group
      // never appears for them at all — and since nothing was queued there is no
      // recovery path: not reconnecting, not sending messages, not calling. That
      // is the "I create a group and it never shows up for the other contact"
      // report (2026-08-08). Queue it and the next drain fixes it by itself.
      //
      // The relay stores the blob opaquely; the distributor's identity is INSIDE
      // ciphertext_b64, so sender_aegis_id is stored empty (the column is
      // retained for schema compatibility / older rows only).
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

      // Same distId on the wire as in the queue, so the recipient's
      // 'group:rekey_drain_ack' frees the row it just persisted and a live
      // delivery still costs nothing.
      const recipientSockets = sockets.get(d.aegisId);
      for (const s of recipientSockets ? liveSockets(recipientSockets) : []) {
        s.emit('group:rekey_dist', {
          distId,
          groupId,
          ciphertextB64: d.ciphertextB64,
          nonceB64: d.nonceB64,
          iteration: d.iteration,
        });
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
    // Scoped to `me` (AL-06): only a distribution queued FOR this identity is touched.
    void senderKeyDistRepo.ack(parsed.data.distId, [me], deviceId);
  });
}
