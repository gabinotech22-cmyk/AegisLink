/**
 * mailbox.ts — Stateless mailbox drain over Tor (sealed-sender Fase 4, Slice 6).
 *
 * WHY THIS EXISTS
 * ---------------
 * Async mailbox delivery currently rides a dedicated, persistent Socket.IO
 * connection over Tor (mailboxSocket.ts ↔ relay/handler.ts handleMailboxConnection).
 * On mobile that socket is fragile: iOS suspends a backgrounded app and kills its
 * TCP sockets after ~30s (Apple platform rule — no app can keep it up), and a cold
 * Tor bootstrap routinely loses the race against being backgrounded, so the socket
 * "never comes up" and the queue never drains. Every reliable over-Tor messenger
 * (Session's swarm fetch, SimpleX's SMP fetch) reaches the same conclusion:
 * DECOUPLE delivery from a live socket — buffer server-side and let the client
 * fetch with a short, stateless request whenever it can build a circuit.
 *
 * This endpoint is that stateless drain. A push wake (or foreground) opens a brief
 * Tor circuit, the client authenticates by possession proof, drains everything
 * queued in one request, then lets the app suspend. The persistent socket becomes
 * an optimization, not the delivery path.
 *
 * PRIVACY (identical guarantees to the socket path — golden rules)
 * ----------------------------------------------------------------
 *  - Zero-metadata: the relay only ever sees an OPAQUE rotating mailbox id and the
 *    SEALED envelopes it stored; never an aegisId, never a `from`. Runs over Tor so
 *    the exit ip carries no user identity. (rule #1, #2, #4)
 *  - Cryptographic auth (rule #3): possession of the mailbox signing key is proven
 *    by an Ed25519 signature over a random server challenge — the SAME scheme as
 *    the socket handshake (crypto/mailbox.ts). Knowing a mailbox id is not enough.
 *    Challenge-response (server nonce), not a client timestamp, so it is immune to
 *    the mobile clock-skew that breaks Tor after suspend/resume.
 *  - Constant-time nonce comparison (rule #8) and hijack-proof id↔key binding
 *    (mailboxId === SHA256(signPubKey)[0:16]).
 *  - At-least-once (rule: no silent loss): fetch NEVER deletes on read. The client
 *    acks ids it has persisted on the NEXT fetch (ackIds), and deletion is scoped
 *    to the caller's own queue so it can never drop another mailbox's messages.
 *    Un-acked rows survive and re-drain; the client dedups by id.
 *
 * Wire:
 *   POST /mailbox/challenge { mailboxId, mailboxSignPubKey }        → { nonce }
 *   POST /mailbox/fetch     { mailboxId, mailboxSignPubKey, nonce, sig, ackIds? }
 *                                                                   → { envelopes: [...] }
 */

import { Router } from 'express';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import rateLimit from 'express-rate-limit';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';
import { messageRepo } from '../db/client.js';
import { mailboxIdForSignPublicKey, verifyMailboxAuth } from '../crypto/mailbox.js';

const { encodeBase64, decodeBase64 } = naclUtil;

const router = Router();

// ── Constants ─────────────────────────────────────────────────────────────────

/** Challenge validity. Mirrors backup.ts (35s) — a Tor round-trip has slack. */
const CHALLENGE_TTL_MS = 35_000;
/** Bound work per fetch: cap how many ids a client may ack in one request. */
const MAX_ACK_IDS = 500;
/** Backstop on the in-memory challenge map so it can never grow unbounded. */
const MAX_PENDING_CHALLENGES = 100_000;
/** Rate limit, keyed by mailbox id (NOT ip — over Tor the ip is a shared exit;
 *  keying on it would be meaningless and cross-user). */
const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 60;

// ── Validation ────────────────────────────────────────────────────────────────
// mailboxId = base64(16 bytes) ≈ 24 chars; a 32-byte key ≈ 44; a 64-byte sig ≈ 88.
const b64 = (max: number) => z.string().min(1).max(max);
const ChallengeBody = z.object({
  mailboxId: b64(64),
  mailboxSignPubKey: b64(64),
});
const FetchBody = z.object({
  mailboxId: b64(64),
  mailboxSignPubKey: b64(64),
  nonce: b64(64),
  sig: b64(128),
  ackIds: z.array(z.string().min(1).max(80)).max(MAX_ACK_IDS).optional(),
});

// ── In-memory challenge store (never hits SQLite), keyed by mailbox id ─────────
interface PendingChallenge {
  nonce: Uint8Array;
  expiresAt: number;
}
const pendingChallenges = new Map<string, PendingChallenge>();

function pruneExpiredChallenges(): void {
  const now = Date.now();
  for (const [id, entry] of pendingChallenges) {
    if (entry.expiresAt <= now) pendingChallenges.delete(id);
  }
}

