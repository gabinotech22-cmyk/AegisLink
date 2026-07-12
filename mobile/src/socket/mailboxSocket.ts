/**
 * AegisLink — Dedicated mailbox delivery socket (sealed-sender Fase 4 Slice 4, mobile)
 *
 * Hides the recipient (`to`) from the relay. This is a SEPARATE Socket.IO
 * connection from the aegisId control-plane socket (client.ts): it authenticates
 * by proving possession of the current epoch's mailbox signing key — the relay
 * never learns the aegisId on this socket — and carries ONLY message delivery
 * (`envelope:mb`, send + receive). Prekeys/push/token/profile stay on the
 * aegisId socket (Option A, see docs/FASE4-CONTROL-PLANE-DESIGN.md).
 *
 * Privacy gate (fail-closed): only ever connects when MAILBOX_ENABLED (mode on
 * AND ONION_URL configured) AND the embedded Tor native module is present
 * (Tier 2 — no Orbot; see docs/FASE4-TOR-EMBEDDED-IMPL.md). Every byte of this
 * socket rides Tor via `TorSioSocket` (../net/tor.ts) so the relay can't relink
 * the opaque mailbox to our IP next to the aegisId control socket. If Tor is
 * unavailable or fails to bootstrap, the caller never enables mailbox mode and
 * delivery falls back to the aegisId transport. Default OFF.
 *
 * Wire protocol (mirrors server/src/relay/handler.ts handleMailboxConnection):
 *   handshake.auth: { mailboxId, mailboxSignPubKey }
 *   server → 'mailbox:challenge' { nonce }        (32 random bytes, base64)
 *   client → 'mailbox:auth:response' { sig }      (Ed25519 over the nonce)
 *   server → 'auth:ok'                            (after draining the offline queue)
 *   server → 'envelope:mb' { id, to, ciphertext, nonce, epk, createdAt }  (incoming)
 *   client → 'envelope:mb' { id, to, ciphertext, nonce, epk }  ack {ok,delivered?,queued?}
 *
 * Epoch rotation: the mailbox is derived for the CURRENT epoch at connect time.
 * Live re-derivation on an epoch boundary (reconnect with the next epoch's key,
 * brief dual-bind overlap) is Slice 5 — noted, not handled here.
 */

import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { AppState, type AppStateStatus } from 'react-native';
import { logger } from '../utils/logger';
import { ONION_URL, MAILBOX_ENABLED } from '../config';
import {
  getOwnCurrentMailbox,
  getOwnMailboxesForEpochs,
  getLastMailboxConnectEpoch,
  setLastMailboxConnectEpoch,
} from '../crypto/mailboxStore';
import { mailboxAuthProof, epochFor, MAILBOX_EPOCH_MS, type Mailbox } from '../crypto/mailbox';
import { TorSioSocket, isTorAvailable, startTor, onTorStatus, type TorStatus } from '../net/tor';

/**
 * The mailbox socket only ever rides embedded Tor (Tier 2 — no Orbot, no plain
 * `io()` fallback): a mailbox connection that left over the clear network would
 * defeat the entire point of this transport (relay relinks `to` next to our IP).
 * `Socket` here is the structural subset `TorSioSocket` and `socket.io-client`'s
 * `Socket` both satisfy — see `tor.ts` for why it's a drop-in shape.
 */
type Socket = TorSioSocket;

/**
 * Catch-up cap: how many past epochs we re-bind on a single connect. extras must
 * stay ≤ the relay's MAX_MAILBOX_BINDS (32, incl. headroom). With a 1-day epoch
 * and a 30-day queue, 31 covers the full retention window; longer offline gaps
 * lose only messages already expired from the relay queue.
 */
const MAX_CATCHUP_EPOCHS = 31;

/** Incoming envelope as forwarded by the relay (createdAt stamped relay-side). */
export interface IncomingMailboxEnvelope {
  id: string;
  to: string;
  ciphertext: string;
  nonce: string;
  epk: string;
  createdAt: number;
}

/** Outgoing sealed v2 wire fields, addressed to a recipient mailbox id. */
export interface OutgoingMailboxEnvelope {
  id: string;
  to: string;            // recipient's current-epoch mailbox id (base64)
  ciphertext: string;
  nonce: string;
  epk: string;
  /** Slice 5: ephemeral TTL (ms) — server uses it ONLY to bound offline-queue life. */
  ephemeralTtl?: number;
}

export type EnvelopeAck = { ok: boolean; delivered?: boolean; queued?: boolean; error?: string };

/**
 * True only when the relay confirms the wire was handed to a LIVE recipient
 * mailbox socket (`delivered:true`). A merely-`queued` ack (recipient's mailbox
 * offline) is NOT confirmation: the recipient's Tor mailbox may never come up to
 * drain it, so the caller must fall back to the reliable aegisId transport rather
 * than treat the message as sent. Centralised so mobile ↔ desktop stay in lock-step
 * and a future edit can't silently revert to trusting a bare `ok` (which is true
 * for queued too) — see the send path in client.ts and mailboxDelivery.test.ts.
 */
export function mailboxAckConfirmsDelivery(ack: EnvelopeAck | null | undefined): boolean {
  return ack?.delivered === true;
}

let mboxSocket: Socket | null = null;
let currentEpochMailbox: Mailbox | null = null;
let extraEpochMailboxes: Mailbox[] = []; // catch-up epochs bound alongside the current one
let authed = false;
let onEnvelopeCb: ((env: IncomingMailboxEnvelope) => void) | null = null;
let boundaryTimer: ReturnType<typeof setTimeout> | null = null;

// ── Resilient bootstrap + reconnection ───────────────────────────────────────
// TorSioSocket has NO built-in reconnection (unlike socket.io-client on desktop)
// and Tor bootstrap on mobile routinely misses the 45s window on a cold start.
// Without this, one failed startTor() at app launch meant the mailbox NEVER came
// up for the whole session — the recipient never drained, and (pre-#304) senders'
// mailbox-queued messages silently expired. We retry with exponential backoff +
// jitter for as long as the caller wants the mailbox up (`wantMailbox`), and
// re-arm on socket disconnect and on auth stalls. Deliberate teardown
// (disconnectMailboxSocket) cancels everything.
const RECONNECT_BASE_MS = 15_000; // first retry — Tor keeps bootstrapping natively meanwhile
const RECONNECT_MAX_MS = 5 * 60_000; // cap; also the steady-state "is Tor up yet?" poll
/** No auth:ok within this window after a connect attempt → tear down and retry. */
const AUTH_STALL_MS = 60_000;
let wantMailbox = false; // true from connectMailboxSocket() until deliberate disconnect
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let authStallTimer: ReturnType<typeof setTimeout> | null = null;
let connecting = false; // collapse concurrent connect attempts

// Extra wake-up triggers so a stuck backoff wait doesn't outlive the moment the
// mailbox is actually likely to succeed: Tor finishing bootstrap, or the app
// coming back to the foreground (network path often changes on resume/BG-kill
// recovery). Both are best-effort nudges — the backoff loop above is still the
// source of truth and self-heals even if these never fire.
let torStatusUnsub: (() => void) | null = null;
let appStateSub: { remove: () => void } | null = null;

/** Wake-up nudge shared by the Tor-status and AppState triggers. Idempotent/safe. */
function nudgeReconnect(): void {
  if (!wantMailbox || authed || connecting) return;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  void retryConnect();
}

/** Subscribe the wake-up triggers once per `wantMailbox` session. Idempotent. */
function armWakeTriggers(): void {
  if (!torStatusUnsub && isTorAvailable()) {
    torStatusUnsub = onTorStatus((status: TorStatus) => {
      if (status.state === 'on') nudgeReconnect();
    });
  }
  if (!appStateSub) {
    appStateSub = AppState.addEventListener('change', (state: AppStateStatus) => {
      if (state === 'active') nudgeReconnect();
    });
  }
}