// ── Per-mailbox rate limiter (express-rate-limit middleware) ──────────────────
// A recognized limiter middleware on each route. Keyed by the OPAQUE mailbox id
// from the (already-parsed, global express.json) body — never the ip, which over
// Tor is a shared exit that would collapse every user into one cross-talking
// bucket. Each route gets its own instance, so /challenge and /fetch keep
// independent per-mailbox windows.
function mailboxLimiter() {
  return rateLimit({
    windowMs: RATE_WINDOW_MS,
    max: RATE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req): string => {
      const id = (req.body as { mailboxId?: unknown } | undefined)?.mailboxId;
      return typeof id === 'string' && id.length > 0 ? id : 'anon';
    },
    handler: (_req, res) => {
      res.status(429).json({ error: 'rate_limited' });
    },
  });
}
const challengeLimiter = mailboxLimiter();
const fetchLimiter = mailboxLimiter();

/**
 * Validate that `mailboxId` is genuinely derived from `signPubKeyB64` (the
 * hijack-proof binding). Returns the decoded 32-byte key on success, else null.
 */
function validBinding(mailboxId: string, signPubKeyB64: string): Uint8Array | null {
  let pk: Uint8Array;
  try {
    pk = decodeBase64(signPubKeyB64);
  } catch {
    return null;
  }
  if (pk.length !== nacl.sign.publicKeyLength) return null;
  if (mailboxIdForSignPublicKey(pk) !== mailboxId) return null;
  return pk;
}

// ── POST /mailbox/challenge ───────────────────────────────────────────────────
// Issue a random 32-byte nonce for a proven-derivable mailbox id. The nonce is
// held in memory (TTL) and consumed one-time by /mailbox/fetch.
router.post('/challenge', challengeLimiter, (req, res) => {
  const parsed = ChallengeBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_request' });
  const { mailboxId, mailboxSignPubKey } = parsed.data;

  if (!validBinding(mailboxId, mailboxSignPubKey)) {
    return res.status(400).json({ error: 'bad_binding' });
  }

  pruneExpiredChallenges();
  // Backstop: if the map is somehow saturated with live entries, refuse rather
  // than grow without bound (a correct client only ever holds one).
  if (pendingChallenges.size >= MAX_PENDING_CHALLENGES && !pendingChallenges.has(mailboxId)) {
    return res.status(503).json({ error: 'busy' });
  }

  const nonce = nacl.randomBytes(32);
  pendingChallenges.set(mailboxId, { nonce, expiresAt: Date.now() + CHALLENGE_TTL_MS });
  return res.json({ nonce: encodeBase64(nonce) });
});

// ── POST /mailbox/fetch ───────────────────────────────────────────────────────
// Prove possession (Ed25519 over the issued nonce), then drain the queue in one
// shot. Deletes only the caller's own acked ids; never deletes on read.
router.post('/fetch', fetchLimiter, async (req, res) => {
  const parsed = FetchBody.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'bad_request' });
  const { mailboxId, mailboxSignPubKey, nonce, sig, ackIds } = parsed.data;

  const pk = validBinding(mailboxId, mailboxSignPubKey);
  if (!pk) return res.status(400).json({ error: 'bad_binding' });

  const entry = pendingChallenges.get(mailboxId);
  if (!entry || entry.expiresAt <= Date.now()) {
    pendingChallenges.delete(mailboxId);
    return res.status(401).json({ error: 'challenge_expired' });
  }

  let nonceBytes: Uint8Array;
  let sigBytes: Uint8Array;
  try {
    nonceBytes = decodeBase64(nonce);
    sigBytes = decodeBase64(sig);
  } catch {
    return res.status(400).json({ error: 'bad_encoding' });
  }

  // The client must echo the exact nonce we issued (constant-time compare), and
  // the signature must verify over it. Both must hold — the sig alone is checked
  // against the SERVER-held nonce, so a mismatched echo can never smuggle a
  // different challenge through.
  const nonceOk =
    nonceBytes.length === entry.nonce.length &&
    timingSafeEqual(Buffer.from(nonceBytes), Buffer.from(entry.nonce));
  if (!nonceOk || !verifyMailboxAuth(pk, entry.nonce, sigBytes)) {
    return res.status(401).json({ error: 'auth_failed' });
  }

  // One-time consume: a nonce is never replayable.
  pendingChallenges.delete(mailboxId);

  // Drain WITHOUT deleting (at-least-once). Scope acks to THIS mailbox's queue so
  // a caller can never delete another mailbox's messages by guessing ids.
  const rows = await messageRepo.drainFor(mailboxId);
  const queueIds = new Set(rows.map((r) => r.id));
  const ackSet = new Set<string>();
  if (ackIds && ackIds.length) {
    for (const id of ackIds) {
      if (queueIds.has(id)) {
        ackSet.add(id);
        await messageRepo.delete(id);
      }
    }
  }

  const envelopes = rows
    .filter((r) => !ackSet.has(r.id))
    .map((r) => ({
      id: r.id,
      to: mailboxId,
      ciphertext: r.ciphertext_b64,
      nonce: r.nonce_b64,
      epk: r.epk_b64 ?? '',
      createdAt: r.created_at,
    }));

  return res.json({ envelopes });
});

export default router;