/** Tear down the wake-up trigger subscriptions (mirrors clearReconnectTimers). */
function disarmWakeTriggers(): void {
  if (torStatusUnsub) { torStatusUnsub(); torStatusUnsub = null; }
  if (appStateSub) { appStateSub.remove(); appStateSub = null; }
}

function clearReconnectTimers(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (authStallTimer) { clearTimeout(authStallTimer); authStallTimer = null; }
}

/** Schedule the next connect attempt (backoff + ±20% jitter). Idempotent. */
function scheduleReconnect(): void {
  if (!wantMailbox || reconnectTimer) return;
  const base = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  const jitter = base * 0.2 * (Math.random() * 2 - 1);
  const delay = Math.max(1_000, Math.round(base + jitter));
  reconnectAttempt++;
  if (__DEV__) logger.debug(`[mailbox] retry #${reconnectAttempt} in ${Math.round(delay / 1000)}s`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void retryConnect();
  }, delay);
}

/** Tear down any half-open socket and re-run the full connect path. */
async function retryConnect(): Promise<void> {
  const cb = onEnvelopeCb;
  if (!wantMailbox || !cb) return;
  if (isMailboxAuthed()) return; // recovered by other means (e.g. epoch rotation)
  if (mboxSocket) {
    try { mboxSocket.removeAllListeners(); mboxSocket.disconnect(); } catch { /* noop */ }
    mboxSocket = null;
  }
  authed = false;
  await connectMailboxSocket(cb);
}

/** Arm the auth-stall watchdog: connect attempts that never reach auth:ok retry. */
function armAuthStallWatchdog(): void {
  if (authStallTimer) clearTimeout(authStallTimer);
  authStallTimer = setTimeout(() => {
    authStallTimer = null;
    if (!wantMailbox || isMailboxAuthed()) return;
    if (__DEV__) logger.warn('[mailbox] auth stalled, recycling socket');
    scheduleReconnect();
  }, AUTH_STALL_MS);
}

/** True once the mailbox socket is connected and possession-proof authenticated. */
export function isMailboxAuthed(): boolean {
  return authed && mboxSocket?.connected === true;
}

/**
 * Open the dedicated mailbox delivery socket and authenticate by possession proof.
 * No-op (returns null) unless MAILBOX_ENABLED. Incoming envelopes are handed to
 * `onEnvelope`; the caller decrypts (sealed v2) and routes into the normal
 * incoming pipeline. Idempotent: a live socket is reused.
 */
export async function connectMailboxSocket(
  onEnvelope: (env: IncomingMailboxEnvelope) => void,
): Promise<Socket | null> {
  if (!MAILBOX_ENABLED || !ONION_URL) return null; // fail-closed: needs Tor
  if (mboxSocket && mboxSocket.connected) return mboxSocket;
  if (!isTorAvailable()) return null; // fail-closed: no embedded Tor module (Expo Go / non-prebuilt)
  // From here on the caller WANTS the mailbox up: remember the callback and keep
  // retrying (backoff) until deliberate disconnect — a cold-start Tor bootstrap
  // miss must not silence the mailbox for the whole session.
  onEnvelopeCb = onEnvelope;
  wantMailbox = true;
  armWakeTriggers(); // idempotent: no-op if already subscribed for this session
  if (connecting) return null; // an attempt is already in flight; retries collapse
  connecting = true;
  try {
    await startTor(); // resolves only once bootstrapped (STATUS_ON); throws on failure
  } catch (e) {
    if (__DEV__) logger.warn('[mailbox] Tor start failed, will retry:', (e as Error).message);
    connecting = false;
    scheduleReconnect(); // Tor keeps bootstrapping natively; next attempt may resolve instantly
    return null;
  }

  // Derive the mailbox valid right now (id + auth keypair) from our own root, plus
  // a catch-up window of recent epochs we may have been offline across (Slice 5b).
  // Always include the just-passed epoch (E-1) for sender clock skew at a boundary.
  let mb: Mailbox;
  let E: number;
  try {
    const now = Date.now();
    E = epochFor(now);
    const last = await getLastMailboxConnectEpoch();
    let start = last !== null ? Math.min(last, E - 1) : E - 1;
    start = Math.max(start, E - MAX_CATCHUP_EPOCHS, 0);
    const extraEpochs: number[] = [];
    for (let e = start; e <= E - 1; e++) extraEpochs.push(e);

    mb = await getOwnCurrentMailbox(now);
    currentEpochMailbox = mb;
    extraEpochMailboxes = extraEpochs.length ? await getOwnMailboxesForEpochs(extraEpochs) : [];
  } catch (e) {
    // Derivation/store hiccup (e.g. SecureStore not ready) — retry, don't die.
    if (__DEV__) logger.warn('[mailbox] mailbox derivation failed, will retry:', (e as Error).message);
    connecting = false;
    scheduleReconnect();
    return null;
  }
  // Deliberate teardown (logout/panic) may have raced the awaits above — do NOT
  // open a fresh socket the teardown can no longer see.
  if (!wantMailbox) { connecting = false; return null; }
  authed = false;

  const sock = new TorSioSocket(ONION_URL, {
    mailboxId: mb.mailboxIdB64,
    mailboxSignPubKey: encodeBase64(mb.signPublicKey),
    // Slice 5b: extra epoch mailboxes to bind + drain in this same handshake.
    ...(extraEpochMailboxes.length
      ? { binds: extraEpochMailboxes.map((m) => ({ mailboxId: m.mailboxIdB64, mailboxSignPubKey: encodeBase64(m.signPublicKey) })) }
      : {}),
  });
  mboxSocket = sock;
  connecting = false;
  // If this attempt never reaches auth:ok (dead circuit, relay down, silent
  // native failure), the watchdog recycles the socket and schedules a retry.
  armAuthStallWatchdog();

  sock.on('connect', () => {
    authed = false;
    if (__DEV__) logger.debug('[mailbox] connected, awaiting challenge');
  });

  sock.on('disconnect', (reason) => {
    authed = false;
    if (__DEV__) logger.debug('[mailbox] disconnected:', reason);
    // TorSioSocket has no native auto-reconnect: re-arm the retry loop so a
    // dropped circuit / relay restart doesn't leave the mailbox down for good.
    scheduleReconnect();
  });

  // Possession proof: sign the relay's random challenge with the mailbox secret.
  // The relay verifies against the signing pubkey it recomputed the id from, so
  // it learns nothing but the rotating mailbox id.
  sock.on('mailbox:challenge', (chal: { nonce?: unknown }) => {
    try {
      if (typeof chal?.nonce !== 'string') throw new Error('bad challenge');
      const nonce = decodeBase64(chal.nonce);
      // Prove the current epoch + every catch-up epoch by signing the SAME nonce
      // with each key. Binding an epoch id whose root we don't hold is impossible.
      const resp: { sig: string; extraSigs?: Array<{ mailboxId: string; sig: string }> } = {
        sig: encodeBase64(mailboxAuthProof(mb.signSecretKey, nonce)),
      };
      if (extraEpochMailboxes.length) {
        resp.extraSigs = extraEpochMailboxes.map((m) => ({
          mailboxId: m.mailboxIdB64,
          sig: encodeBase64(mailboxAuthProof(m.signSecretKey, nonce)),
        }));
      }
      sock.emit('mailbox:auth:response', resp);
    } catch (e) {
      if (__DEV__) logger.warn('[mailbox] auth failure:', (e as Error).message);
      sock.disconnect();
    }
  });

  sock.on('auth:ok', () => {
    authed = true;
    // Healthy again: reset the backoff and stand down the stall watchdog.
    reconnectAttempt = 0;
    if (authStallTimer) { clearTimeout(authStallTimer); authStallTimer = null; }
    void setLastMailboxConnectEpoch(E);
    scheduleEpochRotation();
    if (__DEV__) logger.debug('[mailbox] authenticated');
  });

  sock.on('error_msg', (e: { code?: string }) => {
    if (__DEV__) logger.warn('[mailbox] server error:', e?.code);
  });

  sock.on('envelope:mb', (raw: unknown) => {
    const env = raw as IncomingMailboxEnvelope;
    if (!env || typeof env.id !== 'string' || typeof env.ciphertext !== 'string') return;
    try {
      onEnvelope(env);
    } catch (e) {
      if (__DEV__) logger.warn('[mailbox] onEnvelope handler threw:', e);
    }
  });

  return sock;
}

/**
 * Send a sealed v2 wire addressed to a recipient mailbox id over the mailbox
 * socket. Returns the relay ack ({delivered|queued}), or null if the socket is
 * not authenticated yet (caller falls back to the aegisId transport).
 */
export async function sendViaMailbox(env: OutgoingMailboxEnvelope): Promise<EnvelopeAck | null> {
  if (!isMailboxAuthed() || !mboxSocket) return null;
  return new Promise<EnvelopeAck | null>((resolve) => {
    let settled = false;
    const t = setTimeout(() => { if (!settled) { settled = true; resolve(null); } }, 15000);
    mboxSocket!.emit('envelope:mb', env, (ack: EnvelopeAck) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(ack ?? null);
    });
  });
}

/**
 * Live epoch rotation (Slice 5b): schedule a reconnect just after the next epoch
 * boundary. Reconnecting re-derives the now-current epoch and re-runs the catch-up
 * binds (which re-bind the just-passed epoch for skew grace), over a FRESH Tor
 * circuit — so a long-running session never stays stuck on a stale epoch, and the
 * relay can't link consecutive epochs to one circuit. Idempotent.
 */
function scheduleEpochRotation(): void {
  if (boundaryTimer) { clearTimeout(boundaryTimer); boundaryTimer = null; }
  const now = Date.now();
  const msToBoundary = (epochFor(now) + 1) * MAILBOX_EPOCH_MS - now;
  // +2s grace so both ends have ticked over before we re-derive the new epoch.
  const delay = Math.max(1000, msToBoundary + 2000);
  boundaryTimer = setTimeout(() => { void rotateForNewEpoch(); }, delay);
}

/** Tear down the current socket and reconnect for the new epoch (keeps the callback). */
async function rotateForNewEpoch(): Promise<void> {
  const cb = onEnvelopeCb;
  boundaryTimer = null;
  if (!cb || !MAILBOX_ENABLED) return;
  authed = false;
  if (mboxSocket) {
    try { mboxSocket.removeAllListeners(); mboxSocket.disconnect(); } catch { /* noop */ }
    mboxSocket = null;
  }
  await connectMailboxSocket(cb);
}

/** Tear down the mailbox socket (e.g. on logout / profile switch / panic). */
export function disconnectMailboxSocket(): void {
  wantMailbox = false; // deliberate: stop the retry loop before touching the socket
  connecting = false;
  reconnectAttempt = 0;
  clearReconnectTimers();
  disarmWakeTriggers();
  authed = false;
  currentEpochMailbox = null;
  extraEpochMailboxes = [];
  onEnvelopeCb = null;
  if (boundaryTimer) { clearTimeout(boundaryTimer); boundaryTimer = null; }
  if (mboxSocket) {
    try { mboxSocket.removeAllListeners(); mboxSocket.disconnect(); } catch { /* noop */ }
    mboxSocket = null;
  }
}

/** Our current-epoch mailbox id (base64), or null if the socket isn't up. Test/debug aid. */
export function ownCurrentMailboxId(): string | null {
  return currentEpochMailbox?.mailboxIdB64 ?? null;
}
