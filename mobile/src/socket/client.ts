import { io, type Socket } from 'socket.io-client';
import { logger } from '../utils/logger';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { SERVER_URL, ONION_URL, SEALED_TRANSPORT_VERSION, MAILBOX_ENABLED } from '../config';
import { usePreferences } from '../store/preferences';
import { encryptMessage, openEnvelope, encryptMessageV2, openEnvelopeV2, parseRatchetHeader } from '../crypto/messaging';
import { getOwnDeliveryToken, hashDeliveryToken, setContactDeliveryToken, getContactDeliveryToken } from '../crypto/deliveryToken';
import { getOwnMailboxRootB64, setContactMailboxRoot, getContactCurrentMailboxId } from '../crypto/mailboxStore';
import { connectMailboxSocket, disconnectMailboxSocket, sendViaMailbox, isMailboxAuthed, mailboxAckConfirmsDelivery } from './mailboxSocket';
import { startMailboxPushSubscription, stopMailboxPushSubscription } from '../notifications/mailboxPushSubscription';
import { startCallWakeService, stopCallWakeService } from '../webrtc/callWakeService';
import type { SealedWire } from '../crypto/sealedSender';
import type { Identity } from '../crypto/identity';
import { deriveAegisId } from '../crypto/identity';
import { useContacts } from '../store/contacts';
import { useConnection } from '../store/connection';
import { useMessages } from '../store/messages';
import { useSecurityDiagnostics } from '../store/securityDiagnostics';
import { performX3DH, performX3DHReceiver, generatePreKeys, shouldUsePqReceiver, type PreKeyBundle, type PqSignedPreKeyPublic } from '../crypto/signal/x3dh';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { initRatchet, ratchetDecrypt, ratchetEncrypt, trimOldSkippedKeys, MAX_SKIPPED_KEYS, type RatchetState } from '../crypto/signal/ratchet';
import { themedAlert } from '../components/AlertHost';
import {
  loadRatchetSession,
  saveRatchetSession,
  deleteContactRatchetSession,
  enqueueOutboxJob,
  loadOutboxJobs,
  deleteOutboxJob,
  incrementOutboxAttempts,
  saveSpkSecret,
  loadSpkSecret,
  loadLatestSpkSecret,
  deleteSpkSecret,
  saveOpkSecret,
  loadOpkSecret,
  deleteOpkSecret,
  setSpkKeyId,
  getSpkKeyId,
  setSpkCreatedAt,
  getSpkCreatedAt,
  savePqSpkSecret,
  loadPqSpkSecret,
  setPqSpkKeyId,
  getPqSpkKeyId,
  type OutboxJob,
} from '../db/local';
import { decideV2GroupMetadata, decideGovernanceUpdate } from './groupMetadataDecision';
import { serializeRatchetState, reviveRatchetState } from './ratchetSerde';
import { shouldSendSealedTyping } from './typingThrottle';
import {
  computeRosterHash,
  signGroupMetadata,
  verifyGroupMetadata,
  signGroupMetadataV2,
  verifyGroupMetadataV2,
  verifyGroupDissolve,
  type GroupPermissions,
} from '../crypto/groupSig';

/**
 * Ratchet/X3DH recovery diagnostics — DEV BUILDS ONLY. These trace who talks
 * to whom (aegisIds, prekey ids, root-key fingerprints): exactly the
 * communication metadata a release build must never write to the OS log
 * (logcat is readable by adb and privileged apps). Belt and suspenders with
 * babel's transform-remove-console, which also strips warn in production.
 */
function rdiag(msg: string): void {
  if (__DEV__) logger.warn(msg);
}

const getSlotPrefix = () => {
  const { getActiveDbSlot } = require('../db/local');
  const slot = getActiveDbSlot();
  return slot === 'self' ? '' : `${slot}.`;
};

const SECURE_SPK_SECRET_KEY = () => `aegis.${getSlotPrefix()}spkSecret.b64`;
const SECURE_SPK_KEYID_KEY = () => `aegis.${getSlotPrefix()}spk.keyId`;
const SECURE_OPK_IDS_KEY = () => `aegis.${getSlotPrefix()}opkIds.json`;
const opkSecretKey = (keyId: number) => `aegis.${getSlotPrefix()}opkSecret.${keyId}`;
const spkSecretKey = (keyId: number) => `aegis.${getSlotPrefix()}spkSecret.${keyId}`;

/**
 * [RDIAG] Dev-only — short, non-reversible fingerprint of a derived key (first
 * 8 hex of SHA-256). Used ONLY to compare that Alice and Bob land on the SAME
 * X3DH root key on-device. It is a one-way hash of the key, never the key
 * itself, so logging it does not leak key material. Remove with the other
 * [RDIAG] instrumentation once the fresh-session desync is confirmed fixed.
 */
function rootKeyFp(rk: Uint8Array): string {
  const { sha256 } = require('@noble/hashes/sha256') as typeof import('@noble/hashes/sha256');
  const digest = sha256(rk);
  let hex = '';
  for (let i = 0; i < 4; i++) hex += digest[i].toString(16).padStart(2, '0');
  return hex;
}

interface WireSealedEnvelope {
  id: string;
  to: string;
  from?: string;
  ciphertext: string;
  nonce: string;
  createdAt?: number;
  /**
   * Sender's X25519 public key (base64). Present on online deliveries and on
   * queued first-contact (`init`) drains, letting the recipient derive the
   * sender aegisId and decrypt a first message even when offline at send time.
   */
  senderPublicKeyB64?: string;
  /**
   * Multi-device "self-encrypted copy" marker. Set by the sender when an
   * envelope is addressed to its OWN aegisId so this user's other devices
   * can render the message as outbound. The relay sees this flag (because
   * `to === from === myAegisId` already trivially reveals self-routing),
   * but the flag is ALSO duplicated inside the encrypted inner payload so
   * a malicious relay cannot strip it without invalidating the MAC.
   */
  selfCopy?: boolean;
}

/**
 * Sealed-sender v2 wire (Phase 1). NO `from` and NO senderPublicKeyB64 — the
 * sender identity is sealed inside `ciphertext` and authenticated by the inner
 * Ed25519 signature. `epk` is the per-message ephemeral key needed to open it.
 */
interface WireSealedEnvelopeV2 {
  id: string;
  to: string;
  ciphertext: string;
  nonce: string;
  epk: string;
  createdAt?: number;
}

/** SecureStore slot for the long-term self-ratchet session (per identity). */
const SECURE_SELF_RATCHET_KEY = (myAegisId: string) =>
  `aegis.${getSlotPrefix()}self.ratchet.${myAegisId}`;

interface WireChallenge {
  ephemeralPubKey: string;
  nonce: string;
  ciphertext: string;
}

let socket: Socket | null = null;
let connected = false;
let authenticated = false;
// Registered exactly once (see armForegroundReconnect): forces a reconnect when
// the app returns to the foreground, since Android routinely kills the
// WebSocket while the app is suspended in the background.
let foregroundReconnectArmed = false;

// ── Auth watchdog ────────────────────────────────────────────────────────────
// The server disconnects unauthenticated sockets after AUTH_TIMEOUT_MS=5s
// (server/src/relay/schemas.ts). If the relay restarts mid-handshake or the
// challenge/response frame is dropped, `connect` can fire with no subsequent
// `auth:ok` and no `disconnect` either — the socket looks "connected" forever
// while never becoming usable. 7000ms (> server's 5s) gives the server timeout
// a chance to fire first (clean path); this watchdog is the fallback for cases
// where the transport itself is wedged and the server-side timer never runs.
const AUTH_WATCHDOG_MS = 7000;
let authWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

// ── Emit-ack timeout ─────────────────────────────────────────────────────────
// A zombie socket (transport dead, `disconnect` not yet fired) accepts an
// `emit()` call but the server never sees it — the ack callback then hangs
// forever, silently stalling flushOutbox's FIFO drain / sendMessage. Socket.IO
// v4's `.timeout(ms)` rejects with an error if no ack arrives in time so the
// caller can retain the job in the outbox instead of losing it.
const EMIT_ACK_TIMEOUT_MS = 10000;

function clearAuthWatchdog(): void {
  if (authWatchdogTimer) {
    clearTimeout(authWatchdogTimer);
    authWatchdogTimer = null;
  }
}
let opkSecretsCache: Map<number, Uint8Array> = new Map();
let mySpkSecretCache: Uint8Array | null = null;

// ── Per-session profile image tracking ───────────────────────────────────────
// We send senderImage only on the FIRST message to each contact per session to
// avoid embedding a 50–100 KB base64 blob in every single envelope. The Set is
// cleared when the socket disconnects so each new session re-sends the image to
// every contact once, ensuring fresh data after an identity update.
const profiledContacts = new Set<string>();

// ── Per-session group avatar tracking ────────────────────────────────────────
// groupAvatarImage (data URI) is included only on the FIRST group message per
// session so receivers always get an up-to-date copy without embedding the
// blob in every multicast envelope. groupAvatarColor (hex string) is always
// included — it is only 7 bytes and requires no read from disk.
const profiledGroupImages = new Set<string>();

/**
 * Body of a metadata-only group sync. It carries fresh name/members/avatar
 * (applied by the group_msg receive handler like any other group message) but
 * renders NO chat bubble — it is intercepted and suppressed on receipt, and
 * sent with skipLocalAppend on the admin. Used to push avatar/name/membership
 * changes to members immediately instead of waiting for the admin's next real
 * message. Keep in sync with the receive-handler intercept.
 */
const GROUP_META_SYNC_BODY = '[group:meta]';

/**
 * Body of a group-dissolution carrier. Rendered as NO chat bubble (suppressed
 * on receipt, same as GROUP_META_SYNC_BODY) — its entire purpose is to carry
 * the signed `dissolved`/`dissolveSig` fields on the payload (see
 * sendGroupMessage) so the receive path can verify-then-wipe. Distinct from
 * GROUP_META_SYNC_BODY so a dissolve is never confused with an ordinary
 * metadata refresh at the intercept site.
 */
const GROUP_DISSOLVE_BODY = '[group:dissolved]';

/**
 * Forget that a group's avatar was already sent this session, so the next group
 * message re-includes the (updated) avatar data URI. Called after the admin
 * changes the group avatar so members pick up the change immediately.
 */
export function forgetGroupAvatarSent(groupId: string): void {
  profiledGroupImages.delete(groupId);
}

// ── Persistent outbox (replaces in-memory offlineQueue + groupOfflineQueue) ───
// Jobs are persisted in SQLite via enqueueOutboxJob / loadOutboxJobs so they
// survive app close and crashes. Drained in FIFO order by flushOutbox() on
// auth:ok and reconnect. See db/local.ts for the outbox table schema.

// ── Group-metadata signing ───────────────────────────────────────────────────
// The canonical signing bytes (v1 inlined roster / v2 roster-by-reference) and
// their sign/verify helpers live in ../crypto/groupSig — the single source of
// truth shared with store/groups.ts and socket/groupMetadataDecision.ts.

/**
 * Sealed-sender transport selector for an outgoing envelope — the single source
 * of truth shared by the online group fan-out (sendGroupMessage) and the
 * offline retry path (flushOutbox). Mirrors the inline selector in sendMessage:
 * use v2 (sealed-sender, no `from` on the wire) ONLY when the flag is on, the
 * session is ESTABLISHED (no pending x3dhInit — first contact bootstraps over
 * v1), and we already hold the recipient's delivery token. Otherwise v1.
 *
 * Returns the socket event name, the wire fields to spread into the emit
 * payload (ciphertext/nonce[/epk/deliveryToken]) and the advanced ratchet
 * state the caller MUST persist. The caller adds id/to (and, for v1 offline
 * bootstrap, the `init` hint).
 */
export async function buildOutgoingEnvelope(
  payload: string,
  recipientAegisId: string,
  recipientPubKey: Uint8Array,
  identity: Identity,
  session: RatchetState,
): Promise<{ event: 'envelope' | 'envelope:v2'; wire: Record<string, unknown>; newState: RatchetState }> {
  const v2Token =
    SEALED_TRANSPORT_VERSION === 'v2' && !session.x3dhInit
      ? await getContactDeliveryToken(recipientAegisId)
      : null;
  if (v2Token) {
    const r = encryptMessageV2(
      payload,
      identity.aegisId,
      recipientPubKey,
      identity.signingSecretKey,
      session,
      Date.now(),
    );
    return {
      event: 'envelope:v2',
      wire: { ciphertext: r.wire.ciphertext, nonce: r.wire.nonce, epk: r.wire.epk, deliveryToken: v2Token },
      newState: r.newState,
    };
  }
  const r = encryptMessage(payload, identity.aegisId, recipientPubKey, identity.secretKey, session);
  return {
    event: 'envelope',
    wire: { ciphertext: r.envelope.ciphertextB64, nonce: r.envelope.nonceB64 },
    newState: r.newState,
  };
}

/**
 * Drain all pending outbox jobs in FIFO order.
 *
 * Each job is re-encrypted with the CURRENT ratchet state at drain time —
 * the outbox only stores plaintext (at-rest encrypted via encryptBody).
 * Jobs that deliver successfully are deleted; failures increment attempts
 * and leave the job in place for the next reconnect / drain cycle.
 *
 * CRITICAL: drain in SERIES (await each before the next) to preserve FIFO
 * order and avoid concurrent ratchet state mutations.
 */
async function flushOutbox(identity: Identity): Promise<void> {
  let jobs: OutboxJob[];
  try {
    jobs = await loadOutboxJobs();
  } catch (e) {
    if (__DEV__) logger.warn('[socket] flushOutbox: could not load jobs', e);
    return;
  }
  if (jobs.length === 0) return;

  for (const job of jobs) {
    if (!socket || !connected || !authenticated) break; // gone offline mid-drain
    try {
      const recipientPublicKey = decodeBase64(job.recipientPubkeyB64);
      const session = await getOrCreateSession(job.recipientAegisId, job.recipientPubkeyB64, identity);
      // X3DH-initial phase: the recipient may not have us as a contact yet. Mark
      // the envelope `init` so that — if it has to be queued because the
      // recipient is offline — the relay attaches our public key to the queued
      // copy. Without this, the first message to a new contact delivered from
      // the offline queue is undecryptable (no sender info) and lost forever.
      // Captured BEFORE encryption (which advances the ratchet). The `init` hint
      // only applies to the v1 path: the v2 selector never fires while a session
      // still has a pending x3dhInit, so v2 envelopes are always established.
      const isInit = !!session.x3dhInit;
      const { event, wire, newState } = await buildOutgoingEnvelope(
        job.payload,
        job.recipientAegisId,
        recipientPublicKey,
        identity,
        session,
      );
      await saveSessionState(job.recipientAegisId, newState);
      await new Promise<void>((resolve, reject) => {
        socket!
          .timeout(EMIT_ACK_TIMEOUT_MS)
          .emit(
            event,
            { id: job.msgId, to: job.recipientAegisId, ...wire, ...(isInit && event === 'envelope' ? { init: true } : {}) },
            (err: Error | null, ack?: { ok: boolean; error?: string }) => {
              // With `.timeout()`, socket.io always calls back with (err, ack):
              // `err` is set on ack timeout (server never responded — dropped
              // frame / zombie transport), `ack` carries the app-level response.
              if (err) { reject(err); return; }
              if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'flush_failed'));
              else resolve();
            },
          );
      });
      await deleteOutboxJob(job.jobId);
    } catch (e) {
      // Includes ack-timeout failures: the job is left in the outbox (NOT
      // deleted) so it retries on the next reconnect/drain instead of being
      // silently lost when the server never acked.
      if (__DEV__) logger.warn('[socket] flushOutbox: job failed, will retry on next reconnect', job.jobId, e);
      try { await incrementOutboxAttempts(job.jobId); } catch { /* non-fatal */ }
    }
  }
}

// Ratchet state JSON revival — see ./ratchetSerde (pure, unit-tested).

export function getSocket(): Socket | null {
  return socket;
}

export function isConnected(): boolean {
  return connected && authenticated;
}

/**
 * Age-based Signed PreKey rotation cadence (B-3). Signal rotates the SPK roughly
 * weekly regardless of one-time-prekey consumption; doing so bounds how long a
 * single SPK secret protects new sessions, giving medium-term forward secrecy
 * even for a low-volume device that never depletes its OPK pool.
 */
export const SPK_ROTATION_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * True iff the current SPK is older than `SPK_ROTATION_INTERVAL_MS` and must be
 * rotated. Lazy backfill: an install that pre-dates B-3 has an SPK but no
 * creation stamp — we stamp `now` and return false so the upgrade does NOT
 * force-rotate every device at once (which would needlessly invalidate every
 * in-flight first-contact handshake). The clock starts from this first sighting.
 */
async function isSignedPreKeyStale(now: number): Promise<boolean> {
  let created: number | null = null;
  try {
    created = await getSpkCreatedAt();
  } catch {
    // DB read failure — treat as "unknown age", do not rotate this cycle.
    return false;
  }
  if (created === null) {
    try { await setSpkCreatedAt(now); } catch {/* best-effort backfill */}
    return false;
  }
  return now - created >= SPK_ROTATION_INTERVAL_MS;
}

async function uploadPreKeys(identity: Identity, deviceId: string) {
  if (!socket) return;

  // SPK keyId must be monotonic per Signal X3DH spec — read the previous
  // keyId and increment. On first run (no stored keyId) start at 1. The
  // previous SPK secret is retained for a grace window (see below) so an
  // in-flight init built from the previous bundle stays decryptable.
  //
  // The DB (durable, encrypted-at-rest) is now the SOURCE OF TRUTH for the
  // keyId; SecureStore is only a secondary cache. Reading the keyId from the
  // DB first means a Keystore wipe can no longer reset the counter and collide
  // keyIds with a SPK whose secret the peer already fetched.
  let prevSpkKeyId: number | null = null;
  try {
    prevSpkKeyId = await getSpkKeyId();
  } catch {/* treat as first run */}
  if (prevSpkKeyId === null) {
    // Fall back to the legacy SecureStore keyId for installs that pre-date the
    // DB store, so we keep incrementing monotonically rather than restarting at 1.
    try {
      const stored = await SecureStore.getItemAsync(SECURE_SPK_KEYID_KEY());
      if (stored) {
        const parsed = parseInt(stored, 10);
        if (Number.isFinite(parsed) && parsed > 0) prevSpkKeyId = parsed;
      }
    } catch {/* treat as first run */}
  }
  const nextSpkKeyId = (prevSpkKeyId ?? 0) + 1;

  // PQXDH (v2): mirror the SPK's monotonic-keyId + never-publish-what-we-can't
  // -read-back invariant for the PQSPK (ML-KEM-768), using the SAME durable
  // counter (getPqSpkKeyId/setPqSpkKeyId) that ensureDevicePreKeys uses, so this
  // legacy upload path and the single-source-of-truth path can never diverge on
  // which PQSPK keyId is "current".
  let prevPqSpkKeyId: number | null = null;
  try {
    prevPqSpkKeyId = await getPqSpkKeyId();
  } catch {/* treat as first run */}
  const nextPqSpkKeyId = (prevPqSpkKeyId ?? 0) + 1;

  const preKeys = generatePreKeys(identity, 1, 100, nextSpkKeyId, nextPqSpkKeyId);
  mySpkSecretCache = preKeys.signedPreKey.secretKey;
  opkSecretsCache = preKeys.opkSecrets;

  // expo-secure-store has a ~2KB-per-item limit on iOS. Stuffing 100 OPK
  // secrets into a single JSON blob (~5KB) used to silently fail and break
  // X3DH receiver-side decryption. Store each OPK secret as its own item
  // and keep a separate index of active keyIds for cleanup.
  // Store X3DH private prekeys (SPK/OPK secrets) with the same hardware-backed
  // keychain accessibility as the identity keys (see db/local.ts). AFTER_FIRST_UNLOCK
  // is required for Android 14 StrongBox compatibility — without it setItemAsync can
  // throw a native NPE on first write on some devices. Aligning prevents the same
  // crash the identity-key path was fixed for, and keeps the secrets unreadable
  // while the device is locked at rest.
  const secureOpts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

  const newSecretB64 = encodeBase64(preKeys.signedPreKey.secretKey);

  // ── PRIMARY durable persistence: SQLite (encrypted at rest) ────────────────
  // Write the SPK secret + keyId + every OPK secret to the DB FIRST. The DB is
  // the source of truth. If the SPK secret cannot be persisted-and-read-back,
  // we MUST NOT publish its public key (the invariant). We retry the SPK write
  // once before giving up.
  const persistSpkToDb = async (): Promise<boolean> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await saveSpkSecret(nextSpkKeyId, newSecretB64);
        const back = await loadSpkSecret(nextSpkKeyId);
        if (back === newSecretB64) return true;
      } catch (e) {
        if (__DEV__) logger.warn('[socket] SPK secret DB write attempt failed', attempt, e);
      }
    }
    return false;
  };

  const spkDbOk = await persistSpkToDb();
  if (!spkDbOk) {
    // INVARIANT: never publish a SPK whose secret we cannot read back. Abort the
    // upload entirely so the peer never fetches a bundle we cannot complete.
    rdiag(`[RDIAG] prekey-store ABORT spkId=${nextSpkKeyId} dbReadback=NULL — NOT emitting prekeys:upload`);
    throw new Error(`uploadPreKeys: could not persist SPK secret for keyId ${nextSpkKeyId} — refusing to publish`);
  }

  // PQXDH (v2): same write-then-readback invariant for the PQSPK secret
  // (2400 bytes). If we cannot durably persist+readback the PQSPK, we fall
  // back to a v1-safe upload (omit pqSignedPreKey below) rather than
  // publishing a PQ prekey whose secret we could not recover — that would
  // silently break every inbound v2 handshake to this device.
  const newPqSecretB64 = encodeBase64(preKeys.pqSignedPreKey.secretKey);
  const persistPqSpkToDb = async (): Promise<boolean> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await savePqSpkSecret(nextPqSpkKeyId, newPqSecretB64);
        const back = await loadPqSpkSecret(nextPqSpkKeyId);
        if (back === newPqSecretB64) return true;
      } catch (e) {
        if (__DEV__) logger.warn('[socket] PQSPK secret DB write attempt failed', attempt, e);
      }
    }
    return false;
  };
  const pqSpkDbOk = await persistPqSpkToDb();
  if (pqSpkDbOk) {
    try { await setPqSpkKeyId(nextPqSpkKeyId); } catch (e) {
      if (__DEV__) logger.warn('[socket] could not persist PQSPK keyId to DB', e);
    }
  } else {
    rdiag(`[RDIAG] prekey-store PQSPK-SKIP pqSpkId=${nextPqSpkKeyId} dbReadback=NULL — uploading v1-safe (no pqSignedPreKey)`);
  }

  // Persist the keyId (durable counter) and every OPK secret to the DB.
  try {
    await setSpkKeyId(nextSpkKeyId);
  } catch (e) {
    if (__DEV__) logger.warn('[socket] could not persist SPK keyId to DB', e);
  }
  // Stamp the new SPK's creation time so the age-based rotation trigger
  // (isSignedPreKeyStale) measures THIS SPK's lifetime from now (B-3).
  try {
    await setSpkCreatedAt(Date.now());
  } catch (e) {
    if (__DEV__) logger.warn('[socket] could not persist SPK createdAt to DB', e);
  }
  for (const [keyId, secret] of preKeys.opkSecrets.entries()) {
    try {
      await saveOpkSecret(keyId, encodeBase64(secret));
    } catch (e) {
      if (__DEV__) logger.warn('[socket] could not persist OPK secret to DB', keyId, e);
    }
  }

  // Forward secrecy vs deliverability: retain the last K=5 SPK secrets and drop
  // anything older. With ~weekly age-based rotation (B-3) that keeps ≥28 days of
  // decryptability, so an initial message that slept in the relay queue (TTL 30
  // days) and was built against an older SPK still decrypts. Deleting only the
  // immediately-previous SPK (the pre-B-3 behaviour) would silently break those
  // queued inits once rotation became time-driven.
  const SPK_RETAIN = 5;
  const staleSpkKeyId = nextSpkKeyId - SPK_RETAIN;
  if (staleSpkKeyId >= 1) {
    try { await deleteSpkSecret(staleSpkKeyId); } catch {/* best-effort */}
  }

  // ── SECONDARY cache: SecureStore (best-effort; DB is authoritative) ─────────
  // We still mirror to SecureStore so legacy read paths and other code keep
  // working, but a failure here is NON-FATAL because the DB already holds the
  // secrets. This removes the old failure mode where a silent Keystore bulk
  // write failure left us publishing a SPK whose secret we couldn't read.
  try {
    await SecureStore.setItemAsync(spkSecretKey(nextSpkKeyId), newSecretB64, secureOpts);
    await SecureStore.setItemAsync(SECURE_SPK_SECRET_KEY(), newSecretB64, secureOpts);
    await SecureStore.setItemAsync(SECURE_SPK_KEYID_KEY(), String(nextSpkKeyId), secureOpts);

    if (staleSpkKeyId >= 1) {
      try { await SecureStore.deleteItemAsync(spkSecretKey(staleSpkKeyId)); } catch {/* best-effort */}
    }

    try {
      const prevIdsJson = await SecureStore.getItemAsync(SECURE_OPK_IDS_KEY());
      if (prevIdsJson) {
        const prev = JSON.parse(prevIdsJson) as number[];
        const fresh = new Set(Array.from(preKeys.opkSecrets.keys()));
        for (const old of prev) {
          if (!fresh.has(old)) {
            await SecureStore.deleteItemAsync(opkSecretKey(old));
          }
        }
      }
    } catch {/* ignore */}

    for (const [keyId, secret] of preKeys.opkSecrets.entries()) {
      await SecureStore.setItemAsync(opkSecretKey(keyId), encodeBase64(secret), secureOpts);
    }
    await SecureStore.setItemAsync(
      SECURE_OPK_IDS_KEY(),
      JSON.stringify(Array.from(preKeys.opkSecrets.keys())),
      secureOpts
    );
  } catch (err) {
    // Non-fatal: the DB is the durable source of truth.
    if (__DEV__) logger.warn('[socket] SecureStore prekey cache write failed (DB is authoritative):', err);
  }

  // [RDIAG] confirm the SPK secret is readable back from the DURABLE store.
  rdiag(`[RDIAG] prekey-store DONE spkId=${nextSpkKeyId} dbReadback=OK opkCount=${preKeys.opkSecrets.size}`);

  return new Promise<void>((resolve, reject) => {
    socket!.emit('prekeys:upload', {
      deviceId,
      signedPreKey: {
        keyId: preKeys.signedPreKey.keyId,
        publicKeyB64: preKeys.signedPreKey.publicKeyB64,
        signatureB64: preKeys.signedPreKey.signatureB64
      },
      oneTimePreKeys: preKeys.oneTimePreKeys,
      // PQXDH (v2): omitted entirely when the PQSPK secret could not be
      // durably persisted+read-back above — this keeps the upload v1-safe
      // instead of advertising a PQ prekey we cannot decapsulate with later.
      ...(pqSpkDbOk
        ? {
            pqSignedPreKey: {
              keyId: preKeys.pqSignedPreKey.keyId,
              publicKeyB64: preKeys.pqSignedPreKey.publicKeyB64,
              signatureB64: preKeys.pqSignedPreKey.signatureB64,
            } satisfies PqSignedPreKeyPublic,
          }
        : {}),
    }, (ack: { ok: boolean, error?: string }) => {
      if (ack?.ok) {
        // Multi-device: sync the new SPK secret to our other linked devices.
        try {
          const innerPayload = {
            v: 2,
            from: identity.aegisId,
            selfCopy: true,
            deviceSync: { type: 'spk', spkId: nextSpkKeyId, spkSecretB64: encodeBase64(mySpkSecretCache!) }
          };
          const { stripAndPad } = require('../crypto/metadata') as typeof import('../crypto/metadata');
          const innerBytes = stripAndPad(innerPayload);
          const outerNonce = nacl.randomBytes(nacl.box.nonceLength);
          const outerCiphertext = nacl.box(innerBytes, outerNonce, identity.publicKey, identity.secretKey);
          socket!.emit('envelope', {
            id: Crypto.randomUUID(),
            to: identity.aegisId,
            ciphertext: encodeBase64(outerCiphertext),
            nonce: encodeBase64(outerNonce),
            selfCopy: true,
          });
        } catch (e) {
          if (__DEV__) logger.warn('[socket] deviceSync broadcast failed:', (e as Error).message);
        }
        resolve();
      } else {
        reject(new Error(ack?.error || 'failed to upload prekeys'));
      }
    });
  });
}

/**
 * Reconnect the socket the moment the app returns to the foreground.
 *
 * Android (and iOS) suspend the JS runtime while the app is backgrounded, which
 * kills the WebSocket; socket.io's own reconnect timer is frozen during that
 * suspension, so on resume the client can sit disconnected — or worse, hold a
 * half-open "ghost" the relay still counts as online, so inbound messages are
 * routed to a dead socket instead of triggering an FCM push wake-up. Both show
 * up to the user as "connection drops / notifications don't arrive after closing
 * the app". Forcing a reconnect on 'active' closes that gap. Registered once.
 */
function armForegroundReconnect(): void {
  if (foregroundReconnectArmed) return;
  foregroundReconnectArmed = true;
  const { AppState } = require('react-native') as typeof import('react-native');
  AppState.addEventListener('change', (next: string) => {
    if (next !== 'active') return;
    if (socket) {
      if (!socket.connected) socket.connect();
      return;
    }
    // No socket at all (e.g. cold resume before connect ran): bring it up.
    const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
    const id = useIdentity.getState().identity;
    if (id) connect(id);
  });
}

/**
 * Fase 4 / Slice 2b: open the dedicated mailbox delivery socket for `identity`
 * when mailbox mode is enabled (and Tor is available — fail-closed inside
 * connectMailboxSocket). That socket authenticates by mailbox possession proof
 * and receives `envelope:mb` addressed to our opaque rotating mailbox id.
 * Incoming mailbox envelopes are sealed v2 with the same shape as envelope:v2,
 * so they reuse the exact same decrypt+append path.
 *
 * Exported (not just inlined in connect()) so callers that reuse an already-open
 * aegisId socket without re-running the full connect() body — e.g. the
 * background wake-up path in notifications/backgroundReconnect.ts, which only
 * kicks a dead socket via socket.connect() on the "same identity" fast path —
 * can still ensure the mailbox drains. No-op when mailbox mode is off.
 * Idempotent: a live mailbox socket is reused, never duplicated.
 */
export function connectMailboxForIdentity(identity: Identity): void {
  if (!MAILBOX_ENABLED) return;
  void connectMailboxSocket((env) => {
    rdiag(`[RDIAG] envelope:mb RECV id=${env.id}`);
    // Return the promise (NO .catch here) so mailboxSocket emits 'envelope:ack'
    // ONLY after handleIncomingV2 has persisted the message. A throw propagates →
    // no ack → the relay re-drains it (at-least-once, audit 2026-07-24).
    return handleIncomingV2(env, identity);
  });
  // Slice 2b.2: also subscribe to our ntfy wake topic over Tor. If the mailbox
  // socket drops (dead circuit) and the relay queues a message, this wakes us to
  // reconnect+drain without waiting for the blind reconnect backoff. Idempotent;
  // no-op when Tor/mailbox mode is unavailable. Draining = re-open the mailbox.
  startMailboxPushSubscription(() => connectMailboxForIdentity(identity));
}

export function connect(identity: Identity): Socket {
  // Idempotent (flag-guarded): arm the foreground-reconnect listener on the
  // first connect of the app's lifetime, regardless of which branch we take.
  armForegroundReconnect();

  // Sync the Android call-wake foreground service to the user's preference on
  // every connect (idempotent; Android-only, no-op elsewhere). When enabled it
  // keeps the process resident so a call rings with the app killed — zero-Google.
  if (usePreferences.getState().callWakeService) startCallWakeService();
  else stopCallWakeService();

  if (
    socket &&
    socket.auth &&
    (socket.auth as { aegisId: string }).aegisId === identity.aegisId
  ) {
    // Same identity: reuse the socket — but make sure it's actually trying to
    // connect before handing it back. After a background suspension the OS often
    // kills the WebSocket while socket.io's reconnect timer is frozen, leaving a
    // disconnected handle. Callers that re-enter connect() (push wake-up, inline
    // reply, foreground) would otherwise receive that dead socket and never come
    // back online. Kicking it is a no-op when already connected.
    if (!socket.connected) socket.connect();
    // The fast path never re-runs the mailbox wiring below — cover it here too
    // so a reused aegisId socket (e.g. background wake-up kicking a dead
    // handle) doesn't leave mailbox-queued messages stuck undrained.
    connectMailboxForIdentity(identity);
    return socket;
  }
  if (socket) socket.disconnect();

  authenticated = false;

  // Read Tor preference synchronously from Zustand store (no hook needed outside React)
  const { routeViaTor } = usePreferences.getState();
  let relayUrl = routeViaTor && ONION_URL ? ONION_URL : SERVER_URL;

  // Hardened Transport: Enforce HTTPS/WSS in production. Exception: developer
  // loopback hosts (emulator host 10.0.2.2 + localhost) are permitted over
  // cleartext, mirroring android/.../network_security_config.xml which already
  // whitelists exactly these hosts. The app never contacts them in production,
  // so this does not weaken the shipped transport — it only lets a release APK
  // talk to a relay running on the developer's machine for E2E verification.
  const isLoopbackRelay = /^(https?|wss?):\/\/(10\.0\.2\.2|localhost|127\.0\.0\.1)(:|\/|$)/.test(
    relayUrl
  );
  if (!__DEV__ && !isLoopbackRelay) {
    if (relayUrl.startsWith('http://')) {
      relayUrl = relayUrl.replace('http://', 'https://');
    } else if (relayUrl.startsWith('ws://')) {
      relayUrl = relayUrl.replace('ws://', 'wss://');
    }
    if (!relayUrl.startsWith('https://') && !relayUrl.startsWith('wss://')) {
      throw new Error('AegisLink: Insecure connection protocol refused in production');
    }
  }

  // ── Stable per-slot deviceId ────────────────────────────────────────────────
  // Resolved asynchronously; socket creation and event wiring happen immediately
  // with a placeholder, then replaced once the SecureStore read completes. The
  // deviceId is only consumed inside async callbacks (auth:ok, uploadPreKeys) so
  // by then the promise will have resolved and `resolvedDeviceId` will be set.
  let resolvedDeviceId = '';
  const deviceIdReady: Promise<string> = (async () => {
    const { getActiveDbSlot } = require('../db/local') as { getActiveDbSlot: () => string };
    const slot = getActiveDbSlot();
    const slotSuffix = slot && slot !== 'self' ? `.${slot}` : '';
    const slotKey = `aegis.deviceId${slotSuffix}`;
    let id = await SecureStore.getItemAsync(slotKey);
    if (!id) {
      id = Crypto.randomUUID();
      await SecureStore.setItemAsync(slotKey, id);
    }
    resolvedDeviceId = id;
    return id;
  })();

  socket = io(relayUrl, {
    // WebSocket first (lowest latency), but fall back to HTTP long-polling within
    // the SAME connection attempt when the WS upgrade is blocked — the common case
    // behind reverse proxies (our duckdns TLS terminator) and on restrictive mobile
    // / carrier-NAT networks. Previously this was ['websocket'] only, so any failed
    // upgrade left the socket permanently disconnected with no recovery path, which
    // the user experiences as "no conecta / se cae sola". tryAllTransports (socket.io
    // 4.8+) makes Engine.IO attempt polling in the same shot instead of giving up.
    transports: ['websocket', 'polling'],
    tryAllTransports: true,
    // ackDelivery: we send 'envelope:ack' after persisting each incoming envelope,
    // so the relay defers deletion until confirmed (at-least-once). audit 2026-07-25.
    auth: { aegisId: identity.aegisId, platform: 'mobile', ackDelivery: true },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
    reconnectionAttempts: Infinity,
    timeout: 20000,
  });

  socket.on('connect', () => {
    connected = true;
    authenticated = false;
    useConnection.getState().setOnline(true);
    if (__DEV__) logger.warn('[socket] connected, awaiting auth challenge');

    // Arm the watchdog: if auth:ok never arrives (lost handshake during a
    // relay restart), force a fresh transport instead of sitting on a socket
    // that is connected but permanently unauthenticated.
    clearAuthWatchdog();
    authWatchdogTimer = setTimeout(() => {
      authWatchdogTimer = null;
      if (authenticated) return; // race: auth:ok landed just before the timer fired
      if (__DEV__) logger.warn('[socket] auth watchdog fired — no auth:ok, forcing reconnect');
      socket?.disconnect();
      socket?.connect();
    }, AUTH_WATCHDOG_MS);
  });

  socket.on('disconnect', (reason) => {
    connected = false;
    authenticated = false;
    clearAuthWatchdog();
    useConnection.getState().setOnline(false);
    // Distinguish a disconnect that lands mid-call from an idle one — a call-time
    // 'ping timeout' used to be the signature of heartbeat starvation during
    // WebRTC setup (see server/src/index.ts pingTimeout comment). The reconnect
    // path already recovers signaling safely (socket.io-client buffers emits
    // made while disconnected and flushes on reconnect; App.tsx re-arms
    // attachCallHandlers() on every `online` transition), so this is diagnostic
    // only — it does not change call behavior.
    if (__DEV__) {
      try {
        const { useCall } = require('../store/call') as typeof import('../store/call');
        const callStatus = useCall.getState().status;
        if (callStatus !== 'idle' && callStatus !== 'ended') {
          logger.warn('[socket] disconnected DURING active call — reason:', reason, 'callStatus:', callStatus);
        } else {
          logger.warn('[socket] disconnected:', reason);
        }
      } catch {
        logger.warn('[socket] disconnected:', reason);
      }
    }
  });

  socket.on('error_msg', async (e: { code?: string; for?: string }) => {
    if (__DEV__) logger.warn('[socket] server error:', e);
    if (e?.code === 'peer_offline' && e?.for === 'call:invite') {
      // Only fatal for call:invite: the relay could not deliver our invite to
      // the callee (no WebSocket connection AND no push tokens). In that case
      // we must tear down the outgoing ringing state immediately.
      //
      // When e.for is anything else — e.g. 'call:ice' (trickle ICE candidate
      // the relay couldn't forward) — the loss is non-fatal: WebRTC will
      // complete ICE with the remaining candidates. Hanging up on an
      // undeliverable ICE candidate would be a false positive that kills a
      // call that is or will be connected.
      //
      // Note: if the callee HAS push tokens the relay enqueues the invite,
      // sends an FCM/APNs wake-up, and does NOT emit peer_offline. The
      // 45-second no_answer timeout in calls.ts handles the case where the
      // callee never responds after waking up.
      const { endCall } = require('./calls') as typeof import('./calls');
      endCall('peer_offline');
      themedAlert('Contact offline', 'The contact is not currently connected to the server. Try again later.');
    }
    if (e?.code === 'unknown_identity') {
      // Server doesn't know us — re-register via the SINGLE de-duplicated path
      // (store/identity.ts retryPublish()), never a direct ensureRegistered()
      // call here. retryPublish(true) still no-ops if a registration is
      // already 'publishing' (never duplicated), so this can never race a
      // publish already in flight from generate()/hydrate() — that used to
      // cause a second, concurrent PoW/registration attempt (double PoW
      // mining + double hit on the relay's per-IP rate limit). See
      // src/utils/socketGate.ts for the companion fix on the connect side.
      //
      // `force: true` is required here (CodeRabbit PR #301): unknown_identity
      // is proof that a persisted publishStatus === 'published' (restored by
      // hydrate() from the `aegis.published.<slot>` flag) is STALE — the
      // relay has forgotten us. Without force, retryPublish() would no-op on
      // that stale 'published' status, we'd reconnect anyway below, and the
      // relay would reject again — an infinite unknown_identity ⇄ reconnect
      // loop.
      if (__DEV__) logger.debug('[socket] unknown_identity — re-registering via retryPublish(force) and reconnecting');
      try {
        const { useIdentity } = await import('../store/identity');
        const before = useIdentity.getState().publishStatus;
        await useIdentity.getState().retryPublish(true);
        const after = useIdentity.getState();
        if (after.publishStatus === 'published') {
          if (__DEV__) logger.debug('[socket] re-registered — reconnecting');
          // The relay already closed this socket server-side (reason
          // 'io server disconnect'), and that reason does NOT trigger Socket.IO's
          // auto-reconnect. Re-open the socket explicitly so the new identity
          // gets a fresh auth challenge and comes back online.
          socket?.connect();
        } else if (after.publishStatus === 'failed') {
          if (__DEV__) logger.warn('[socket] re-registration failed:', after.publishError);
          useConnection.getState().setOnline(false);
        } else if (before === 'publishing') {
          // A registration was already in flight (retryPublish no-op'd) — it
          // will itself flip publishStatus to 'published'/'failed', and
          // App.tsx's shouldConnectSocket-gated effect reconnects the socket
          // once it resolves. Nothing to do here but leave the socket closed.
          if (__DEV__) logger.debug('[socket] unknown_identity: publish already in flight, deferring reconnect');
        }
      } catch (err) {
        if (__DEV__) logger.warn('[socket] re-registration error:', err);
        useConnection.getState().setOnline(false);
      }
    }
  });

  socket.on('auth:challenge', (chal: WireChallenge) => {
    try {
      const ephemeral = decodeBase64(chal.ephemeralPubKey);
      const nonce = decodeBase64(chal.nonce);
      const ct = decodeBase64(chal.ciphertext);
      if (ephemeral.length !== nacl.box.publicKeyLength) throw new Error('bad ephemeral key');
      if (nonce.length !== nacl.box.nonceLength) throw new Error('bad nonce length');
      const opened = nacl.box.open(ct, nonce, ephemeral, identity.secretKey);
      if (!opened) throw new Error('challenge decrypt failed');
      socket!.emit('auth:response', { plain: encodeBase64(opened) });
    } catch (e) {
      if (__DEV__) logger.warn('[socket] auth failure:', (e as Error).message);
      socket?.disconnect();
    }
  });

  socket.on('auth:ok', async (res?: { opkCount?: number }) => {
    authenticated = true;
    clearAuthWatchdog();
    if (__DEV__) logger.debug('[socket] authenticated');

    // Warm the TURN credential cache (50-min TTL) so the first call doesn't pay
    // the up-to-3s credential fetch during setup. Fire-and-forget; on failure
    // call setup simply fetches (or falls back to STUN-only) as before.
    try {
      const { fetchTurnConfig } = require('../webrtc/ice') as typeof import('../webrtc/ice');
      // Warm the cache for the policy the call will actually use (relay when the
      // hideCallIp preference is ON, default) so the first call isn't a cache miss.
      // Audit 2026-07 (M4).
      const hideCallIp = (require('../store/preferences') as typeof import('../store/preferences')).usePreferences.getState().hideCallIp;
      void fetchTurnConfig(identity.aegisId, hideCallIp).catch(() => {});
    } catch { /* webrtc module unavailable (tests/Expo Go) */ }

    // Ensure deviceId is resolved before using it below
    const deviceId = resolvedDeviceId || await deviceIdReady;

    // Patch the auth object on the live socket so reconnection attempts also carry deviceId
    if (socket) {
      (socket.auth as Record<string, unknown>).deviceId = deviceId;
    }

    // Flush any messages persisted to the outbox while offline
    void flushOutbox(identity);

    // ── Register push token for silent wake-ups ──────────────────────────────
    // Called AFTER auth:ok so we have an authenticated socket connection.
    // De-duplicate: only emit push:register when the token has changed since
    // the last registration. Expo Go tokens are simulated — never forwarded.
    void (async () => {
      try {
        const { IS_EXPO_GO } = require('../runtime') as { IS_EXPO_GO: boolean };
        if (IS_EXPO_GO) return; // simulated token — do not forward to server

        const { registerForPush } = require('../notifications/push') as typeof import('../notifications/push');
        await registerForPush(identity);

        // After registerForPush succeeds, check if token changed and emit to relay
        const Notifications = require('expo-notifications');
        const perm = await Notifications.getPermissionsAsync();
        if (!perm.granted && perm.status !== 'granted') return;

        const tokenData = await Notifications.getExpoPushTokenAsync();
        const freshToken: string = tokenData.data;
        // Re-register until the relay CONFIRMS the write via ack. The old code
        // emitted fire-and-forget and cached the token as "done" immediately, so
        // a lost frame or a rate-limited emit was never retried — the relay kept
        // ZERO tokens for the identity and a killed iOS app never woke
        // (notifyRecipient had nothing to send to). We now gate the cache on the
        // ack and re-emit on every auth until 'aegis.pushToken.confirmed' matches
        // the live token. Keying on a *confirmed* marker also self-heals installs
        // already stuck by the old bug (their stale 'aegis.pushToken' never
        // re-emitted). Idempotent server-side (pushRepo.upsert).
        const confirmedToken = await SecureStore.getItemAsync('aegis.pushToken.confirmed');
        if (confirmedToken !== freshToken) {
          const { Platform } = require('react-native');
          const platform = Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown';
          try {
            await new Promise<void>((resolve, reject) => {
              socket!
                .timeout(EMIT_ACK_TIMEOUT_MS)
                .emit('push:register', { token: freshToken, platform }, (err: Error | null, ack?: { ok?: boolean }) => {
                  if (err) { reject(err); return; }
                  if (!ack?.ok) { reject(new Error('push_register_rejected')); return; }
                  resolve();
                });
            });
            await SecureStore.setItemAsync('aegis.pushToken.confirmed', freshToken);
            await SecureStore.setItemAsync('aegis.pushToken', freshToken);
          } catch (e) {
            // Not confirmed (lost frame / rate-limited / timeout) → leave the
            // marker unset so the next auth retries. Never fatal to the connect.
            if (__DEV__) logger.warn('[socket] push:register not confirmed, will retry next auth:', e);
          }
        }

        // ── iOS: also register the RAW APNs token (direct-APNs message wake) ────
        // getDevicePushTokenAsync returns the standard APNs device token (hex),
        // DISTINCT from the Expo token above and the VoIP token below. It lets the
        // relay wake a killed iPhone straight through APNs — no Expo hop, the way
        // Session's push server does. Fail-safe: if this never registers, the
        // relay falls back to the Expo push, so nothing regresses. Same ack-gated
        // confirmed-marker dedup so a lost frame retries on the next auth.
        {
          const { Platform } = require('react-native');
          if (Platform.OS === 'ios') {
            try {
              const dev = await Notifications.getDevicePushTokenAsync();
              const apnsToken: string = typeof dev?.data === 'string' ? dev.data : '';
              const confirmedApns = await SecureStore.getItemAsync('aegis.apnsToken.confirmed');
              if (apnsToken && confirmedApns !== apnsToken) {
                await new Promise<void>((resolve, reject) => {
                  socket!
                    .timeout(EMIT_ACK_TIMEOUT_MS)
                    .emit('apns:register', { token: apnsToken, platform: 'ios' }, (err: Error | null, ack?: { ok?: boolean }) => {
                      if (err) { reject(err); return; }
                      if (!ack?.ok) { reject(new Error('apns_register_rejected')); return; }
                      resolve();
                    });
                });
                await SecureStore.setItemAsync('aegis.apnsToken.confirmed', apnsToken);
              }
            } catch (e) {
              if (__DEV__) logger.warn('[socket] apns:register not confirmed, will retry next auth:', e);
            }
          }
        }
      } catch (e) {
        if (__DEV__) logger.warn('[socket] push token registration failed:', e);
      }
    })();

    // ── Register iOS VoIP (PushKit) token ────────────────────────────────────
    // A VoIP token obtained (async, native) before this socket was authed is
    // cached; flush it now over the authenticated channel. No-op off iOS.
    void (async () => {
      try {
        const { flushVoipToken } = require('../calls/voip-push') as typeof import('../calls/voip-push');
        await flushVoipToken();
      } catch (e) {
        if (__DEV__) logger.warn('[socket] voip token registration failed:', e);
      }
    })();

    // Sealed-sender v2: register the HASH of our delivery token so contacts can
    // submit sealed envelopes to us. Only the hash leaves the device; the raw
    // token reaches contacts inside our E2EE profile_update (see below).
    if (SEALED_TRANSPORT_VERSION === 'v2') {
      void (async () => {
        try {
          const raw = await getOwnDeliveryToken();
          socket!.emit('deliveryToken:register', { tokenHashB64: hashDeliveryToken(raw) });
        } catch (e) {
          if (__DEV__) logger.warn('[socket] deliveryToken register failed:', e);
        }
      })();
    }

    const count = res?.opkCount ?? 0;
    // Two independent reasons to (re)publish prekeys: the OPK pool is running low
    // (depletion refill) OR the SPK has aged past the rotation interval (B-3,
    // Signal ~weekly). Either way a single uploadPreKeys refreshes the SPK
    // (new keyId + createdAt stamp) and tops the OPK pool back up.
    const needRefill = count < 20;
    const needRotate = await isSignedPreKeyStale(Date.now());
    if (needRefill || needRotate) {
      try {
        await uploadPreKeys(identity, deviceId);
        if (__DEV__) {
          logger.debug(
            '[socket] prekeys uploaded —',
            needRotate ? 'SPK rotation (age)' : 'OPK refill',
            '(count was', count, ')',
          );
        }
      } catch (err) {
        if (__DEV__) logger.error('[socket] prekey upload error:', err);
      }
    } else {
      if (__DEV__) logger.debug('[socket] prekeys count healthy:', count, '— no refill/rotation needed');
    }

    // Push our profile (name + avatar as data URI) to all contacts on every connect
    // so they always have our latest image even if they were offline when we updated it.
    // Guard against a cold-start race: useContacts.hydrate() is async and may not have
    // finished by the time auth:ok fires. If contacts is still empty (loading=true) we
    // subscribe to the store and broadcast as soon as the first non-loading snapshot
    // arrives with at least one contact, then unsubscribe immediately.
    ((): void => {
      const contactsState = useContacts.getState();
      if (!contactsState.loading && contactsState.contacts.length > 0) {
        void broadcastProfileUpdate(identity);
        return;
      }
      if (contactsState.contacts.length > 0) {
        // Already has contacts but loading flag is still set — safe to broadcast now
        void broadcastProfileUpdate(identity);
        return;
      }
      // Contacts not loaded yet — wait for first hydrated snapshot
      const unsub = useContacts.subscribe((state) => {
        if (!state.loading) {
          unsub();
          void broadcastProfileUpdate(identity);
        }
      });
    })();
  });

  socket.on('msg:delivered', ({ msgId, to }: { msgId: string; to: string }) => {
    // `to` is the recipient's aegisId, which is also the chatId for the sender
    const msgs = useMessages.getState();
    const chatMsgs = msgs.byChat[to];
    if (chatMsgs?.find((m) => m.id === msgId)) {
      void msgs.updateDelivery(to, msgId, 'delivered');
    }
  });

  socket.on('msg:read', ({ from, msgIds }: { from: string; msgIds: string[] }) => {
    const msgs = useMessages.getState();
    for (const msgId of msgIds) {
      const chatMsgs = msgs.byChat[from];
      if (chatMsgs?.find((m) => m.id === msgId)) {
        void msgs.updateDelivery(from, msgId, 'read');
      }
    }
  });

  // NOTE: the legacy plaintext `msg:delete` relay event is intentionally NOT
  // handled. Delete-for-everyone now travels inside the sealed E2EE ratchet
  // channel (`{type:'msg_delete'}`), which authenticates the sender. Honoring
  // an unauthenticated wire event would let a malicious relay erase arbitrary
  // messages by supplying {from, msgId} (golden rule #3: sensitive actions
  // require proof-of-key-possession, not just knowing an id).

  socket.on('typing', ({ from, isTyping }: { from: string; isTyping: boolean }) => {
    const { useTyping } = require('../store/typing');
    useTyping.getState().setTyping(from, isTyping);
    // Auto-clear after 5 s in case the stop signal is lost
    if (isTyping) {
      setTimeout(() => useTyping.getState().setTyping(from, false), 5000);
    }
  });

  socket.on('envelope', async (env: WireSealedEnvelope) => {
    rdiag(`[RDIAG] envelope RECV from=${env.from ?? '(none)'} hasSenderPub=${!!env.senderPublicKeyB64} self=${!!env.selfCopy}`);
    try {
      await handleIncoming(env, identity);
      // AT-LEAST-ONCE (audit 2026-07-24): ack after persisting so the relay deletes
      // the queued row only once we durably have it. No ack on failure → re-drains.
      try { socket!.emit('envelope:ack', { id: env.id }); } catch { /* noop */ }
    } catch (e) {
      if (__DEV__) logger.warn('[socket] handleIncoming failed:', (e as Error).message);
    }
  });

  // Sealed-sender v2: no `from` on the wire. The ephemeral box opens with our
  // secret + epk alone; the inner signature authenticates the sender. Reuses the
  // exact same downstream as v1 via decryptAndAppend.
  socket.on('envelope:v2', async (env: WireSealedEnvelopeV2) => {
    rdiag(`[RDIAG] envelope:v2 RECV id=${env.id}`);
    try {
      await handleIncomingV2(env, identity);
      // AT-LEAST-ONCE (audit 2026-07-24): ack ONLY after persisting, so the relay
      // marks this device drained (and eventually deletes) only once we durably
      // have the message. No ack on failure → the relay re-drains on next connect.
      try { socket!.emit('envelope:ack', { id: env.id }); } catch { /* noop */ }
    } catch (e) {
      if (__DEV__) logger.warn('[socket] handleIncomingV2 failed:', (e as Error).message);
    }
  });

  // ── Fase 4: dedicated mailbox delivery socket ────────────────────────────────
  // No-op when mailbox mode is off. Idempotent: a live socket is reused.
  connectMailboxForIdentity(identity);

  // ── Group re-key fan-out (forward secrecy on member removal) ─────────────────
  // The admin who removed a member sealed a fresh group SenderKey for each
  // remaining member; the relay delivers our individual copy here. We open it
  // with our X25519 secret against the admin's identity key and persist it,
  // overwriting any older SenderKey for that sender so future group messages
  // decrypt with the new chain — and the removed member's old key cannot.
  socket.on(
    'group:rekey_dist',
    async (dist: {
      distId: string;
      groupId: string;
      ciphertextB64: string;
      nonceB64: string;
      iteration: number;
    }) => {
      try {
        const { openSenderKeyDistribution } =
          require('../crypto/channelKey') as typeof import('../crypto/channelKey');
        const { saveSenderKey } =
          require('../crypto/channelKeyStore') as typeof import('../crypto/channelKeyStore');
        const { getGroup } = require('../db/local') as typeof import('../db/local');

        // Sealed sender (Phase 3b): the distributor's aegisId is NOT on the wire.
        // Trial-decrypt the per-recipient box against each ROSTER member's X25519
        // key (bounded by group size, and re-key is a rare member-removal event).
        // A successful NaCl box open authenticates the sender; we then read the
        // signed-in senderAegisId from inside and cross-check it matches the
        // candidate whose key opened the box.
        const group = await getGroup(dist.groupId);
        const roster: string[] = group?.members ?? [];
        const contactsById = new Map(
          useContacts.getState().contacts.map((c) => [c.aegisId, c]),
        );

        let openedFor: string | null = null;
        let senderKey: ReturnType<typeof openSenderKeyDistribution> = null;
        for (const memberId of roster) {
          if (memberId === identity.aegisId) continue;
          const candidate = contactsById.get(memberId);
          if (!candidate?.publicKeyB64) continue;
          const res = openSenderKeyDistribution(
            { ciphertextB64: dist.ciphertextB64, nonceB64: dist.nonceB64 },
            identity.secretKeyB64,
            candidate.publicKeyB64,
          );
          if (res && res.senderAegisId === memberId) {
            openedFor = memberId;
            senderKey = res;
            break;
          }
        }
        if (!openedFor || !senderKey) return; // not addressed to us / unknown distributor

        await saveSenderKey(dist.groupId, openedFor, senderKey.senderKey);
        // Ack only on success — if we throw/return above without acking, the
        // relay re-delivers the queued distribution on the next reconnect.
        socket!.emit('group:rekey_drain_ack', { distId: dist.distId });
      } catch (e) {
        if (__DEV__) logger.warn('[socket] group:rekey_dist handling failed:', (e as Error).message);
      }
    },
  );

  return socket;
}

export function joinChannel(channelId: string, orgId: string): void {
  socket?.emit('channel:join', { channelId, orgId });
}

export function emitChannelMsg(payload: {
  id: string;
  channelId: string;
  orgId: string;
  body: string;
  type: string;
  encrypted?: boolean;
  nonce?: string;
  keyIteration?: number;
}): void {
  socket?.emit('channel:msg', payload);
}

export function emitSenderKeyDist(payload: {
  channelId: string;
  orgId: string;
  toAegisId: string;
  dist: object;
}): void {
  socket?.emit('work:sender_key_dist', payload);
}

export function emitRequestSenderKey(payload: {
  channelId: string;
  orgId: string;
  fromAegisId: string;
}): void {
  socket?.emit('work:request_sender_key', payload);
}

/**
 * Forward-secrecy re-key after a group membership change (member removal).
 *
 * Generates a brand-new SenderKey for the group, persists it locally, then
 * seals it individually for each REMAINING member (the removed member's public
 * key is never present in the distribution list) and emits a single
 * `group:rekey` event. The relay fans each sealed key out to the matching
 * recipient via `group:rekey_dist`. No key material is ever sent in cleartext;
 * each sealed key is a NaCl box bound to the recipient's X25519 identity key.
 *
 * Throws if no identity is loaded or the socket is offline so the caller can
 * surface the failure (the removal must not appear to silently succeed).
 */
export async function rekeyGroupAfterRemoval(
  identity: Identity,
  groupId: string,
  remainingMembers: string[],
): Promise<void> {
  if (!socket || !connected || !authenticated) {
    throw new Error('rekey_offline');
  }

  const { generateSenderKey, sealSenderKeyForRecipients } =
    require('../crypto/channelKey') as typeof import('../crypto/channelKey');
  const { saveSenderKey } =
    require('../crypto/channelKeyStore') as typeof import('../crypto/channelKeyStore');

  // 1. Fresh SenderKey — breaks the chain; the removed member's copy is now useless.
  const newSenderKey = generateSenderKey();

  // 2. Persist locally (SecureStore only) before distributing.
  await saveSenderKey(groupId, identity.aegisId, newSenderKey);

  // 3. Resolve recipients = every remaining member except ourselves that we
  //    have a contact (X25519 key) for. A Map keeps lookup O(1) so building the
  //    list stays linear even at MAX_GROUP_MEMBERS (1024); the prior find() made
  //    it O(N²).
  const contactByAegisId = new Map(
    useContacts.getState().contacts.map((c) => [c.aegisId, c]),
  );
  const recipients: Array<{ aegisId: string; publicKeyB64: string }> = [];
  for (const memberId of remainingMembers) {
    if (memberId === identity.aegisId) continue;
    const contact = contactByAegisId.get(memberId);
    if (!contact) continue;
    recipients.push({ aegisId: memberId, publicKeyB64: contact.publicKeyB64 });
  }

  if (recipients.length === 0) return; // nobody else to re-key

  // Seal off the synchronous path: each box is a pure-JS scalarmult, so the
  // helper yields to the event loop every SEAL_CHUNK_SIZE seals — a 1024-member
  // re-key stays responsive instead of freezing the UI for tens of seconds.
  const sealed = await sealSenderKeyForRecipients(
    newSenderKey,
    groupId,
    identity.aegisId,
    identity.secretKeyB64,
    recipients,
  );
  // Sealed sender (Phase 3b): NO senderAegisId on the wire — it is sealed inside
  // each per-recipient box, so the relay never learns who re-keyed the group.
  const distributions = sealed.map((dist) => ({
    aegisId: dist.aegisId,
    ciphertextB64: dist.ciphertextB64,
    nonceB64: dist.nonceB64,
    iteration: dist.iteration,
  }));

  // 4. Fan-out in batches of 512 (server-side limit per group:rekey call).
  //    Emit each batch sequentially and await its ack before the next one so
  //    that a mid-batch server error is surfaced immediately and not silenced.
  const REKEY_BATCH_SIZE = 512;

  async function emitRekeyBatch(
    batchGroupId: string,
    batch: typeof distributions,
  ): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket!.emit(
        'group:rekey',
        { groupId: batchGroupId, distributions: batch },
        (ack: { ok: boolean; error?: string } | undefined) => {
          if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'rekey_failed'));
          else resolve();
        },
      );
    });
  }

  for (let offset = 0; offset < distributions.length; offset += REKEY_BATCH_SIZE) {
    const batch = distributions.slice(offset, offset + REKEY_BATCH_SIZE);
    await emitRekeyBatch(groupId, batch);
  }
}

export function emitDeleteChannelMsg(payload: {
  channelId: string;
  orgId: string;
  messageId: string;
}): void {
  socket?.emit('channel:delete_msg', payload);
}

// ─── Per-peer session-establishment lock ─────────────────────────────────────
//
// GLARE RACE (first-contact divergence): when two peers add each other almost
// simultaneously, the HIGHER-aegisId peer (canonical initiator) may build+save
// its OWN initiator session in getOrCreateSession AND, ~100 ms later, process
// the LOWER peer's inbound init in decryptAndAppend. If the inbound init is
// processed BEFORE the initiator's own session is persisted, decryptAndAppend's
// loadRatchetSession returns null, the glare gate (which required existingJson)
// is skipped, and the higher peer ADOPTS the lower's init → the two devices end
// on different root keys → messages never decrypt.
//
// Fix: serialise ALL session-establishment work per contact aegisId. The
// create-init+save path (getOrCreateSession) and the inbound-init adoption path
// (decryptAndAppend) both run under withSessionLock(contactAegisId, …), so
// "mint+persist my init" can never interleave with "adopt their init". By the
// time the higher peer processes the lower's init, its own session is already
// persisted → the existing glare gate fires and ours wins deterministically.
//
// The lock is a simple per-key promise chain: each acquirer awaits the previous
// holder's settlement before running, then becomes the tail. It never holds
// across network round-trips that aren't part of session establishment.
const sessionLocks = new Map<string, Promise<unknown>>();

/**
 * Reentrancy context threaded through a single locked call-chain. `heldKeys`
 * holds every aegisId already locked by THIS chain, so a nested acquire of an
 * already-held key passes through instead of deadlocking. It is created fresh
 * at each top-level acquisition and forwarded explicitly down the only
 * synchronous re-entrant path (decryptAndAppend → tryRecoverDesync →
 * sendProfileTo → getOrCreateSession). Two concurrent top-level operations get
 * DISTINCT contexts, so one chain can never see the other's held keys — which
 * is what keeps the bypass safe (a different operation still serialises).
 */
interface LockCtx { heldKeys: Set<string> }

async function withSessionLock<T>(
  aegisId: string,
  fn: (ctx: LockCtx) => Promise<T>,
  ctx?: LockCtx,
): Promise<T> {
  // Reentrant fast-path: this exact call-chain already holds the key, so the
  // critical section is already serialised — run inline (acquiring again would
  // wait on our own never-resolving gate = deadlock). This is the fix for the
  // decryptAndAppend → tryRecoverDesync → sendProfileTo → getOrCreateSession
  // chain where all four touch the SAME contact aegisId.
  if (ctx && ctx.heldKeys.has(aegisId)) {
    return fn(ctx);
  }
  const effectiveCtx: LockCtx = ctx ?? { heldKeys: new Set<string>() };

  const prev = sessionLocks.get(aegisId) ?? Promise.resolve();
  // The stored tail is a never-rejecting sequencing promise: the next acquirer
  // chains off it regardless of whether our critical section resolved or threw,
  // so one failed section cannot reject (or stall) the next.
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  sessionLocks.set(aegisId, prev.then(() => gate, () => gate));
  // Wait for the previous holder to settle before entering the section.
  await prev.catch(() => undefined);
  effectiveCtx.heldKeys.add(aegisId);
  try {
    return await fn(effectiveCtx);
  } finally {
    effectiveCtx.heldKeys.delete(aegisId);
    release();
    // Best-effort cleanup: if no one chained after us, drop the entry so the map
    // does not grow unbounded for one-shot contacts.
    if (sessionLocks.get(aegisId) === undefined) sessionLocks.delete(aegisId);
  }
}

/**
 * Public entry: serialise session establishment per contact aegisId so the
 * create-init+save path can never interleave with decryptAndAppend's
 * load+adopt path (the glare-divergence fix). `lockCtx` is passed ONLY by the
 * re-entrant recovery chain (sendProfileTo while already under decryptAndAppend's
 * lock); top-level callers omit it and acquire the lock fresh.
 */
async function getOrCreateSession(
  contactAegisId: string,
  contactPublicKeyB64: string,
  identity: Identity,
  lockCtx?: LockCtx,
): Promise<RatchetState> {
  return withSessionLock(
    contactAegisId,
    () => getOrCreateSessionLocked(contactAegisId, contactPublicKeyB64, identity),
    lockCtx,
  );
}

async function getOrCreateSessionLocked(contactAegisId: string, contactPublicKeyB64: string, identity: Identity): Promise<RatchetState> {
  const existingJson = await loadRatchetSession(contactAegisId);
  if (existingJson) {
    const s = reviveRatchetState(existingJson);
    return s as RatchetState;
  }

  // No session exists, fetch PreKey bundle and perform X3DH as Alice (Sender)
  if (!socket) throw new Error('Cannot fetch prekeys offline');
  type PreKeyFetchAck = { ok: true; bundle: PreKeyBundle } | { ok: false; error?: string };

  // Retry up to 3 times with 2 s delay to handle the race where the recipient
  // is connecting simultaneously and uploads prekeys just after our first attempt.
  const MAX_PREKEY_RETRIES = 3;
  const PREKEY_RETRY_DELAY_MS = 2000;
  let bundle!: PreKeyBundle;
  for (let attempt = 1; attempt <= MAX_PREKEY_RETRIES; attempt++) {
    const result = await new Promise<{ ok: true; bundle: PreKeyBundle } | { ok: false; msg: string }>((res) => {
      socket!.emit('prekeys:fetch', { aegisId: contactAegisId }, (ack: PreKeyFetchAck) => {
        if (ack?.ok) {
          res({ ok: true, bundle: ack.bundle });
        } else {
          const raw = ack?.error ?? 'prekeys_fetch_failed';
          const msg = raw === 'not_found'
            ? 'Contact is not yet available on this server. Ask them to open AegisLink and try again.'
            : raw;
          res({ ok: false, msg });
        }
      });
    });
    if (result.ok) {
      bundle = result.bundle;
      break;
    }
    // Only retry on not_found; surface other errors immediately
    const isNotFound = result.msg.startsWith('Contact is not yet available');
    if (!isNotFound || attempt === MAX_PREKEY_RETRIES) {
      throw new Error(result.msg);
    }
    await new Promise<void>((res) => setTimeout(res, PREKEY_RETRY_DELAY_MS));
  }

  const contact = useContacts.getState().contacts.find(c => c.aegisId === contactAegisId);
  if (!contact) throw new Error('Contact not found');

  // Treat empty strings as missing (legacy identities may have stored '' for the
  // signing key). Order of preference: locally pinned > bundle from relay >
  // directory lookup. We MUST end up with a non-empty Ed25519 key, otherwise
  // X3DH cannot verify the SPK signature and a MITM-substituted SPK could be
  // accepted silently.
  const nonEmpty = (s: string | undefined | null): string | undefined =>
    typeof s === 'string' && s.length > 0 ? s : undefined;

  let signingPub: string | undefined =
    nonEmpty(contact.signingPublicKeyB64) ?? nonEmpty(bundle.signingPublicKeyB64);

  if (!signingPub) {
    try {
      const { lookupIdentity } = require('../api') as typeof import('../api');
      const record = await lookupIdentity(contactAegisId);
      const fetched = nonEmpty(record.signingPublicKey);
      if (fetched) {
        signingPub = fetched;
        const { saveContact } = require('../db/local') as typeof import('../db/local');
        const updated = { ...contact, signingPublicKeyB64: fetched };
        await saveContact(updated);
        useContacts.setState((s) => ({
          contacts: s.contacts.map(c => c.aegisId === contactAegisId ? updated : c)
        }));
      }
    } catch (e) {
      if (__DEV__) logger.warn('[socket] failed to fetch signing key from directory');
      void e;
    }
  }

  if (!signingPub) {
    // Fail fast with an actionable error. NEVER fall through with '' — that
    // would defeat X3DH SPK verification and enable a MITM-substituted SPK.
    throw new Error(
      `Cannot start secure session with ${contactAegisId}: recipient has not published an Ed25519 signing key. Ask them to re-register on a build >= signing-key-mandatory.`
    );
  }

  bundle.signingPublicKeyB64 = signingPub;
  bundle.identityKeyB64 = contactPublicKeyB64;

  const x3dh = performX3DH(identity, bundle);

  // [RDIAG] Dev-only (rdiag). Alice side: log the SPK/OPK ids she
  // committed to from the peer's bundle and a short fingerprint of the derived
  // root key. Compare against Bob's `[RDIAG] x3dh-recv` line: if the fp differs
  // the two derived DIFFERENT root keys (e.g. SPK rotated under Bob, or OPK
  // present on Alice but absent on Bob → DH4 omitted asymmetrically).
  rdiag(
    `[RDIAG] x3dh-send me=${identity.aegisId} peer=${contactAegisId} spkId=${bundle.signedPreKey.keyId} opkId=${bundle.oneTimePreKey ? bundle.oneTimePreKey.keyId : 'none'} rkFp=${rootKeyFp(x3dh.rootKey)}`,
  );

  // Hybrid PQ ratchet (R1): only seed PQ bootstrap when X3DH actually
  // negotiated v2 (bundle carried a verified PQSPK and we encapsulated to
  // it). A v1 session must stay classic — initRatchet treats any PQ param as
  // "this session is hybrid" and would then demand pqPub/pqCt on every chain
  // turn, which a v1 peer can never send.
  const initialPQr = x3dh.version === 2 && bundle.pqSignedPreKey
    ? decodeBase64(bundle.pqSignedPreKey.publicKeyB64)
    : null;
  const ratchetState = initRatchet(
    x3dh.rootKey,
    decodeBase64(bundle.signedPreKey.publicKeyB64),
    true,
    undefined,
    undefined,
    initialPQr,
  );

  // Attach Alice's Ephemeral Key and Bob's PreKey IDs for Bob's X3DH receiver calculation.
  // PQXDH (v2): when performX3DH negotiated v2 (bundle.pqSignedPreKey was present
  // and verified), it returns pqCiphertextB64 — the ML-KEM-768 ciphertext Bob
  // must decapsulate with his PQSPK secret. It rides INSIDE this already-sealed
  // init message (never as a relay-visible field). Absent ⇒ v1, omit pqCtB64.
  ratchetState.x3dhInit = {
    aliceEKB64: x3dh.myEphemeralPublicKeyB64,
    spkId: bundle.signedPreKey.keyId,
    opkId: bundle.oneTimePreKey ? bundle.oneTimePreKey.keyId : null,
    ...(x3dh.pqCiphertextB64 ? { pqCtB64: x3dh.pqCiphertextB64 } : {}),
  };

  rdiag(
    `[RDIAG] x3dh-send-version me=${identity.aegisId} peer=${contactAegisId} version=${x3dh.version} hasPqCt=${!!x3dh.pqCiphertextB64}`,
  );

  await saveSessionState(contactAegisId, ratchetState);
  return ratchetState;
}

// ─── Ratchet desync auto-recovery ────────────────────────────────────────────
//
// Two devices whose Double Ratchet sessions have permanently desynchronised
// (e.g. an emulator userdata rollback) can never decrypt each other's normal
// messages again, because normal messages never re-run X3DH. We detect this
// and proactively re-handshake.
//
// SECURITY GATE: recovery only fires when the OUTER sealed-sender box has
// already authenticated the message as coming from the real contact (NaCl box
// opened with the contact's identity pubkey + our secret). A relay cannot forge
// that, so "outerBox OK + existing session + no x3dh header + ratchetDecrypt
// null" is a non-forgeable desync signal. We never recover on an outer-box
// failure (that could be an attacker), and we never reuse old key material — the
// replacement session is a full fresh X3DH, preserving forward secrecy.
//
// ANTI-STORM: stale messages still in flight on the OLD session would keep
// failing after a reset and could re-trigger recovery forever. We guard with:
//   1. A per-contact cooldown: at most one recovery attempt per window.
//   2. A grace period: never tear down a session that was established < grace
//      ago, so a late message on the previous session can't kill the new one.
const RECOVERY_COOLDOWN_MS = 60_000;
const SESSION_GRACE_MS = 30_000;
const lastRecoveryAttemptMs = new Map<string, number>();

/**
 * Attempt automatic recovery from a permanently-desynchronised ratchet session.
 * Caller MUST have already authenticated the sender via the outer sealed-sender
 * box. Returns true if a recovery handshake was initiated (caller should treat
 * the failed message as consumed/dropped), false if recovery was suppressed by
 * the cooldown or grace guards.
 */
// ── Glare resolution (deterministic re-handshake winner) ─────────────────────
//
// When BOTH peers detect desync at nearly the same instant (e.g. both drain old
// queued messages on startup), both would tear down their session and both run a
// fresh X3DH as Alice. Each then adopts the OTHER's init (the x3dh branch always
// overwrote), so the two devices end on DIFFERENT sessions and stay desynced.
//
// We break the tie deterministically by aegisId, lexicographic compare:
//   - The peer with the HIGHER aegisId is the canonical INITIATOR. On desync it
//     deletes its session, runs a fresh X3DH and sends a recovery `init`, and
//     IGNORES any incoming recovery init from the lower peer (glare gate below).
//   - The peer with the LOWER aegisId is the NON-INITIATOR. On desync it does
//     NOT delete its session and does NOT build a new init (doing so saved a
//     session of its own that CLOBBERED the higher peer's init it was meant to
//     adopt — the infinite-loop bug). Instead it sends a NUDGE: a normal ratchet
//     message over its existing (desynced) session. That nudge fails to decrypt
//     on the higher peer, triggering the higher peer's initiator recovery, whose
//     init the lower peer then ADOPTS. No session of the lower peer's is ever
//     saved to be clobbered, so they converge deterministically.
//
// Both peers therefore converge on the single session whose Alice == higher
// aegisId. First-contact (no prior session) is unaffected: adoption gating only
// applies when a recovery is in progress for that contact.
function amInitiatorFor(myAegisId: string, peerAegisId: string): boolean {
  // Strict, stable lexicographic order. Equality is impossible (distinct peers).
  return myAegisId > peerAegisId;
}

/**
 * Per-contact marker: this contact is currently "in recovery" — we recently tore
 * down its session because of a detected desync. While set, decryptAndAppend
 * applies the deterministic glare-resolution rule when an X3DH init arrives.
 * Cleared once we successfully adopt/keep a converged session, or after the
 * recovery window elapses.
 */
const inRecoveryUntilMs = new Map<string, number>();
/** Pending recovery fallback-flush timers, keyed by peer — see disconnect(). */
const recoveryFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();
const RECOVERY_WINDOW_MS = 90_000;

// ── One-sided desync escalation (non-initiator → explicit session-reset req) ────
//
// The plain NUDGE assumes desync is SYMMETRIC: the nudge fails to decrypt on the
// higher peer, so the higher peer's own tryRecoverDesync fires and it re-keys.
// But desync can be ONE-SIDED: only the lower peer's RECEIVE chain is broken
// (e.g. its session state was rolled back / partially persisted). The lower
// peer's SEND chain still matches the higher peer's RECEIVE chain, so the nudge
// decrypts FINE on the higher peer — it never detects desync, never re-keys, and
// the lower peer is wedged forever (inbound undecryptable, outbox never flushes;
// the initiator has RECOVERY_FALLBACK_MS but the non-initiator had NO fallback).
//
// Fix (mirrors Session's / SimpleX's in-band session-reset message): after a
// bounded number of plain nudges that did not converge, the non-initiator sends
// a nudge that additionally carries an AUTHENTICATED `sessionReset` flag inside
// the encrypted payload. Because it rides inside a ratchet message that the
// higher peer successfully decrypts (MAC-verified) AND inside the outer
// sealed-sender box (sender-authenticated), it cannot be forged or replayed by
// the relay or a third party (REGLA DE ORO #3/#7 — an unauthenticated re-key
// request would be a DoS/downgrade vector). On seeing it, the higher peer runs
// its INITIATE branch (delete session + fresh X3DH) EVEN THOUGH its own decrypt
// succeeded, and the lower peer adopts that init → convergence.
//
// Reference: Session (github.com/oxen-io/session-android — "session reset" /
// libsignal SessionResetMessage) and SimpleX Chat both send an in-encrypted-
// channel control message to force a fresh handshake rather than trusting an
// unauthenticated wire signal.
const NUDGE_ATTEMPTS_BEFORE_RESET_REQUEST = 2;
/** Per-contact count of plain nudges emitted in the current recovery episode. */
const nudgeAttemptsThisEpisode = new Map<string, number>();
/**
 * After detecting a desync we send a recovery X3DH-init and a lower-aegisId peer
 * defers its outbound messages (glare avoidance). In the ASYMMETRIC case the
 * other peer simply ADOPTS our init and never sends one back, so no inbound init
 * ever arrives to trigger our outbox flush — the deferred messages would be
 * stuck forever. This short grace lets a genuine glare init arrive first
 * (clearing recovery via the adoption path); if none does, we treat our own
 * fresh session as the converged one, clear recovery, and flush.
 */
const RECOVERY_FALLBACK_MS = 6_000;

function isInRecovery(aegisId: string): boolean {
  const until = inRecoveryUntilMs.get(aegisId);
  return typeof until === 'number' && Date.now() < until;
}

/**
 * Encrypt a tiny profile_update over the peer's CURRENT (possibly desynced)
 * ratchet session and emit it WITHOUT running X3DH. This is the non-initiator's
 * "nudge": it advances/rotates the existing session (no x3dhInit ⇒ no `x3dh`
 * header on the wire) so the message is a NORMAL ratchet message. The initiator
 * peer, decrypting it against ITS own existing session, fails ratchetDecrypt and
 * — because it is the canonical initiator — runs tryRecoverDesync and sends a
 * fresh X3DH init that we then ADOPT. Crucially we never delete our session and
 * never build/save a brand-new initiator session here, so we cannot clobber the
 * initiator's session that we are about to adopt.
 *
 * Returns true if a nudge was emitted, false if there was no existing session to
 * nudge over (in which case the caller has nothing to do but wait/adopt).
 */
async function sendNudgeOverExistingSession(
  contact: { aegisId: string; publicKeyB64: string },
  identity: Identity,
  // When true, embed an authenticated `sessionReset` flag in the nudge payload so
  // the higher peer force-re-keys even if its own decrypt succeeds (one-sided
  // desync escalation — see NUDGE_ATTEMPTS_BEFORE_RESET_REQUEST).
  requestSessionReset = false,
): Promise<boolean> {
  if (!socket || !connected || !authenticated) return false;
  const existingJson = await loadRatchetSession(contact.aegisId);
  if (!existingJson) return false; // nothing to nudge over — just wait/adopt
  let session: RatchetState;
  try {
    const s = reviveRatchetState(existingJson);
    session = s as RatchetState;
  } catch {
    return false;
  }
  // Never let a stale x3dhInit ride along — a nudge must be a plain ratchet
  // message so it lands on the initiator's EXISTING session and fails decrypt
  // (the desync signal), rather than being adopted as a fresh handshake.
  delete session.x3dhInit;
  try {
    const { useIdentity } = require('../store/identity');
    const idState = useIdentity.getState();
    const payload = JSON.stringify({
      type: 'profile_update',
      senderName: idState.displayName,
      senderColor: idState.avatarColor,
      senderStatus: idState.profileStatus,
      // One-sided desync escalation: this rides INSIDE the E2EE ratchet payload,
      // so the higher peer only ever sees it after a MAC-verified decrypt — it is
      // cryptographically authenticated, never a wire-level (forgeable) field.
      ...(requestSessionReset ? { sessionReset: true } : {}),
    });
    const recipientPub = decodeBase64(contact.publicKeyB64);
    const { envelope, newState } = encryptMessage(payload, identity.aegisId, recipientPub, identity.secretKey, session);
    await saveSessionState(contact.aegisId, newState);
    socket!.emit('envelope', {
      id: Crypto.randomUUID(),
      to: contact.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
    rdiag(`[RDIAG] nudge sent me=${identity.aegisId} -> peer=${contact.aegisId} reset=${requestSessionReset}`);
    return true;
  } catch (e) {
    if (__DEV__) logger.warn('[socket] desync nudge send failed:', (e as Error).message);
    return false;
  }
}

async function tryRecoverDesync(
  contact: { aegisId: string; publicKeyB64: string },
  existingState: RatchetState | null,
  identity: Identity,
  force = false,
  // Present when called from inside decryptAndAppendLocked's session lock. The
  // initiator branch below re-handshakes via sendProfileTo → getOrCreateSession
  // for the SAME aegisId; threading the context lets that nested acquire pass
  // through the reentrant fast-path instead of deadlocking on our own gate.
  lockCtx?: LockCtx,
): Promise<boolean> {
  const now = Date.now();

  if (!force) {
    // Grace: a freshly negotiated session must not be destroyed by a stale,
    // in-flight message that belonged to the previous session.
    if (existingState && typeof existingState.createdAtMs === 'number' && now - existingState.createdAtMs < SESSION_GRACE_MS) {
      return false;
    }

    // Cooldown: collapse a burst of failing stale messages into a single attempt.
    const last = lastRecoveryAttemptMs.get(contact.aegisId);
    if (typeof last === 'number' && now - last < RECOVERY_COOLDOWN_MS) {
      return false;
    }
  }
  lastRecoveryAttemptMs.set(contact.aegisId, now);

  const initiator = amInitiatorFor(identity.aegisId, contact.aegisId);

  // [RDIAG] Dev-only (rdiag).
  rdiag(
    `[RDIAG] desync detected me=${identity.aegisId} peer=${contact.aegisId} decision=${initiator ? 'INITIATE' : 'NUDGE'}`,
  );

  // Mark in-recovery so the adoption rule applies to inbound inits for this peer.
  inRecoveryUntilMs.set(contact.aegisId, now + RECOVERY_WINDOW_MS);

  if (!initiator) {
    // ── NON-INITIATOR (lower aegisId): NUDGE, do NOT re-key ────────────────────
    // The previous "both send init" design caused a CLOBBER: the lower peer
    // deleted its session and getOrCreateSession built+SAVED a fresh
    // initiator session of its OWN (session-Lower). That overwrote the
    // higher peer's init session the lower was supposed to adopt → the two
    // diverged → every message re-triggered recovery → infinite loop.
    //
    // Fix: the lower peer KEEPS its (desynced) session and sends a NUDGE — a
    // normal ratchet message over that existing session. It cannot decrypt on
    // the higher peer (their sessions are desynced), so the higher peer's own
    // tryRecoverDesync fires and it sends a fresh X3DH init. We ADOPT that init
    // in decryptAndAppend (replacing our desynced session) → converge. Because
    // we never deleted or rebuilt our session here, there is nothing to clobber
    // the adopted init. We hold in-recovery until adoption clears it.
    // One-sided desync escalation: track how many nudges this recovery episode
    // has already emitted. After NUDGE_ATTEMPTS_BEFORE_RESET_REQUEST plain nudges
    // that did NOT converge (we are still in recovery — a genuine glare/adoption
    // would have cleared the marker and reset this counter via convergence in
    // decryptAndAppend), the desync is almost certainly ONE-SIDED: our nudge
    // decrypts fine on the higher peer so it never re-keys on its own. Escalate to
    // an AUTHENTICATED session-reset request that force-re-keys the higher peer.
    const priorAttempts = nudgeAttemptsThisEpisode.get(contact.aegisId) ?? 0;
    const requestReset = priorAttempts >= NUDGE_ATTEMPTS_BEFORE_RESET_REQUEST;
    if (requestReset) {
      rdiag(`[RDIAG] one-sided desync escalation: requesting session-reset me=${identity.aegisId} peer=${contact.aegisId} attempts=${priorAttempts}`);
    }
    const nudged = await sendNudgeOverExistingSession(contact, identity, requestReset);
    if (nudged) {
      nudgeAttemptsThisEpisode.set(contact.aegisId, priorAttempts + 1);
    }
    if (!nudged) {
      // No existing session to nudge over (rare): we cannot provoke the higher
      // peer this way. Leave the recovery marker set so any inbound init from
      // the higher peer is adopted; clear it after the window so we don't get
      // wedged. Do NOT build/save our own init (that is the clobber we avoid).
      rdiag(`[RDIAG] non-initiator no-session: waiting for higher peer's init me=${identity.aegisId} peer=${contact.aegisId}`);
    }
    // NOTE: we intentionally do NOT flush the outbox here. Flushing now would
    // emit messages over the desynced session that fail on the peer and
    // re-trigger recovery (a loop contributor). The outbox is flushed only
    // AFTER we adopt the initiator's session in decryptAndAppend (converged).
    return true;
  }

  // ── INITIATOR (higher aegisId): re-key with a fresh X3DH init ───────────────
  // Drop the dead session so getOrCreateSession runs a full fresh X3DH and
  // sendProfileTo emits an `init` envelope. The non-initiator adopts it and we
  // converge. We IGNORE any inbound init from the lower peer (glare gate in
  // decryptAndAppend) so our init is the single canonical session.
  await deleteContactRatchetSession(contact.aegisId);

  rdiag(`[RDIAG] emitting recovery init me=${identity.aegisId} -> peer=${contact.aegisId} initiator=true`);
  try {
    // Thread the lock context: this runs inside decryptAndAppendLocked's lock
    // for contact.aegisId, and sendProfileTo → getOrCreateSession re-acquires
    // the same key. Without the context that nested acquire would deadlock.
    await sendProfileTo(contact, identity, lockCtx);
  } catch (e) {
    if (__DEV__) logger.warn('[socket] desync re-handshake send failed:', (e as Error).message);
  }

  // Deadlock breaker for the asymmetric case: if the lower peer simply nudged us
  // (it is NOT in recovery on its side, or its nudge already converged it via our
  // adoption-reply), no inbound INIT arrives to flush our outbox. After a short
  // grace — long enough for a glare init from an equal-status peer to arrive and
  // converge via the adoption path (which clears recovery + flushes) — if we are
  // STILL in recovery, treat our freshly-created init session as the converged
  // one, clear recovery, and flush. The lower peer will have adopted our init.
  const peerId = contact.aegisId;
  // Track the fallback timer per peer: re-entering recovery for the same peer
  // must replace (not stack) the pending timer, and disconnect() must cancel
  // them all — a stale timer firing after disconnect would flush the outbox
  // over a dead socket and leak timer handles (which also hangs Jest in CI).
  const prevTimer = recoveryFallbackTimers.get(peerId);
  if (prevTimer) clearTimeout(prevTimer);
  const fallbackTimer = setTimeout(() => {
    recoveryFallbackTimers.delete(peerId);
    if (isInRecovery(peerId)) {
      inRecoveryUntilMs.delete(peerId);
      rdiag(`[RDIAG] recovery fallback flush me=${identity.aegisId} peer=${peerId}`);
      void flushOutbox(identity).catch(() => {});
    }
  }, RECOVERY_FALLBACK_MS);
  recoveryFallbackTimers.set(peerId, fallbackTimer);
  // Node/Jest timer handles expose `.unref()` (React Native's do not — this is a
  // no-op there, production behaviour is unchanged). Without it, this 6s
  // real-clock timer keeps the Jest worker process alive past test completion,
  // firing `rdiag`'s logger.warn after the suite has finished ("Cannot log
  // after tests are done") and destabilising whichever test runs next in the
  // same worker.
  (fallbackTimer as unknown as { unref?: () => void }).unref?.();

  return true;
}

async function saveSessionState(aegisId: string, state: RatchetState) {
  // Forward secrecy: actively shrink the skipped-key window before persisting
  // so an attacker who recovers the DB later cannot decrypt very old skipped
  // messages. The cap is already enforced inside ratchet.ts, but trimming
  // here defends against attacker-induced growth across multiple sessions.
  trimOldSkippedKeys(state, MAX_SKIPPED_KEYS);

  // Persist only the minimal next-state. Previously-consumed CKs/CKr have
  // already been overwritten by their successor via kdfChain in
  // ratchetEncrypt/ratchetDecrypt. serializeRatchetState is the single point
  // of truth for the field list (hand-rolled copies dropped the PQ fields once
  // already — see ratchetSerde.ts).
  await saveRatchetSession(aegisId, serializeRatchetState(state));
}

/**
 * Public entry: serialise inbound-message processing per contact aegisId so the
 * load+adopt path is atomic against getOrCreateSession's create+save (glare
 * fix). The lock is REENTRANT for this chain: decryptAndAppendLocked may, via
 * tryRecoverDesync → sendProfileTo → getOrCreateSession, re-acquire the SAME
 * key; the threaded LockCtx lets that nested acquire pass through instead of
 * deadlocking on its own gate.
 */
async function decryptAndAppend(
  env: WireSealedEnvelope,
  parsed: any,
  contact: any,
  identity: Identity,
): Promise<boolean> {
  return withSessionLock(
    contact.aegisId,
    (ctx) => decryptAndAppendLocked(env, parsed, contact, identity, ctx),
    undefined,
  );
}

async function decryptAndAppendLocked(
  env: WireSealedEnvelope,
  parsed: any,
  contact: any,
  identity: Identity,
  lockCtx: LockCtx,
): Promise<boolean> {
  if (parsed.from !== contact.aegisId) {
    if (__DEV__) logger.warn('[socket] sender mismatch — dropping');
    return false;
  }

  let ratchetState: RatchetState;
  // OPK to consume (delete from SecureStore) only AFTER a successful X3DH-init
  // decrypt — see the OPK handling note below. null on non-init messages.
  let consumeOpkIdAfterDecrypt: number | null = null;
  const existingJson = await loadRatchetSession(contact.aegisId);

  // ── Deterministic glare resolution (canonical session = higher aegisId) ─────
  // If an X3DH init arrives AND we already hold our OWN session for this peer AND
  // we are the canonical initiator (higher aegisId), we NEVER adopt the lower
  // peer's init. Instead we keep / (re)assert our own session as the winner: if
  // we are not already re-initiating, we force a fresh init so the lower peer
  // adopts OURS. Both peers therefore converge on the higher-aegisId session.
  //
  // This now applies on FIRST-CONTACT glare too (not only during recovery) —
  // when both peers add each other they each create an initiator session, and
  // without this the two sessions mutually adopt and never converge (the bug
  // behind "messages don't arrive / profile won't sync"). The lower peer falls
  // through to the adoption branch below and adopts our init.
  if (
    parsed.x3dh &&
    existingJson &&
    amInitiatorFor(identity.aegisId, contact.aegisId)
  ) {
    // We are the canonical winner (higher aegisId) and already hold a session.
    // Two sub-cases:
    //   (a) Our session is a still-pending init (x3dhInit set) — i.e. WE just
    //       initiated (e.g. both broadcast profile on connect = glare). Our init
    //       is in flight; the lower peer will adopt IT. We must KEEP our exact
    //       session and IGNORE theirs. Re-initiating here would mint a 2nd init
    //       that mismatches the one the lower peer already adopted — the bug that
    //       made first messages undecryptable.
    //   (b) We are mid-recovery (deliberately re-initiated after a desync). Same:
    //       keep our recovery init, ignore the lower's.
    // In BOTH, ignore the lower peer's init; ours wins and they adopt it.
    let myInitPending = false;
    try { myInitPending = !!JSON.parse(existingJson).x3dhInit; } catch { /* treat as established */ }
    if (myInitPending || isInRecovery(contact.aegisId)) {
      rdiag(
        `[RDIAG] glare: higher keeps own init, ignoring lower's me=${identity.aegisId} peer=${contact.aegisId} pending=${myInitPending} recovery=${isInRecovery(contact.aegisId)}`,
      );
      return false; // ignore the lower peer's init; ours wins
    }
    // Otherwise our session is ESTABLISHED and the lower peer is legitimately
    // re-initiating (e.g. they reinstalled / re-keyed). Fall through to adopt
    // their fresh init so we converge on their new keys.
    rdiag(`[RDIAG] established session + lower re-init → adopting (rekey) me=${identity.aegisId} peer=${contact.aegisId}`);
  }

  let loadedRatchetState: RatchetState | null = null;
  if (existingJson) {
    loadedRatchetState = reviveRatchetState(existingJson);

    // PREVENT REPLAY ATTACKS ON X3DH INIT (State Downgrade / DoS)
    // If the message contains an x3dhInit but we already have an established session,
    // we must try to decrypt it against the existing session first. If it succeeds,
    // the message is a delayed or replayed message from this existing session, NOT
    // a fresh handshake. If we were to blindly accept the x3dhInit, a replayed Message 0
    // would successfully decrypt and overwrite our advanced session, causing a state downgrade.
    if (parsed.x3dh) {
      try {
        const { cloneState } = require('../crypto/signal/ratchet') as typeof import('../crypto/signal/ratchet');
        const rHeader = parseRatchetHeader(parsed.ratchet);
        const rCiphertext = decodeBase64(parsed.ratchet.ciphertextB64);
        const rNonce = decodeBase64(parsed.ratchet.nonceB64);
        const trialState = cloneState(loadedRatchetState);
        
        // Trial decrypt - mutates trialState but leaves `loadedRatchetState` untouched.
        if (ratchetDecrypt(trialState, rHeader, rCiphertext, rNonce)) {
          // Success! This is a replay. Delete the x3dh header so we treat it as
          // a normal message under the established session.
          delete parsed.x3dh;
          rdiag(`[RDIAG] x3dh-replay-prevented: existing session successfully decrypted message with X3DH headers me=${identity.aegisId} peer=${contact.aegisId}`);
        }
      } catch {
        // Trial decrypt failed. This is expected if the sender legitimately wiped
        // their state and sent a fresh X3DH init. Fall through to the fresh X3DH adoption block.
      }
    }
  }

  if (loadedRatchetState && !parsed.x3dh) {
    ratchetState = loadedRatchetState;
  } else {
    // Bob doesn't have a session, or the sender is re-keying/starting a fresh session via X3DH setup!
    if (!parsed.x3dh) {
      rdiag(`[RDIAG] DROP no-session-no-x3dh from=${contact.aegisId} inRecovery=${isInRecovery(contact.aegisId)}`);
      if (__DEV__) logger.warn('[socket] No session and no X3DH headers received — dropping message');
      return false;
    }

    // Load PreKey secrets.
    //
    // ROOT-CAUSE FIX (fresh-session desync): Bob MUST use the EXACT SPK secret
    // whose keyId Alice committed to in her X3DH header (parsed.x3dh.spkId), not
    // simply "the latest" SPK. uploadPreKeys() rotates the SPK and increments the
    // keyId on every refill, overwriting the legacy single-slot SECURE_SPK_SECRET_KEY.
    // If Bob refilled prekeys between Alice fetching his bundle and Bob processing
    // her init, the legacy slot now holds a DIFFERENT secret than the SPK Alice
    // used → DH1/DH3 diverge → different root key → every fresh session is born
    // desynced. We persist per-keyId SPK secrets (spkSecretKey(id)); read that
    // first, fall back to the legacy slot only when the per-keyId slot is absent
    // (pre-rotation installs).
    // DURABLE STORE FIRST: read the SPK secret matching the exact keyId Alice
    // committed to from the SQLite prekey_secrets table (the new source of
    // truth). Fall back to per-keyId SecureStore, then the legacy single slot,
    // for sessions that pre-date the DB store.
    let spkSec: string | null = null;
    let spkSecFromKeyId = false;
    if (typeof parsed.x3dh.spkId === 'number') {
      spkSec = await loadSpkSecret(parsed.x3dh.spkId);
      if (!spkSec) spkSec = await SecureStore.getItemAsync(spkSecretKey(parsed.x3dh.spkId));
      spkSecFromKeyId = !!spkSec;
    }
    if (!spkSec) {
      // Last resort for legacy installs: the latest DB SPK, then the legacy slot.
      const latest = await loadLatestSpkSecret();
      spkSec = latest?.b64 ?? null;
    }
    if (!spkSec) {
      spkSec = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    }
    if (!spkSec) {
      rdiag(`[RDIAG] x3dh-recv ABORT no-spk me=${identity.aegisId} peer=${contact.aegisId} spkId=${parsed.x3dh.spkId}`);
      if (__DEV__) logger.warn('[socket] mySpkSecret not found in DB or SecureStore — cannot decrypt');
      return false;
    }
    const mySpkSecret = decodeBase64(spkSec);

    // OPK handling. Alice includes DH4 iff she received an OPK in Bob's bundle.
    // Bob MUST mirror that: if Alice committed to an opkId, Bob needs the matching
    // secret. If it is genuinely missing, continuing "without DH4" derives a root
    // key Alice never derived (she DID use DH4) → guaranteed mismatch. Treat a
    // missing-but-expected OPK as a hard abort instead of silently mis-deriving.
    //
    // FORWARD SECRECY vs CORRECTNESS: we no longer delete the OPK BEFORE deriving
    // and decrypting. The previous code consumed (deleted) the OPK up-front; if
    // the subsequent decrypt failed and the message was redelivered, the OPK was
    // already gone and the retry silently fell into the "missing OPK → no DH4"
    // mismatch branch — turning a transient failure into a permanent desync. We
    // defer deletion until AFTER a successful ratchetDecrypt (see below), keeping
    // the OPK single-use in the success path while making the handshake retryable.
    let myOpkSecret: Uint8Array | null = null;
    let opkPresent = false;
    if (parsed.x3dh.opkId !== null) {
      // DURABLE STORE FIRST, SecureStore fallback (legacy sessions).
      let opkSecBase64 = await loadOpkSecret(parsed.x3dh.opkId);
      if (!opkSecBase64) opkSecBase64 = await SecureStore.getItemAsync(opkSecretKey(parsed.x3dh.opkId));
      if (opkSecBase64) {
        myOpkSecret = decodeBase64(opkSecBase64);
        opkPresent = true;
        // Defer consumption until after a successful ratchetDecrypt so a
        // transient decrypt failure (redelivery) can retry with the same OPK
        // instead of permanently losing DH4 and desyncing.
        consumeOpkIdAfterDecrypt = parsed.x3dh.opkId;
      } else {
        rdiag(
          `[RDIAG] x3dh-recv ABORT opk-missing me=${identity.aegisId} peer=${contact.aegisId} opkId=${parsed.x3dh.opkId} — Alice used DH4, Bob cannot; would desync`,
        );
        if (__DEV__) logger.warn('[socket] OPK secret missing for keyId', parsed.x3dh.opkId, '— aborting (would desync)');
        return false;
      }
    }

    // PQXDH (v2) downgrade decision. weAdvertisedPq reflects whether THIS device
    // has an active PQSPK slot. shouldUsePqReceiver now FALLS BACK to 'v1' (no
    // longer throws) when we advertised PQ but the inbound init carries no
    // ciphertext — a hard abort there broke every handshake from a v1 sender or
    // whenever our bundle lacked the PQSPK. v1 is still full X25519 E2EE.
    const pqCtB64 = (parsed.x3dh as { pqCtB64?: string }).pqCtB64;
    let weAdvertisedPq = false;
    try {
      weAdvertisedPq = (await getPqSpkKeyId()) !== null;
    } catch { /* treat as not advertised */ }
    const pqDecision = shouldUsePqReceiver(weAdvertisedPq, !!pqCtB64);

    // Local-only observability: if we advertised PQ yet got no ciphertext, this
    // handshake silently downgraded to v1. Count it on-device (never sent to the
    // relay) so a sustained spike — attack OR a bundle-publish regression — is
    // observable. Fire-and-forget: must never block or fail the decrypt path.
    if (weAdvertisedPq && !pqCtB64) {
      void useSecurityDiagnostics.getState().recordPqDowngrade();
    }

    let pqInputs: { cipherText: Uint8Array; pqSpkSecret: Uint8Array } | null = null;
    if (pqDecision === 'v2') {
      const pqKeyId = await getPqSpkKeyId();
      const pqSecB64 = pqKeyId !== null ? await loadPqSpkSecret(pqKeyId) : null;
      if (!pqSecB64) {
        rdiag(`[RDIAG] x3dh-recv ABORT pqspk-missing me=${identity.aegisId} peer=${contact.aegisId} pqKeyId=${pqKeyId ?? 'none'}`);
        if (__DEV__) logger.warn('[socket] PQSPK secret not found for active keyId — cannot complete v2 handshake');
        return false;
      }
      pqInputs = { cipherText: decodeBase64(pqCtB64!), pqSpkSecret: decodeBase64(pqSecB64) };
    }

    // Calculate shared secret using performX3DHReceiver
    const senderPubKey = decodeBase64(contact.publicKeyB64);
    const rootKey = performX3DHReceiver(
      identity,
      mySpkSecret,
      myOpkSecret,
      senderPubKey,
      decodeBase64(parsed.x3dh.aliceEKB64),
      pqInputs,
    );

    // [RDIAG] Dev-only (rdiag). Bob side: log presence of each secret
    // and the derived root-key fingerprint. Compare rkFp against Alice's
    // `[RDIAG] x3dh-send`. Equal fp ⇒ symmetric derivation (fix working);
    // different fp ⇒ which input diverged (spkFromKeyId / opkPresent narrow it).
    rdiag(
      `[RDIAG] x3dh-recv me=${identity.aegisId} peer=${contact.aegisId} spkId=${parsed.x3dh.spkId} spkFromKeyId=${spkSecFromKeyId} opkId=${parsed.x3dh.opkId ?? 'none'} opkPresent=${opkPresent} pqVersion=${pqDecision} rkFp=${rootKeyFp(rootKey)}`,
    );

    // Initialize Double Ratchet as Bob (Receiver).
    // MUST pass mySpkSecret as DHs so dhRatchet computes the same DH output as Alice:
    //   DH(bobSPK.sec, alice.DHs.pub) == DH(alice.DHs.sec, bobSPK.pub)
    // A random pair here produces a wrong CKr → wrong message key → silent null from secretbox.open.
    const spkPublicKey = nacl.scalarMult.base(mySpkSecret);
    // Hybrid PQ ratchet (R1) bootstrap: when this handshake negotiated v2,
    // seed our PQSPK keypair as the ratchet's initial PQs (mirrors mySpkSecret
    // for DHs above). pqInputs is only set when pqDecision === 'v2'.
    const initialPQs = pqInputs
      ? { publicKey: ml_kem768.getPublicKey(pqInputs.pqSpkSecret), secretKey: pqInputs.pqSpkSecret }
      : null;
    ratchetState = initRatchet(rootKey, decodeBase64(parsed.ratchet.ratchetKeyB64), false, {
      publicKey: spkPublicKey,
      secretKey: mySpkSecret,
    }, initialPQs);

    // [RDIAG] Dev-only (rdiag). Adopting an inbound X3DH init.
    // Logs whether this replaced an existing (recovery) session — the convergence
    // signal we want to confirm on-device: the WAITING (lower) peer should adopt
    // the initiator's session here.
    rdiag(
      `[RDIAG] adopting inbound init me=${identity.aegisId} peer=${contact.aegisId} replacedExisting=${!!existingJson} inRecovery=${isInRecovery(contact.aegisId)}`,
    );
    // Converged: clear the recovery marker so stale in-flight messages on the old
    // session (now within grace via createdAtMs) don't re-trigger recovery.
    const wasInRecovery = isInRecovery(contact.aegisId);
    inRecoveryUntilMs.delete(contact.aegisId);
    // Converged: reset the one-sided-desync escalation counter so a future,
    // unrelated desync episode starts again with plain nudges before escalating.
    nudgeAttemptsThisEpisode.delete(contact.aegisId);
    // Bidirectional profile sync: as the responder we just adopted the initiator's
    // session and (if their init carried a profile_update) applied THEIR profile.
    // But the initiator ignored OUR init (glare rule), so it never got our profile.
    // Reply with our profile under the now-converged session — a regular message,
    // not an init, so it cannot re-trigger adoption and cannot loop. This is what
    // makes name/avatar sync both ways on first contact.
    setTimeout(() => { void sendProfileTo(contact, identity).catch(() => {}); }, 300);
    // Drain any messages the waiting peer deferred while it had no session.
    if (wasInRecovery) {
      // Persist this adopted session first so flushOutbox reuses it instead of
      // building yet another init. saveSessionState runs below after decrypt; we
      // schedule the flush on the next tick so it sees the persisted state.
      setTimeout(() => { void flushOutbox(identity); }, 0);
    }
  }

  // Now decrypt the message body using the Double Ratchet session.
  // Hybrid PQ ratchet (R1): parseRatchetHeader forwards pqPub/pqCt — a hybrid
  // receiver treats their absence on a chain turn as a downgrade attack and
  // rejects the message (see dhRatchet in signal/ratchet.ts). A hand-rolled
  // header here that dropped them broke every fresh v2 handshake with
  // "missing PQ material on hybrid session".
  const rHeader = parseRatchetHeader(parsed.ratchet);
  const rCiphertext = decodeBase64(parsed.ratchet.ciphertextB64);
  const rNonce = decodeBase64(parsed.ratchet.nonceB64);

  // A desync can surface either as a null result (MAC failure on a wrong message
  // key) OR as a throw (e.g. "Too many skipped messages" / low-order DH). Both,
  // on an EXISTING non-x3dh session, are non-forgeable desync signals because the
  // outer sealed-sender box already authenticated the sender. ratchetDecrypt is
  // transactional, so a throw leaves the live state untouched.
  let plaintextBytes: Uint8Array | null;
  try {
    plaintextBytes = ratchetDecrypt(ratchetState, rHeader, rCiphertext, rNonce);
  } catch (e) {
    if (existingJson && !parsed.x3dh) {
      if (__DEV__) logger.warn('[socket] ratchetDecrypt threw on existing session:', (e as Error).message);
      await tryRecoverDesync(contact, ratchetState, identity, false, lockCtx);
    } else if (__DEV__) {
      logger.warn('[socket] Double Ratchet decryption threw:', (e as Error).message);
    }
    return false;
  }
  if (!plaintextBytes) {
    // [RDIAG] MAC-failure forensics: which session state rejected which header.
    rdiag(
      `[RDIAG] ratchet-null me=${identity.aegisId} peer=${contact.aegisId} hdr(n=${rHeader.n} pn=${rHeader.pn} pq=${!!rHeader.pqPub}) st(Ns=${ratchetState.Ns} Nr=${ratchetState.Nr} hasCKr=${!!ratchetState.CKr} hybrid=${!!ratchetState.PQs} ageMs=${ratchetState.createdAtMs ? Date.now() - ratchetState.createdAtMs : -1}) x3dh=${!!parsed.x3dh} existing=${!!existingJson}`,
    );
    // Desync auto-recovery: we get here only because the OUTER sealed-sender box
    // already authenticated this as a genuine message from `contact` (the caller
    // path opened it with the contact's identity key). If we were decrypting
    // against an EXISTING session (not an X3DH init) and the Double Ratchet still
    // returns null, the two sessions are permanently desynchronised. Re-handshake.
    // We do NOT recover on an x3dh-init failure: that points to a key/handshake
    // problem, not a recoverable desync.
    if (existingJson && !parsed.x3dh) {
      await tryRecoverDesync(contact, ratchetState, identity, false, lockCtx);
    } else if (__DEV__) {
      logger.warn('[socket] Double Ratchet decryption failed');
    }
    return false;
  }

  // Handshake succeeded and the first message authenticated: NOW consume the
  // one-time prekey so it is single-use. Deferring to here (rather than before
  // derivation) means a transient/redelivered init can retry with the same OPK
  // instead of permanently losing DH4 — the consumption-before-success race that
  // turned a recoverable failure into a permanent fresh-session desync.
  if (consumeOpkIdAfterDecrypt !== null) {
    const opkId = consumeOpkIdAfterDecrypt;
    // Delete from the durable store (source of truth) AND the SecureStore cache.
    try { await deleteOpkSecret(opkId); } catch { /* best-effort */ }
    try {
      await SecureStore.deleteItemAsync(opkSecretKey(opkId));
    } catch { /* best-effort — OPK may already be absent on retry */ }
  }

  const body = encodeUTF8(plaintextBytes);

  let finalBody = body;
  let parsedPayload: any = null;
  try {
    if (body.startsWith('{')) {
      parsedPayload = JSON.parse(body);

      // Profile-only broadcast: peer renamed/recolored/status — apply silently, do
      // NOT append a chat message. Still persist ratchet state.
      if (parsedPayload.type === 'profile_update') {
        // One-sided desync escalation (mirrors Session/SimpleX in-band session
        // reset): the peer's RECEIVE chain is broken but its SEND chain still
        // matches ours, so THIS message decrypted fine and our own desync detector
        // never fired. The `sessionReset` flag — authenticated by this successful
        // MAC-verified decrypt AND the outer sealed-sender box, never a forgeable
        // wire field — explicitly asks us to re-key. Only the canonical initiator
        // (higher aegisId) may mint the winning init; if WE are the higher peer we
        // force-run the INITIATE branch (delete + fresh X3DH) even though decrypt
        // succeeded. If we are the lower peer we ignore it (the requester should be
        // adopting OUR init, not the reverse) to avoid a re-key ping-pong.
        if (parsedPayload.sessionReset === true) {
          if (amInitiatorFor(identity.aegisId, contact.aegisId)) {
            rdiag(`[RDIAG] honoring authenticated session-reset request me=${identity.aegisId} peer=${contact.aegisId}`);
            // Persist the current (still-working) state first so the pre-reset
            // profile update above isn't lost, then force a fresh handshake.
            await saveSessionState(contact.aegisId, ratchetState);
            await tryRecoverDesync(contact, ratchetState, identity, true, lockCtx);
            return true;
          }
          rdiag(`[RDIAG] ignoring session-reset request (we are non-initiator) me=${identity.aegisId} peer=${contact.aegisId}`);
        }
        if (parsedPayload.senderName) {
          await useContacts.getState().updateContactProfile(
            contact.aegisId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            parsedPayload.senderImage ?? undefined,
            parsedPayload.senderStatus ?? undefined
          );
        }
        // Sealed-sender v2: store the contact's delivery token (shared inside
        // this E2EE profile) so we can present it when sending them v2 envelopes.
        if (typeof parsedPayload.deliveryToken === 'string' && parsedPayload.deliveryToken) {
          try { await setContactDeliveryToken(contact.aegisId, parsedPayload.deliveryToken); } catch { /* non-fatal */ }
        }
        // Fase 4: store the contact's mailbox root (shared inside this E2EE
        // profile) so we can derive their per-epoch mailbox id when addressing
        // them. setContactMailboxRoot ignores malformed input.
        if (typeof parsedPayload.mailboxRoot === 'string' && parsedPayload.mailboxRoot) {
          try { await setContactMailboxRoot(contact.aegisId, parsedPayload.mailboxRoot); } catch { /* non-fatal */ }
        }
        await saveSessionState(contact.aegisId, ratchetState);
        return true;
      }

      if (parsedPayload.type === 'msg_delete') {
        if (typeof parsedPayload.text === 'string' && parsedPayload.text) {
          // If the retraction specifies a groupId, use it as the chatId (so group
          // messages can be deleted). Otherwise default to contact.aegisId (1:1 chat).
          const targetChatId = (typeof parsedPayload.groupId === 'string' && parsedPayload.groupId)
            ? parsedPayload.groupId
            : contact.aegisId;
          await useMessages.getState().remoteDelete(targetChatId, parsedPayload.text, contact.aegisId);
        }
        await saveSessionState(contact.aegisId, ratchetState);
        return true;
      }

      // E2EE read receipt (mailbox mode): the peer reports having read some of
      // our messages. payload.text = JSON array of msgIds. Rides the sealed
      // channel so the relay never sees the me↔to aegisId edge (which the old
      // plaintext `msg:read` event handed over on the control-plane socket,
      // relinking the two identities mailbox mode exists to separate). Apply
      // silently; do NOT append a chat row. Still persist ratchet state.
      if (parsedPayload.type === 'read_receipt') {
        if (typeof parsedPayload.text === 'string' && parsedPayload.text) {
          try {
            const ids: unknown = JSON.parse(parsedPayload.text);
            if (Array.isArray(ids)) {
              const msgs = useMessages.getState();
              for (const id of ids) {
                if (typeof id === 'string' && id) {
                  void msgs.updateDelivery(contact.aegisId, id, 'read');
                }
              }
            }
          } catch { /* malformed receipt payload — ignore */ }
        }
        await saveSessionState(contact.aegisId, ratchetState);
        return true;
      }

      // E2EE typing indicator (mailbox mode): the peer reports composing/stopping.
      // payload.text = JSON {isTyping}. Rides the sealed channel so the relay never
      // sees the me↔to aegisId edge (the plaintext `typing` event would relink the
      // two identities mailbox mode separates). The authenticated sender is the
      // sealed-sender contact.aegisId, never a forgeable payload field. Apply to
      // the transient typing store; do NOT append a chat row. Still persist ratchet
      // state. Best-effort + latent — the 5 s auto-clear covers a lost/late stop.
      if (parsedPayload.type === 'typing') {
        try {
          const parsed = JSON.parse(parsedPayload.text as string) as { isTyping?: boolean };
          const isTyping = parsed.isTyping === true;
          const { useTyping } = require('../store/typing') as typeof import('../store/typing');
          useTyping.getState().setTyping(contact.aegisId, isTyping);
          if (isTyping) {
            setTimeout(() => useTyping.getState().setTyping(contact.aegisId, false), 5000);
          }
        } catch { /* malformed typing payload — ignore */ }
        await saveSessionState(contact.aegisId, ratchetState);
        return true;
      }

      if (parsedPayload.type === 'group_msg') {
        const groupId: string = parsedPayload.groupId;
        const claimedName: string = parsedPayload.groupName;
        // MUST use the mathematically-authenticated sender from the sealed sender
        // channel, NOT the forgeable field in the JSON payload, to prevent spoofing.
        const senderId: string = contact.aegisId;
        const msgBody: string = parsedPayload.body;
        const claimedMembers: string[] = parsedPayload.members ?? [senderId, identity.aegisId];
        const claimedAdminId: string | undefined = parsedPayload.adminId;
        const claimedAdminSig: string | undefined = parsedPayload.adminSig;
        const claimedCreatedAt: number | undefined = parsedPayload.groupCreatedAt;

        // ── v1 vs v2 detection ─────────────────────────────────────────────────
        // v2 (roster-by-reference, large groups) is identified by the presence
        // of `rosterHash`. A v2 message is either a CARRIER (also carries the
        // full `members` list) or CONTENT (no `members`, roster referenced only
        // by hash). v1 messages always inline `members` and never set rosterHash.
        const claimedRosterHash: string | undefined =
          typeof parsedPayload.rosterHash === 'string' ? parsedPayload.rosterHash : undefined;
        const claimedRosterVersion: number =
          typeof parsedPayload.rosterVersion === 'number' ? parsedPayload.rosterVersion : 1;
        const isV2 = claimedRosterHash !== undefined;
        const hasMembers = Array.isArray(parsedPayload.members);

        // Resolve the admin's Ed25519 signing public key. If admin is the
        // sender we have it from the contact row; otherwise look it up in
        // the contacts store. If we can't find a key, the signature can't be
        // verified and we MUST NOT trust the metadata.
        // Resolve a contact's Ed25519 signing key, backfilling from the directory
        // when missing. Contacts added via a QR / invite link carry only the box
        // (X25519) key — the signing key lives in the directory — so without this
        // backfill an admin-signed group carrier fails verification and the group
        // never materializes for a member who joined via link. Mirrors the X3DH
        // signing-key backfill above.
        async function resolveSigningKey(aegisId: string, known?: string | null): Promise<string | null> {
          if (typeof known === 'string' && known.length > 0) return known;
          try {
            const { lookupIdentity } = require('../api') as typeof import('../api');
            const record = await lookupIdentity(aegisId);
            const fetched = typeof record.signingPublicKey === 'string' && record.signingPublicKey.length > 0
              ? record.signingPublicKey
              : null;
            if (fetched) {
              const existing = useContacts.getState().contacts.find((c) => c.aegisId === aegisId);
              if (existing && !existing.signingPublicKeyB64) {
                const { saveContact } = require('../db/local') as typeof import('../db/local');
                const updated = { ...existing, signingPublicKeyB64: fetched };
                await saveContact(updated);
                useContacts.setState((s) => ({
                  contacts: s.contacts.map((c) => (c.aegisId === aegisId ? updated : c)),
                }));
              }
            }
            return fetched;
          } catch {
            return null; // offline / not in directory — caller fails closed
          }
        }

        async function getAdminSigningKey(): Promise<string | null> {
          if (!claimedAdminId) return null;
          if (claimedAdminId === senderId) return resolveSigningKey(claimedAdminId, contact.signingPublicKeyB64);
          // Never resolve/auto-add the local user's own identity as a "group
          // admin contact" — a buggy or adversarial group could claim the
          // local aegisId as its admin, which would otherwise silently create
          // a self-contact row (store guard in contacts.ts also rejects this,
          // but skip the lookup entirely here so we never even attempt it).
          if (claimedAdminId === identity.aegisId) return null;
          let admin = useContacts.getState().contacts.find((c) => c.aegisId === claimedAdminId);
          if (!admin) {
            try {
              admin = await useContacts.getState().addByAegisId(claimedAdminId);
            } catch (e) {
              if (__DEV__) logger.warn('[socket] failed to dynamically resolve group admin:', e);
            }
          }
          return resolveSigningKey(claimedAdminId, admin?.signingPublicKeyB64);
        }

        // v1 authenticity: signature over the inlined member list.
        async function metadataIsAuthentic(): Promise<boolean> {
          if (!claimedAdminId || !claimedAdminSig || typeof claimedCreatedAt !== 'number') return false;
          const pub = await getAdminSigningKey();
          if (!pub) return false;
          return verifyGroupMetadata(
            { groupId, groupName: claimedName, members: claimedMembers, createdAt: claimedCreatedAt },
            claimedAdminSig,
            pub,
          );
        }

        // v2 authenticity: signature over the roster HASH + version. The members
        // list (if present, e.g. a carrier) is checked separately against the
        // hash before this — verify-before-trust.
        async function metadataIsAuthenticV2(rosterHash: string, rosterVersion: number): Promise<boolean> {
          if (!claimedAdminId || !claimedAdminSig || typeof claimedCreatedAt !== 'number') return false;
          const pub = await getAdminSigningKey();
          if (!pub) return false;
          return verifyGroupMetadataV2(
            { groupId, groupName: claimedName, rosterHash, rosterVersion, createdAt: claimedCreatedAt },
            claimedAdminSig,
            pub,
          );
        }

        // Avatar fields sent by the admin — not part of the Ed25519-signed
        // canonical bytes (those cover name/members/createdAt only), but we
        // gate updates on isAdmin below to prevent spoofing by non-admins.
        const claimedAvatarColor: string | undefined = parsedPayload.groupAvatarColor ?? undefined;
        const claimedAvatarImage: string | null = parsedPayload.groupAvatarImage ?? null;

        const { getGroup, saveGroup } = require('../db/local');
        const existingGroup = await getGroup(groupId);

        // ── Group dissolution (admin only, signature-gated) ────────────────────
        // Wire shape: { dissolved: true, dissolveAdminId, dissolveSig } riding a
        // `[group:dissolved]` carrier body. Honored ONLY if:
        //   1. We actually have this group locally (nothing to dissolve otherwise).
        //   2. The envelope's sealed-sender-authenticated senderId IS the group's
        //      CURRENT adminId (existingGroup.adminId) — same isAdmin gate as
        //      roster/name/avatar updates below. A former/never-admin, or the
        //      admin of a DIFFERENT group, cannot trigger this.
        //   3. dissolveAdminId (the claimed signer) also equals existingGroup.adminId
        //      — mirrors the double-check (claimedAdminId === existingGroup.adminId)
        //      used by the v1 metadata-update gate.
        //   4. verifyGroupDissolve succeeds against the admin's REAL signing key
        //      (resolved the same way as every other admin-signed field — never
        //      trust a signing key embedded in the payload itself).
        // On success: wipe the group locally exactly like leaveGroup (messages +
        // group record + in-memory chat state) for the RECEIVING member. Non-admin
        // or bad-signature dissolve attempts are silently ignored — the group and
        // its messages are left completely untouched.
        if (
          parsedPayload.dissolved === true &&
          existingGroup &&
          existingGroup.adminId &&
          senderId === existingGroup.adminId &&
          parsedPayload.dissolveAdminId === existingGroup.adminId
        ) {
          const dissolveSig: string | undefined =
            typeof parsedPayload.dissolveSig === 'string' ? parsedPayload.dissolveSig : undefined;
          const adminPub = await resolveSigningKey(existingGroup.adminId, contact.signingPublicKeyB64);
          const dissolveIsAuthentic =
            !!dissolveSig &&
            !!adminPub &&
            verifyGroupDissolve(
              { groupId, adminId: existingGroup.adminId, createdAt: existingGroup.createdAt },
              dissolveSig,
              adminPub,
            );
          if (dissolveIsAuthentic) {
            const { deleteContactMessages, deleteGroup } = require('../db/local');
            await deleteContactMessages(groupId);
            await deleteGroup(groupId);
            const { useGroups } = require('../store/groups');
            useGroups.setState((s: { groups: Array<{ id: string }> }) => ({
              groups: s.groups.filter((g) => g.id !== groupId),
            }));
            const { useMessages } = require('../store/messages');
            useMessages.getState().clearChat(groupId);
            await saveSessionState(contact.aegisId, ratchetState);
            return true;
          }
          if (__DEV__) logger.warn('[socket] group dissolve rejected — invalid or missing signature');
          // Fall through — treat as an ordinary (untrusted) metadata message so
          // the rest of the pipeline behaves exactly as if `dissolved` were absent.
        }

        if (isV2) {
          // ── v2 path: roster by reference ──────────────────────────────────────
          // The verify-before-trust decision is a PURE function
          // (groupMetadataDecision.ts); resolve the admin key here (I/O) and then
          // execute the same side effects the decision implies. Behaviour is
          // identical to the inline logic this replaced.
          const rosterHash = claimedRosterHash as string;
          // Resolve the admin key ONLY when the original code would have — i.e.
          // when a signature actually gets verified. getAdminSigningKey() can add
          // the admin as a contact, so calling it on the cheap early-exit paths
          // (drop / hash-mismatch reject) would be a behavioural change. The cheap
          // gates below mirror exactly when metadataIsAuthenticV2 used to run.
          const isCarrierV2 = hasMembers;
          const hashMatchesV2 = isCarrierV2 && computeRosterHash(claimedMembers) === rosterHash;
          const isAdminV2 =
            !!existingGroup &&
            !!existingGroup.adminId &&
            senderId === existingGroup.adminId &&
            claimedAdminId === existingGroup.adminId;
          // Mirror the exact short-circuit order of the old metadataIsAuthenticV2
          // call sites: unknown+carrier needs hashOk; existing+carrier needs
          // hashOk && isAdmin; existing+content always verifies.
          const sigCouldMatter = existingGroup
            ? isCarrierV2
              ? hashMatchesV2 && isAdminV2
              : true
            : hashMatchesV2;
          const adminSigningKeyB64 = sigCouldMatter ? await getAdminSigningKey() : null;
          const decision = decideV2GroupMetadata({
            existing: existingGroup
              ? {
                  adminId: existingGroup.adminId,
                  members: existingGroup.members,
                  name: existingGroup.name,
                  rosterVersion: existingGroup.rosterVersion,
                }
              : null,
            localAegisId: identity.aegisId,
            senderId,
            claimed: {
              groupId,
              groupName: claimedName,
              createdAt: claimedCreatedAt,
              members: hasMembers ? claimedMembers : undefined,
              adminId: claimedAdminId,
              adminSig: claimedAdminSig,
              rosterHash,
              rosterVersion: claimedRosterVersion,
            },
            adminSigningKeyB64,
          });

          switch (decision.kind) {
            case 'drop':
              // v2 content for an unknown group — await the carrier.
              if (__DEV__) logger.warn('[socket] v2 content for unknown group dropped — awaiting carrier');
              await saveSessionState(contact.aegisId, ratchetState);
              return true;

            case 'reject':
              // Carrier failed hash↔roster, signature, or membership checks.
              if (__DEV__) logger.warn('[socket] v2 carrier create rejected — hash/sig/membership check failed');
              return false;

            case 'createGroup': {
              const localAvatarImage = claimedAvatarImage
                ? await saveGroupAvatarToFile(groupId, claimedAvatarImage)
                : undefined;
              await saveGroup({
                id: groupId,
                name: decision.name,
                members: decision.members,
                createdAt: decision.createdAt,
                adminId: decision.adminId,
                adminSig: decision.adminSig,
                avatarColor: claimedAvatarColor,
                avatarImage: localAvatarImage,
                rosterVersion: decision.rosterVersion,
                // Consent gate: hold as a pending invite if our privacy setting
                // requires approval before joining a group someone added us to.
                pending: usePreferences.getState().requireGroupApproval || undefined,
              });
              const { useGroups } = require('../store/groups');
              void useGroups.getState().hydrate();
              break;
            }

            case 'updateRoster': {
              let localAvatarImage = existingGroup.avatarImage;
              if (claimedAvatarImage) {
                localAvatarImage = await saveGroupAvatarToFile(groupId, claimedAvatarImage);
              }
              await saveGroup({
                ...existingGroup,
                name: decision.name,
                members: decision.members,
                adminSig: decision.adminSig,
                avatarColor: claimedAvatarColor ?? existingGroup.avatarColor,
                avatarImage: localAvatarImage,
                rosterVersion: decision.rosterVersion,
              });
              const { useGroups } = require('../store/groups');
              void useGroups.getState().hydrate();
              break;
            }

            case 'updateNameOnly': {
              await saveGroup({ ...existingGroup, name: decision.name, adminSig: decision.adminSig });
              const { useGroups } = require('../store/groups');
              void useGroups.getState().hydrate();
              break;
            }

            case 'renderOnly':
              // No metadata change — fall through and render the body with the
              // local roster (matches the v2 carrier/content no-op branches).
              break;
          }
        } else if (!existingGroup) {
          // ── v1 path (unchanged): create ───────────────────────────────────────
          // New group: require a valid admin signature before persisting.
          // Without this an attacker could add us to arbitrary groups by
          // crafting a group_msg with chosen groupId/members/name.
          if (!(await metadataIsAuthentic())) {
            if (__DEV__) logger.warn('[socket] group_msg create rejected — invalid or missing adminSig');
            return false;
          }
          // We must also be in the member list — otherwise this group isn't
          // actually for us (silently drop).
          if (!claimedMembers.includes(identity.aegisId)) {
            if (__DEV__) logger.warn('[socket] group_msg create rejected — local id not in members');
            return false;
          }
          // Persist avatar image to documentDirectory so it survives restarts.
          const localAvatarImage = claimedAvatarImage
            ? await saveGroupAvatarToFile(groupId, claimedAvatarImage)
            : undefined;
          await saveGroup({
            id: groupId,
            name: claimedName,
            members: claimedMembers,
            createdAt: claimedCreatedAt as number,
            adminId: claimedAdminId,
            adminSig: claimedAdminSig,
            avatarColor: claimedAvatarColor,
            avatarImage: localAvatarImage,
            // Consent gate (see v2 createGroup above).
            pending: usePreferences.getState().requireGroupApproval || undefined,
          });
          const { useGroups } = require('../store/groups');
          void useGroups.getState().hydrate();
        } else {
          // ── v1 path (unchanged): update ───────────────────────────────────────
          // Existing group: only the original admin may rotate name/members/avatar.
          // Anyone else may post messages but their metadata fields are ignored.
          const isAdmin =
            !!existingGroup.adminId &&
            senderId === existingGroup.adminId &&
            claimedAdminId === existingGroup.adminId;

          const nameChanged = claimedName !== existingGroup.name;
          const membersChanged =
            JSON.stringify([...claimedMembers].sort()) !== JSON.stringify([...existingGroup.members].sort());
          const avatarColorChanged = claimedAvatarColor !== undefined && claimedAvatarColor !== existingGroup.avatarColor;
          const avatarImageChanged = claimedAvatarImage !== null;

          const metadataChanged = nameChanged || membersChanged || avatarColorChanged || avatarImageChanged;

          if (metadataChanged && isAdmin && (await metadataIsAuthentic())) {
            let localAvatarImage = existingGroup.avatarImage;
            if (avatarImageChanged && claimedAvatarImage) {
              localAvatarImage = await saveGroupAvatarToFile(groupId, claimedAvatarImage);
            }
            await saveGroup({
              ...existingGroup,
              name: claimedName,
              members: claimedMembers,
              adminSig: claimedAdminSig,
              avatarColor: claimedAvatarColor ?? existingGroup.avatarColor,
              avatarImage: localAvatarImage,
            });
            const { useGroups } = require('../store/groups');
            void useGroups.getState().hydrate();
          } else if (nameChanged || membersChanged) {
            if (__DEV__) logger.warn('[socket] group metadata change ignored — sender not admin or sig invalid');
          }
        }

        // ── Governance (roles + permissions) — Phase 2b ────────────────────────
        // Apply owner-signed governance independently of the roster decision
        // above. Pure verify-before-trust + anti-rollback decision lives in
        // groupMetadataDecision.ts; we only resolve the owner key (I/O) and
        // persist on 'apply'. Re-reads the freshly-persisted group so it layers
        // on top of any roster create/update just applied.
        {
          const claimedGovSig: string | undefined =
            typeof parsedPayload.govSig === 'string' ? parsedPayload.govSig : undefined;
          const claimedGovVersion: number | undefined =
            typeof parsedPayload.govVersion === 'number' ? parsedPayload.govVersion : undefined;
          const claimedPermissions = parsedPayload.permissions as GroupPermissions | undefined;
          if (claimedGovSig && claimedGovVersion !== undefined && claimedPermissions) {
            const govGroup = await getGroup(groupId);
            if (govGroup) {
              const ownerKey =
                govGroup.adminId && govGroup.adminId === claimedAdminId
                  ? await getAdminSigningKey()
                  : null;
              const govDecision = decideGovernanceUpdate({
                groupId,
                trustedAdminId: govGroup.adminId,
                localGovVersion: govGroup.govVersion ?? 0,
                claimed: {
                  admins: Array.isArray(parsedPayload.admins) ? parsedPayload.admins : [],
                  moderators: Array.isArray(parsedPayload.moderators) ? parsedPayload.moderators : [],
                  permissions: claimedPermissions,
                  govSig: claimedGovSig,
                  govVersion: claimedGovVersion,
                },
                ownerSigningKeyB64: ownerKey,
              });
              if (govDecision.kind === 'apply') {
                await saveGroup({
                  ...govGroup,
                  admins: govDecision.admins.length ? govDecision.admins : undefined,
                  moderators: govDecision.moderators.length ? govDecision.moderators : undefined,
                  permissions: govDecision.permissions,
                  govSig: govDecision.govSig,
                  govVersion: govDecision.govVersion,
                });
                const { useGroups } = require('../store/groups');
                void useGroups.getState().hydrate();
              } else if (govDecision.kind === 'reject' && __DEV__) {
                logger.warn('[socket] group governance rejected — invalid signature');
              }
            }
          }
        }

        // Use the locally-trusted name for display, not the claimed one.
        const trustedGroup = existingGroup ?? (await getGroup(groupId));
        const trustedGroupName: string = trustedGroup?.name ?? claimedName;

        // Dynamically update sender contact details
        if (parsedPayload.senderName) {
          void useContacts.getState().updateContactProfile(
            senderId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            parsedPayload.senderImage
          );
        }

        // ── Vote intercept ─────────────────────────────────────────────────────
        // Wire format: [vote:<pollId>:<optionIndex>:<commitment>:<nonceHex>]
        // Never shown as a chat bubble.
        // The senderId present in the outer group_msg payload is intentionally
        // NOT used to attribute the vote — anonymity is enforced by the
        // commitment scheme (sha256(aegisId + pollId + nonceHex)) which lets
        // receivers deduplicate without learning who voted for what.
        // ── Metadata-only sync intercept ───────────────────────────────────────
        // The admin's name/members/avatar change was already applied above (the
        // metadata block runs for every group_msg). This body carries nothing to
        // render, so suppress the bubble — mirrors skipLocalAppend on the sender.
        if (msgBody === GROUP_META_SYNC_BODY) {
          await saveSessionState(contact.aegisId, ratchetState);
          return true;
        }

        // ── Pending-invite suppression ─────────────────────────────────────────
        // While a group is an unaccepted invitation (requireGroupApproval), we
        // keep its metadata fresh (handled above) but render NO content — no
        // bubble, no unread bump — until the user accepts. trustedGroup was just
        // re-read post-metadata, so this reflects the current pending state.
        if (trustedGroup?.pending) {
          await saveSessionState(contact.aegisId, ratchetState);
          return true;
        }

        if (msgBody.startsWith('[vote:') && msgBody.endsWith(']')) {
          const inner = msgBody.slice(6, -1); // strip '[vote:' and ']'
          const parts = inner.split(':');
          // Support both old 2-part format (no commitment) and new 4-part format.
          if (parts.length >= 2) {
            const voteMessageId = parts[0];
            const voteOptionIndex = parseInt(parts[1], 10);
            const commitment = parts.length >= 4 ? `${parts[2]}` : `legacy:${inner}`;
            if (voteMessageId && Number.isFinite(voteOptionIndex)) {
              const { usePollsStore } = require('../store/polls');
              usePollsStore.getState().receiveVote(voteMessageId, voteOptionIndex, commitment);
            }
          }
          await saveSessionState(contact.aegisId, ratchetState);
          return true;
        }

        // ── Media detection for group messages ─────────────────────────────────
        // Mirrors the same format-detection logic used for direct_msg below, but
        // runs here so we save the correct type/mediaUri before early-returning.
        // saveMediaToCache is a function declaration (hoisted) defined later in
        // this same async scope — accessible here without forward-reference issues.
        let groupMsgType: string = 'text';
        let groupMsgMediaUri: string | null = null;
        let cleanMsgBody = msgBody;
        let groupMsgAttachments: import('../db/local').Attachment[] | null = null;

        if (msgBody.startsWith('[multi:')) {
          const { parseMultiPayload } = require('../utils/attachmentFormat') as typeof import('../utils/attachmentFormat');
          const parsed = parseMultiPayload(msgBody);
          if (parsed) {
            const { downloadAndDecryptMedia, persistEncryptedBlob } = require('../crypto/media') as typeof import('../crypto/media');
            const resolved = await Promise.all(
              parsed.attachments.map(async (att: import('../db/local').Attachment) => {
                try {
                  if (att.type === 'image') {
                    void persistEncryptedBlob(att.uri);
                    return att; // lazy decrypt on view
                  }
                  if (att.type === 'video') {
                    return { ...att, uri: await downloadAndDecryptMedia(att.uri, 'mp4') };
                  }
                  if (att.type === 'audio') {
                    return { ...att, uri: await downloadAndDecryptMedia(att.uri, 'm4a') };
                  }
                  if (att.type === 'file') {
                    const rawExt = (att.fileName ?? '').split('.').pop() ?? '';
                    const safeExt = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : 'bin';
                    return { ...att, uri: await downloadAndDecryptMedia(att.uri, safeExt) };
                  }
                  return att;
                } catch {
                  return att;
                }
              })
            );
            groupMsgAttachments = resolved;
            groupMsgType = resolved.length === 1 ? resolved[0].type : 'image';
            cleanMsgBody = parsed.caption;
          }
        } else if (msgBody.startsWith('[audio:') && msgBody.endsWith(']')) {
          const durEnd = msgBody.indexOf('s:', 7);
          if (durEnd > 7) {
            const durStr = msgBody.slice(7, durEnd);
            const dataUri = msgBody.slice(durEnd + 2, -1);
            groupMsgType = 'audio';
            cleanMsgBody = `[audio:${durStr}s]`;
            if (dataUri.startsWith('blob:')) {
              try {
                const { downloadAndDecryptMedia } = require('../crypto/media');
                groupMsgMediaUri = await downloadAndDecryptMedia(dataUri, 'm4a');
              } catch { groupMsgMediaUri = dataUri; }
            } else if (dataUri.startsWith('data:')) {
              try { groupMsgMediaUri = await saveMediaToCache(dataUri, `audio_${env.id}.m4a`); }
              catch { groupMsgMediaUri = dataUri; }
            }
          }
        } else if (msgBody.startsWith('[image:blob:')) {
          const closeIdx = msgBody.indexOf(']');
          if (closeIdx !== -1) {
            const dataUri = msgBody.slice(7, closeIdx);
            groupMsgType = 'image';
            cleanMsgBody = msgBody.slice(closeIdx + 1);
            // Persistent blob ref + lazy decrypt-on-view (see 1:1 path above).
            groupMsgMediaUri = dataUri;
            try {
              const { persistEncryptedBlob } = require('../crypto/media');
              void persistEncryptedBlob(dataUri);
            } catch { /* resolveMedia retries on view */ }
          }
        } else if (msgBody.startsWith('[image:data:')) {
          const closeIdx = msgBody.indexOf(']');
          if (closeIdx !== -1) {
            const dataUri = msgBody.slice(7, closeIdx);
            groupMsgType = 'image';
            cleanMsgBody = msgBody.slice(closeIdx + 1);
            try { groupMsgMediaUri = await saveMediaToCache(dataUri, `img_${env.id}.jpg`); }
            catch { groupMsgMediaUri = dataUri; }
          }
        } else if (msgBody.startsWith('[video:blob:')) {
          const closeIdx = msgBody.indexOf(']');
          if (closeIdx !== -1) {
            const dataUri = msgBody.slice(7, closeIdx);
            groupMsgType = 'video';
            cleanMsgBody = msgBody.slice(closeIdx + 1);
            try {
              const { downloadAndDecryptMedia } = require('../crypto/media');
              groupMsgMediaUri = await downloadAndDecryptMedia(dataUri, 'mp4');
            } catch { groupMsgMediaUri = dataUri; }
          }
        } else if (msgBody.startsWith('[video:data:')) {
          const closeIdx = msgBody.indexOf(']');
          if (closeIdx !== -1) {
            const dataUri = msgBody.slice(7, closeIdx);
            groupMsgType = 'video';
            cleanMsgBody = msgBody.slice(closeIdx + 1);
            try { groupMsgMediaUri = await saveMediaToCache(dataUri, `video_${env.id}.mp4`); }
            catch { groupMsgMediaUri = dataUri; }
          }
        } else if (msgBody.startsWith('[file:') && msgBody.endsWith(']')) {
          const inner = msgBody.slice(6, -1);
          const blobColonIdx = inner.indexOf(':blob:');
          if (blobColonIdx !== -1) {
            const fileName = inner.slice(0, blobColonIdx);
            const blobUri = inner.slice(blobColonIdx + 1);
            groupMsgType = 'file';
            cleanMsgBody = fileName;
            try {
              const { downloadAndDecryptMedia } = require('../crypto/media');
              const rawExt = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
              const safeExt = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : 'bin';
              groupMsgMediaUri = await downloadAndDecryptMedia(blobUri, safeExt);
            } catch { groupMsgMediaUri = blobUri; }
          } else {
            const plainColonIdx = inner.indexOf(':');
            if (plainColonIdx !== -1) {
              cleanMsgBody = inner.slice(0, plainColonIdx);
              groupMsgType = 'file';
            }
          }
        }

        const senderDisp = parsedPayload.senderName || senderId.substring(0, 8);
        // Backwards-compat: still embed sender prefix in body so older code
        // paths (notifications, previews) that read m.body keep working. The UI
        // layer (GroupBubble) now reads m.senderId for tamper-proof attribution.
        const formattedBody = `${senderDisp}: ${cleanMsgBody}`;

        await saveSessionState(contact.aegisId, ratchetState);

        await useMessages.getState().append({
          id: env.id,
          chatId: groupId,
          direction: 'in',
          body: formattedBody,
          createdAt: env.createdAt ?? Date.now(),
          type: groupMsgType as 'text' | 'image' | 'audio' | 'video' | 'file' | 'poll' | 'location' | 'view_once',
          mediaUri: groupMsgMediaUri,
          attachments: groupMsgAttachments,
          senderId,
        });

        // Trigger local notification in alignment with AegisLink notifications spec.
        // Scheduled posts carry a [post:flags] marker: strip it from the banner
        // text and honour the 's' (silent) flag — the admin chose no notification.
        const { parseGroupPostMarker } = require('../utils/groupPost') as typeof import('../utils/groupPost');
        const postInfo = parseGroupPostMarker(cleanMsgBody);
        if (!postInfo.silent) {
          const { showIncomingNotification } = require('../notifications/push');
          void showIncomingNotification(senderId, parsedPayload.senderName || senderId.substring(0, 8), postInfo.text, true, trustedGroupName, groupId);
        }

        return true;
      } else if (
        parsedPayload.type === 'direct_msg' ||
        parsedPayload.type === 'location' ||
        parsedPayload.type === 'view_once'
      ) {
        finalBody = parsedPayload.text;

        // Dynamically update contact name/color/image/status on every message.
        // senderImage is populated only on the first message per session from
        // the sender (see profiledContacts in sendMessage). Passing undefined
        // when absent preserves the previously stored avatar.
        if (parsedPayload.senderName) {
          void useContacts.getState().updateContactProfile(
            contact.aegisId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            parsedPayload.senderImage ?? undefined,
            parsedPayload.senderStatus ?? undefined
          );
        }
      }
    }
  } catch (e) {
    if (__DEV__) logger.warn('[socket] Failed parsing structured E2EE message payload:', e);
  }

  await saveSessionState(contact.aegisId, ratchetState);

  // ── Detect and save media payloads ──────────────────────────────────────────
  // Use startsWith/indexOf instead of regex on potentially large (400KB+) strings.
  let detectedType: string = parsedPayload?.type ?? 'text';
  let detectedMediaUri: string | null = null;
  let detectedAttachments: import('../db/local').Attachment[] | null = null;
  let cleanBody = finalBody;

  /**
   * Write a base64 data-URI to the local file cache and return the local path.
   * Falls back to the in-memory data URI so the Image component can still render.
   */
  async function saveMediaToCache(dataUri: string, filename: string): Promise<string> {
    // expo-file-system v18: legacy sub-module keeps writeAsStringAsync + cacheDirectory
    const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const localPath = `${FS.cacheDirectory}${filename}`;
    const base64Data = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;
    await FS.writeAsStringAsync(localPath, base64Data, { encoding: FS.EncodingType.Base64 });
    return localPath;
  }

  if (finalBody.startsWith('[audio:') && finalBody.endsWith(']')) {
    // Format: [audio:Ns:data:audio/...;base64,...]
    const durEnd = finalBody.indexOf('s:', 7);
    if (durEnd > 7) {
      const durStr = finalBody.slice(7, durEnd);
      const dataUri = finalBody.slice(durEnd + 2, -1); // strip trailing ]
      detectedType = 'audio';
      cleanBody = `[audio:${durStr}s]`;
      if (dataUri.startsWith('blob:')) {
        try {
          const { downloadAndDecryptMedia } = require('../crypto/media');
          detectedMediaUri = await downloadAndDecryptMedia(dataUri, 'm4a');
        } catch {
          detectedMediaUri = dataUri;
        }
      } else if (dataUri.startsWith('data:')) {
        try {
          detectedMediaUri = await saveMediaToCache(dataUri, `audio_${env.id}.m4a`);
        } catch {
          detectedMediaUri = dataUri;
        }
      }
    }
  } else if (finalBody.startsWith('[multi:')) {
    const { parseMultiPayload } = require('../utils/attachmentFormat') as typeof import('../utils/attachmentFormat');
    const parsed = parseMultiPayload(finalBody);
    if (parsed) {
      const { downloadAndDecryptMedia, persistEncryptedBlob } = require('../crypto/media') as typeof import('../crypto/media');
      const resolved = await Promise.all(
        parsed.attachments.map(async (att: import('../db/local').Attachment) => {
          try {
            if (att.type === 'image') {
              void persistEncryptedBlob(att.uri);
              return att;
            }
            if (att.type === 'video') {
              return { ...att, uri: await downloadAndDecryptMedia(att.uri, 'mp4') };
            }
            if (att.type === 'audio') {
              return { ...att, uri: await downloadAndDecryptMedia(att.uri, 'm4a') };
            }
            if (att.type === 'file') {
              const rawExt = (att.fileName ?? '').split('.').pop() ?? '';
              const safeExt = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : 'bin';
              return { ...att, uri: await downloadAndDecryptMedia(att.uri, safeExt) };
            }
            return att;
          } catch {
            return att;
          }
        })
      );
      detectedAttachments = resolved;
      detectedType = resolved.length === 1 ? resolved[0].type : 'image';
      cleanBody = parsed.caption;
    }
  } else if (finalBody.startsWith('[image:blob:')) {
    const closeIdx = finalBody.indexOf(']');
    if (closeIdx !== -1) {
      const dataUri = finalBody.slice(7, closeIdx);
      detectedType = 'image';
      cleanBody = finalBody.slice(closeIdx + 1);
      // Store the persistent encrypted blob REFERENCE (not a volatile decrypted
      // cache path). The bubble decrypts on demand via resolveMedia. Persist the
      // ciphertext locally now, while online, so it survives the server's 24h TTL.
      detectedMediaUri = dataUri;
      try {
        const { persistEncryptedBlob } = require('../crypto/media');
        void persistEncryptedBlob(dataUri);
      } catch { /* best-effort — resolveMedia will retry on view */ }
    }
  } else if (finalBody.startsWith('[image:data:')) {
    const closeIdx = finalBody.indexOf(']');
    if (closeIdx !== -1) {
      const dataUri = finalBody.slice(7, closeIdx);
      detectedType = 'image';
      cleanBody = finalBody.slice(closeIdx + 1);
      try {
        detectedMediaUri = await saveMediaToCache(dataUri, `img_${env.id}.jpg`);
      } catch {
        // Last resort: use in-memory data URI (may be slow for large images)
        detectedMediaUri = dataUri;
      }
    }
  } else if (finalBody.startsWith('[viewonce:audio:') && finalBody.endsWith(']')) {
    // Format: [viewonce:audio:NNs:data:audio/m4a;base64,...]
    const inner = finalBody.slice(16, -1); // strip '[viewonce:audio:' and ']'
    const colonIdx = inner.indexOf(':');
    if (colonIdx !== -1) {
      const durStr = inner.slice(0, colonIdx); // e.g. "30s"
      const dataUri = inner.slice(colonIdx + 1); // "data:audio/m4a;base64,..."
      detectedType = 'view_once';
      cleanBody = `[viewonce:audio:${durStr}]`;
      if (dataUri.startsWith('data:')) {
        try {
          const durSec = parseInt(durStr, 10) || 0;
          detectedMediaUri = await saveMediaToCache(dataUri, `viewonce_audio_${env.id}.m4a`);
          cleanBody = `[viewonce:audio:${durSec}s]`;
        } catch {
          detectedMediaUri = dataUri;
        }
      }
    }
  } else if (finalBody.startsWith('[viewonce:blob:')) {
    const closeIdx = finalBody.indexOf(']');
    if (closeIdx !== -1) {
      const dataUri = finalBody.slice(10, closeIdx); // '[viewonce:' = 10 chars
      detectedType = 'view_once';
      const captionText = finalBody.slice(closeIdx + 1);
      cleanBody = captionText.trim() ? `[viewonce]\n${captionText.trim()}` : '[viewonce]';
      try {
        const { downloadAndDecryptMedia } = require('../crypto/media');
        detectedMediaUri = await downloadAndDecryptMedia(dataUri);
      } catch {
        detectedMediaUri = dataUri;
      }
    }
  } else if (finalBody.startsWith('[viewonce:data:') && finalBody.endsWith(']')) {
    let dataUri = finalBody.slice(10, -1); // '[viewonce:' = 10 chars, strip ]
    let captionText = '';
    const pipeIdx = dataUri.lastIndexOf('|');
    if (pipeIdx !== -1) {
      captionText = dataUri.slice(pipeIdx + 1);
      dataUri = dataUri.slice(0, pipeIdx);
    }
    const isVideo = dataUri.startsWith('data:video');
    const ext = isVideo ? 'mp4' : 'jpg';
    detectedType = 'view_once';
    // Tag video view-once with a marker body so the viewer renders a <Video>
    // player instead of <Image>. Image view-once keeps the plain "[viewonce]".
    const baseBody = isVideo ? '[viewonce:video]' : '[viewonce]';
    cleanBody = captionText.trim() ? `${baseBody}\n${captionText.trim()}` : baseBody;
    try {
      detectedMediaUri = await saveMediaToCache(dataUri, `viewonce_${env.id}.${ext}`);
    } catch {
      detectedMediaUri = dataUri;
    }
  } else if (finalBody.startsWith('[video:blob:')) {
    const closeIdx = finalBody.indexOf(']');
    if (closeIdx !== -1) {
      const dataUri = finalBody.slice(7, closeIdx);
      detectedType = 'video';
      cleanBody = finalBody.slice(closeIdx + 1);
      try {
        const { downloadAndDecryptMedia } = require('../crypto/media');
        detectedMediaUri = await downloadAndDecryptMedia(dataUri, 'mp4');
      } catch {
        detectedMediaUri = dataUri;
      }
    }
  } else if (finalBody.startsWith('[video:data:')) {
    const closeIdx = finalBody.indexOf(']');
    if (closeIdx !== -1) {
      const dataUri = finalBody.slice(7, closeIdx);
      detectedType = 'video';
      cleanBody = finalBody.slice(closeIdx + 1);
      try {
        detectedMediaUri = await saveMediaToCache(dataUri, `video_${env.id}.mp4`);
      } catch {
        detectedMediaUri = dataUri;
      }
    }
  } else if (finalBody.startsWith('[file:') && finalBody.endsWith(']')) {
    // Format: [file:filename:blob:<id>:<key>:<nonce>]
    const inner = finalBody.slice(6, -1); // remove '[file:' and ']'
    const blobColonIdx = inner.indexOf(':blob:');
    if (blobColonIdx !== -1) {
      const fileName = inner.slice(0, blobColonIdx);
      const blobUri = inner.slice(blobColonIdx + 1); // "blob:id:key:nonce"
      detectedType = 'file';
      cleanBody = fileName;
      try {
        const { downloadAndDecryptMedia } = require('../crypto/media');
        const rawExt = fileName.includes('.') ? fileName.split('.').pop() ?? '' : '';
        const safeExt = /^[a-zA-Z0-9]{1,8}$/.test(rawExt) ? rawExt.toLowerCase() : 'bin';
        detectedMediaUri = await downloadAndDecryptMedia(blobUri, safeExt);
      } catch {
        detectedMediaUri = blobUri;
      }
    } else {
      // legacy or unencrypted — just show filename
      const plainColonIdx = inner.indexOf(':');
      if (plainColonIdx !== -1) {
        cleanBody = inner.slice(0, plainColonIdx);
        detectedType = 'file';
      }
    }
  }

  await useMessages.getState().append({
    id: env.id,
    chatId: contact.aegisId,
    direction: 'in',
    body: cleanBody,
    createdAt: env.createdAt ?? Date.now(),
    type: detectedType as 'text' | 'image' | 'audio' | 'video' | 'file' | 'poll' | 'location' | 'view_once',
    mediaUri: detectedMediaUri,
    expiresAt: parsedPayload?.expiresAt ?? null,
    attachments: detectedAttachments,
    // Persist the mathematically-authenticated sender so a later peer-initiated
    // retraction (msg_delete) can match this row via setRemoteMessageDeleted's
    // `sender_id = ?` predicate — without this, 1:1 incoming rows had sender_id
    // NULL and remote unsend silently no-opped in direct chats.
    senderId: contact.aegisId,
  });

  // Trigger local notification in alignment with AegisLink notifications spec
  const { showIncomingNotification } = require('../notifications/push');
  void showIncomingNotification(contact.aegisId, contact.name, finalBody, false);

  return true;
}

/**
 * Returns `{ deliveryToken }` (our own raw token) when v2 is enabled, else `{}`.
 * Spread into profile_update payloads so contacts learn our token over E2EE and
 * can later send us sealed v2 envelopes. No-op (and no token generated) under v1.
 */
async function ownDeliveryTokenField(): Promise<Record<string, string>> {
  if (SEALED_TRANSPORT_VERSION !== 'v2') return {};
  try { return { deliveryToken: await getOwnDeliveryToken() }; } catch { return {}; }
}

/**
 * Returns `{ mailboxRoot }` (base64 of our own mailbox root) when v2 is enabled,
 * else `{}`. Spread into profile_update payloads so contacts learn our root over
 * E2EE — whoever holds it derives our mailbox id for any epoch, so it ships ONLY
 * inside the sealed profile, never on the wire (see mailboxStore.ts). Shared
 * eagerly under v2 (like the delivery token): pre-distribution makes the eventual
 * mailbox-transport cutover (Fase 4 Slice 4+, flag-gated) seamless. No-op under v1.
 */
async function ownMailboxRootField(): Promise<Record<string, string>> {
  if (SEALED_TRANSPORT_VERSION !== 'v2') return {};
  try { return { mailboxRoot: await getOwnMailboxRootB64() }; } catch { return {}; }
}

async function handleIncomingV2(env: WireSealedEnvelopeV2, identity: Identity) {
  const contacts = useContacts.getState().contacts;
  // Resolve the sender's Ed25519 signing key by the `from` recovered from inside
  // the sealed box. Unknown sender (or no signing key on file) → reject: v2 is
  // restricted to established contacts (first contact bootstraps over v1).
  const resolveSigningKey = (from: string): Uint8Array | null => {
    const c = contacts.find((x) => x.aegisId === from);
    if (!c?.signingPublicKeyB64) return null;
    try { return decodeBase64(c.signingPublicKeyB64); } catch { return null; }
  };

  const inner = openEnvelopeV2(
    { ciphertext: env.ciphertext, nonce: env.nonce, epk: env.epk },
    identity.secretKey,
    resolveSigningKey,
    Date.now(),
  );
  if (!inner) {
    if (__DEV__) logger.warn('[socket] envelope:v2 failed to open/authenticate — dropping');
    return;
  }

  const contact = contacts.find((c) => c.aegisId === inner.from);
  if (!contact || contact.blocked) return;

  // Reuse the v1 downstream (ratchet decrypt + glare/desync recovery + dispatch).
  const synthEnv: WireSealedEnvelope = {
    id: env.id,
    to: env.to,
    from: inner.from,
    ciphertext: env.ciphertext,
    nonce: env.nonce,
    createdAt: env.createdAt,
  };
  await decryptAndAppend(synthEnv, inner, contact, identity);
}

async function handleIncoming(env: WireSealedEnvelope, identity: Identity) {
  // Multi-device self-copy fast path — routed BEFORE contact matching so a
  // self-copy never falls through to the regular incoming-message handler
  // (which would re-trigger profile/group flows and never decrypt correctly).
  if (env.selfCopy === true && env.to === identity.aegisId) {
    await handleSelfCopy(env, identity);
    return;
  }

  // First-contact recovery: a queued X3DH-initial message arrives with no `from`
  // (the relay never persists the social graph) but DOES carry the sender's
  // public key (attached by the relay only for `init` messages). The aegisId is
  // deterministically derived from the public key, so we can recover the sender
  // identity locally and auto-add + decrypt even though we were offline when it
  // was sent. Without this, the first message to a new contact would be lost.
  if (!env.from && env.senderPublicKeyB64) {
    try {
      env.from = deriveAegisId(decodeBase64(env.senderPublicKeyB64));
    } catch { /* malformed key — fall through to trial decrypt */ }
  }

  const contacts = useContacts.getState().contacts;
  let matchedContact = env.from ? contacts.find(c => c.aegisId === env.from) : null;

  // Drop messages from blocked contacts immediately — do not decrypt, do not store
  if (matchedContact?.blocked) {
    return;
  }

  if (!matchedContact && env.from) {
    let autoAdded = false;
    try {
      // Unknown incoming sender → auto-add as a PENDING message request. The chat
      // opens in accept/block/delete mode; the stranger never lands directly in a
      // normal thread and cannot be replied to until the user accepts.
      matchedContact = await useContacts.getState().addByAegisId(env.from, undefined, { pending: true });
      autoAdded = true;
    } catch (e) {
      if (__DEV__) logger.warn('[socket] failed to auto-add unknown sender', e);
    }
    // After auto-adding the sender as a new contact, send them our own profile so
    // they learn our display name without having to wait for our next reconnect
    // broadcast. Without this, the reverse direction (B→A) never receives a name
    // because broadcastProfileUpdate already ran at auth:ok when contacts was empty.
    if (autoAdded && matchedContact) {
      const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
      const ownIdentity = useIdentity.getState().identity;
      if (ownIdentity) {
        void sendProfileTo(matchedContact, ownIdentity).catch(() => {});
      }
    }
  }

  // If we have a matched contact, decrypt directly
  if (matchedContact) {
    let senderPubKey: Uint8Array;
    try {
      senderPubKey = decodeBase64(matchedContact.publicKeyB64);
    } catch {
      return;
    }
    const parsed = openEnvelope(
      { ciphertextB64: env.ciphertext, nonceB64: env.nonce },
      senderPubKey,
      identity.secretKey
    );
    if (parsed) {
      const success = await decryptAndAppend(env, parsed, matchedContact, identity);
      if (success) return;
    } else {
      // [RDIAG] Outer box failed against the CONTACT-RECORD key. Compare its
      // prefix with the relay-attached sender key (init envelopes) — a mismatch
      // means our contact record holds a stale/wrong identity key for the peer.
      rdiag(
        `[RDIAG] outer-open FAILED for=${env.from} contactKey8=${matchedContact.publicKeyB64.slice(0, 8)} attachedKey8=${env.senderPublicKeyB64 ? env.senderPublicKeyB64.slice(0, 8) : '(none)'} keysEqual=${env.senderPublicKeyB64 ? env.senderPublicKeyB64 === matchedContact.publicKeyB64 : 'n/a'}`,
      );
    }
  }

  // Fallback: trial decrypt against all contacts (if env.from was missing or decryption failed)
  for (const contact of contacts) {
    if (contact.blocked) continue; // never process messages from blocked contacts
    if (env.from && contact.aegisId === env.from) continue; // already tried
    let senderPubKey: Uint8Array;
    try {
      senderPubKey = decodeBase64(contact.publicKeyB64);
    } catch {
      continue;
    }

    const parsed = openEnvelope(
      { ciphertextB64: env.ciphertext, nonceB64: env.nonce },
      senderPubKey,
      identity.secretKey
    );
    if (!parsed) continue;

    const success = await decryptAndAppend(env, parsed, contact, identity);
    if (success) return;
  }

  if (__DEV__) logger.warn('[socket] envelope from unknown sender — add the peer as a contact first to decrypt their messages');
}

// ─── Self-encrypted copy (multi-device sync) ─────────────────────────────────
//
// When the user sends a message to Contact B from device A, the ciphertext is
// sealed for B's identity key — so device A2 (e.g. desktop) of the same user
// cannot read it. To make outbound messages visible across the user's own
// devices we additionally send a second envelope addressed to `myAegisId`,
// cifrado via an INDEPENDENT Double Ratchet session ("self-session") whose
// X3DH handshake runs against the user's OWN published prekeys.
//
// Privacy/safety properties enforced below:
//   - Plaintext NEVER appears on the wire — the self-copy is a normal E2EE
//     envelope; the relay only re-routes ciphertext.
//   - View-once messages do NOT generate a self-copy (the view-once invariant
//     is "exists exactly once, on the original device").
//   - Very short ephemeral timers (< 5 s) suppress self-copy: the round-trip
//     would race the expiration.
//   - Receiver of a self-copy NEVER emits another self-copy — `handleSelfCopy`
//     never calls `sendSelfCopy`, and the wire flag prevents the regular
//     contact-decrypt code path from re-triggering send logic.
//
// Known multi-device limitation: each device generates its own SPK/OPKs and
// uploads them under the same aegisId, so the prekey bundle returned for
// `myAegisId` is whichever device refilled last. If device A fetches its own
// uploaded SPK, only device A holds the SPK secret to perform the receiver-
// side X3DH; device A2 will be unable to derive the same root key. Fixing
// this requires sharing SPK secrets across the user's devices (out of scope
// for this module). The flow degrades gracefully: handleSelfCopy logs a
// warning and drops the message; the recipient still received it correctly.

async function getSelfRatchet(myAegisId: string): Promise<RatchetState | null> {
  try {
    const raw = await SecureStore.getItemAsync(SECURE_SELF_RATCHET_KEY(myAegisId));
    if (!raw) return null;
    const s = reviveRatchetState(raw);
    return s as RatchetState;
  } catch (e) {
    if (__DEV__) logger.warn('[socket] getSelfRatchet read failed:', (e as Error).message);
    return null;
  }
}

async function saveSelfRatchet(myAegisId: string, state: RatchetState): Promise<void> {
  trimOldSkippedKeys(state, MAX_SKIPPED_KEYS);
  const serialized = {
    RK: state.RK,
    DHs: state.DHs,
    DHr: state.DHr,
    CKs: state.CKs,
    CKr: state.CKr,
    Ns: state.Ns,
    Nr: state.Nr,
    PN: state.PN,
    MKSKIPPED: Array.from(state.MKSKIPPED.entries()),
    x3dhInit: state.x3dhInit,
  };
  await SecureStore.setItemAsync(
    SECURE_SELF_RATCHET_KEY(myAegisId),
    JSON.stringify(serialized),
  );
}

/**
 * Build a fresh self-ratchet (Alice side) by performing X3DH against the
 * user's own published prekey bundle. The resulting state is stamped with
 * `x3dhInit` so the FIRST self-copy envelope carries handshake headers and
 * the receiving device can run the receiver-side X3DH.
 */
async function initSelfSession(identity: Identity, sock: Socket): Promise<RatchetState> {
  type PreKeyFetchAck = { ok: true; bundle: PreKeyBundle } | { ok: false; error?: string };
  const bundle = await new Promise<PreKeyBundle>((resolve, reject) => {
    sock.emit('prekeys:fetch', { aegisId: identity.aegisId }, (ack: PreKeyFetchAck) => {
      if (!ack?.ok) reject(new Error(ack?.error ?? 'self_prekeys_fetch_failed'));
      else resolve(ack.bundle);
    });
  });

  // SPK signature verification uses our OWN signing public key — we trust
  // it absolutely (it was loaded from SecureStore at app start), so a relay
  // that swaps the SPK cannot pass verification.
  bundle.signingPublicKeyB64 = identity.signingPublicKeyB64;
  bundle.identityKeyB64 = identity.publicKeyB64;

  // Multi-device self-copy stays v1-only (PQXDH gap #3): the self-receiver path
  // (handleSelfCopy → performX3DHReceiver) does NOT pass PQ inputs, so we MUST
  // keep the self-sender on v1 too. Otherwise performX3DH would negotiate v2
  // (the self-bundle advertises our OWN PQSPK) and derive a root key the
  // receiver derives as v1 — a silent mismatch that breaks self-copy decryption
  // on any user with 2+ linked devices. Stripping the PQSPK forces classic v1 on
  // both sides. (Desktop applies the same fix; see PR #31.)
  bundle.pqSignedPreKey = null;

  const x3dh = performX3DH(identity, bundle);
  const ratchetState = initRatchet(
    x3dh.rootKey,
    decodeBase64(bundle.signedPreKey.publicKeyB64),
    true,
  );
  ratchetState.x3dhInit = {
    aliceEKB64: x3dh.myEphemeralPublicKeyB64,
    spkId: bundle.signedPreKey.keyId,
    opkId: bundle.oneTimePreKey ? bundle.oneTimePreKey.keyId : null,
  };
  return ratchetState;
}

interface SelfCopyMeta {
  viewOnce?: boolean;
  ephemeralSeconds?: number;
}

/**
 * Send a self-encrypted copy of an outbound message so the user's other
 * devices can render it as direction:'out'. Safe to call after every regular
 * send; failures are swallowed (the primary recipient already received the
 * message — the secondary device sync is best-effort).
 */
async function sendSelfCopy(
  sock: Socket,
  identity: Identity,
  recipientAegisId: string,
  msgId: string,
  innerPayloadJson: string,
  meta: SelfCopyMeta,
): Promise<void> {
  if (meta.viewOnce) return; // view-once never leaves the originating device
  if (meta.ephemeralSeconds !== undefined && meta.ephemeralSeconds > 0 && meta.ephemeralSeconds < 5) return;

  try {
    let ratchet = await getSelfRatchet(identity.aegisId);
    if (!ratchet) {
      ratchet = await initSelfSession(identity, sock);
    }

    // The plaintext sent to ourselves embeds the original recipient aegisId
    // (so the receiving device can file the message in the correct chat),
    // the original message id (so dedupe works against any locally-known
    // outbound), and a `selfCopy: true` marker that the receiver verifies
    // against the wire flag for defence-in-depth.
    const selfPayloadObj = {
      type: 'self_copy',
      selfCopy: true,
      msgId,
      chatId: recipientAegisId,
      // `inner` is the SAME stringified JSON that was sent to the recipient,
      // so all media tags / view-once markers / vote bodies survive verbatim.
      inner: innerPayloadJson,
      sentAt: Date.now(),
    };
    const selfPayload = JSON.stringify(selfPayloadObj);

    const { ciphertext, nonce, header } = ratchetEncrypt(ratchet, new TextEncoder().encode(selfPayload));
    await saveSelfRatchet(identity.aegisId, ratchet);

    // Build the sealed inner via encryptMessage-equivalent: outer NaCl box
    // sealed for our own identity key. We can call nacl.box(plain, nonce,
    // myPub, mySec) — X25519 DH(mySec, myPub) is well-defined.
    const innerPayload: Record<string, unknown> = {
      v: 2,
      from: identity.aegisId,
      selfCopy: true,
      ratchet: {
        ratchetKeyB64: encodeBase64(header.ratchetKey),
        n: header.n,
        pn: header.pn,
        ciphertextB64: encodeBase64(ciphertext),
        nonceB64: encodeBase64(nonce),
      },
    };
    if (ratchet.x3dhInit) {
      innerPayload.x3dh = ratchet.x3dhInit;
    }
    // Clear x3dhInit after the first message so subsequent self-copies
    // carry only ratchet headers (matches the regular session flow).
    if (ratchet.x3dhInit) {
      delete ratchet.x3dhInit;
      await saveSelfRatchet(identity.aegisId, ratchet);
    }

    const { stripAndPad } = require('../crypto/metadata') as typeof import('../crypto/metadata');
    const innerBytes = stripAndPad(innerPayload);
    const outerNonce = nacl.randomBytes(nacl.box.nonceLength);
    const outerCiphertext = nacl.box(innerBytes, outerNonce, identity.publicKey, identity.secretKey);

    sock.emit('envelope', {
      id: Crypto.randomUUID(),
      to: identity.aegisId,
      ciphertext: encodeBase64(outerCiphertext),
      nonce: encodeBase64(outerNonce),
      selfCopy: true,
    });
  } catch (e) {
    if (__DEV__) logger.warn('[socket] sendSelfCopy failed (non-fatal):', (e as Error).message);
  }
}

/**
 * Handle an inbound envelope flagged as a self-copy. Decrypts via the
 * self-ratchet, validates `parsed.from === identity.aegisId`, and appends
 * the carried message into the local store as direction:'out'.
 *
 * NEVER triggers another self-copy (no recursion into sendSelfCopy).
 */
async function handleSelfCopy(env: WireSealedEnvelope, identity: Identity): Promise<void> {
  // Decrypt outer sealed envelope using our own keypair on both sides
  // (DH(mySec, myPub) is symmetric — nacl.box.open accepts it).
  const parsed = openEnvelope(
    { ciphertextB64: env.ciphertext, nonceB64: env.nonce },
    identity.publicKey,
    identity.secretKey,
  );
  if (!parsed) {
    if (__DEV__) logger.warn('[socket] self-copy outer decrypt failed');
    return;
  }
  if (parsed.from !== identity.aegisId) {
    if (__DEV__) logger.warn('[socket] self-copy from mismatch — dropping');
    return;
  }
  // Defence-in-depth: the inner payload MUST also self-declare as a self-copy.
  if ((parsed as { selfCopy?: unknown }).selfCopy !== true) {
    if (__DEV__) logger.warn('[socket] self-copy inner flag missing — dropping');
    return;
  }

  if ((parsed as any).deviceSync?.type === 'spk') {
    const spkSync = (parsed as any).deviceSync;
    const { saveSpkSecret } = require('../db/local') as typeof import('../db/local');
    await saveSpkSecret(spkSync.spkId, spkSync.spkSecretB64);
    if (__DEV__) logger.debug(`[socket] Synced SPK secret for keyId ${spkSync.spkId} from other device`);
    return;
  }

  let ratchet = await getSelfRatchet(identity.aegisId);
  if (!ratchet) {
    // First self-copy received on this device — derive the session as Bob
    // using OUR OWN SPK secret. If we don't have an SPK secret stored
    // (e.g. desktop hasn't run uploadPreKeys yet) we cannot decrypt; drop.
    if (!parsed.x3dh) {
      if (__DEV__) logger.warn('[socket] self-copy: no session and no X3DH headers — dropping');
      return;
    }
    const x3dhInit = parsed.x3dh as { aliceEKB64: string; spkId: number; opkId: number | null };
    // Mirror the primary decrypt path: read the SPK secret matching the keyId the
    // sender (our other device) committed to, falling back to the legacy slot.
    // DURABLE STORE FIRST (DB), SecureStore fallback for legacy sessions.
    let spkSec: string | null = null;
    if (typeof x3dhInit.spkId === 'number') {
      spkSec = await loadSpkSecret(x3dhInit.spkId);
      if (!spkSec) spkSec = await SecureStore.getItemAsync(spkSecretKey(x3dhInit.spkId));
    }
    if (!spkSec) {
      const latest = await loadLatestSpkSecret();
      spkSec = latest?.b64 ?? null;
    }
    if (!spkSec) {
      spkSec = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    }
    if (!spkSec) {
      if (__DEV__) logger.warn('[socket] self-copy: missing local SPK secret — dropping (multi-device SPK sync not implemented)');
      return;
    }
    const mySpkSecret = decodeBase64(spkSec);

    let myOpkSecret: Uint8Array | null = null;
    if (x3dhInit.opkId !== null) {
      let opkB64 = await loadOpkSecret(x3dhInit.opkId);
      if (!opkB64) opkB64 = await SecureStore.getItemAsync(opkSecretKey(x3dhInit.opkId));
      if (opkB64) {
        myOpkSecret = decodeBase64(opkB64);
        // Same forward-secrecy guarantee as the primary decrypt path: consume
        // the OPK from both the durable store and the SecureStore cache.
        try { await deleteOpkSecret(x3dhInit.opkId); } catch { /* best-effort */ }
        try {
          await SecureStore.deleteItemAsync(opkSecretKey(x3dhInit.opkId));
        } catch { /* best-effort */ }
      }
    }
    const rootKey = performX3DHReceiver(
      identity,
      mySpkSecret,
      myOpkSecret,
      identity.publicKey,
      decodeBase64(x3dhInit.aliceEKB64),
    );
    const spkPub = nacl.scalarMult.base(mySpkSecret);
    const rHeader = parsed.ratchet as { ratchetKeyB64: string };
    ratchet = initRatchet(rootKey, decodeBase64(rHeader.ratchetKeyB64), false, {
      publicKey: spkPub,
      secretKey: mySpkSecret,
    });
  }

  const r = parsed.ratchet as { ratchetKeyB64: string; n: number; pn: number; ciphertextB64: string; nonceB64: string };
  let plaintextBytes: Uint8Array | null;
  try {
    plaintextBytes = ratchetDecrypt(
      ratchet,
      { ratchetKey: decodeBase64(r.ratchetKeyB64), n: r.n, pn: r.pn },
      decodeBase64(r.ciphertextB64),
      decodeBase64(r.nonceB64),
    );
  } catch (e) {
    if (__DEV__) logger.warn('[socket] self-copy ratchet decrypt threw:', (e as Error).message);
    return;
  }
  if (!plaintextBytes) {
    if (__DEV__) logger.warn('[socket] self-copy ratchet decrypt failed (null)');
    return;
  }
  await saveSelfRatchet(identity.aegisId, ratchet);

  let selfBody: string;
  try {
    selfBody = encodeUTF8(plaintextBytes);
  } catch {
    return;
  }

  let selfObj: {
    type?: string;
    msgId?: string;
    chatId?: string;
    inner?: string;
    sentAt?: number;
  };
  try {
    selfObj = JSON.parse(selfBody);
  } catch {
    if (__DEV__) logger.warn('[socket] self-copy body is not JSON — dropping');
    return;
  }
  if (selfObj.type !== 'self_copy' || !selfObj.msgId || !selfObj.chatId || !selfObj.inner) {
    if (__DEV__) logger.warn('[socket] self-copy malformed payload — dropping');
    return;
  }

  // Dedup: if we already have this msgId in the target chat, skip.
  const existing = useMessages.getState().byChat[selfObj.chatId];
  if (existing && existing.some((m) => m.id === selfObj.msgId)) {
    return;
  }

  // Recover the original outbound payload to reconstruct body / type / media.
  let originalPayload: {
    type?: string;
    text?: string;
    replyToId?: string;
    expiresAt?: number | null;
  } = {};
  try {
    originalPayload = JSON.parse(selfObj.inner);
  } catch {
    if (__DEV__) logger.warn('[socket] self-copy inner payload not JSON — falling back to raw');
  }

  const displayBody = typeof originalPayload.text === 'string' ? originalPayload.text : selfObj.inner;

  await useMessages.getState().append({
    id: selfObj.msgId,
    chatId: selfObj.chatId,
    direction: 'out',
    body: displayBody,
    createdAt: selfObj.sentAt ?? Date.now(),
    replyToId: originalPayload.replyToId ?? null,
    type: (originalPayload.type as 'text' | 'location' | 'view_once' | undefined) ?? 'text',
    expiresAt: originalPayload.expiresAt ?? null,
  });
}

export function disconnect(): void {
  clearAuthWatchdog();
  if (socket) {
    socket.disconnect();
    socket = null;
    connected = false;
    authenticated = false;
  }
  // Fase 4: tear down the dedicated mailbox delivery socket alongside the
  // aegisId socket (no-op when mailbox mode was never enabled).
  disconnectMailboxSocket();
  // Slice 2b.2: stop the ntfy wake subscription too (logout / panic / switch).
  stopMailboxPushSubscription();
  // Call-wake FGS is tied to an active session — tear it down on full disconnect
  // (logout / panic / profile switch) so a logged-out app shows no persistent
  // notification. Re-armed by connect() per the preference. No-op if not running.
  stopCallWakeService();
  // Reset per-session tracking so each new session re-sends images once,
  // ensuring freshness after identity or group avatar updates.
  profiledContacts.clear();
  profiledGroupImages.clear();
  // Cancel pending recovery fallback flushes — they would fire over a dead
  // socket and keep the JS runtime (and Jest workers) alive via open handles.
  for (const t of recoveryFallbackTimers.values()) clearTimeout(t);
  recoveryFallbackTimers.clear();
  nudgeAttemptsThisEpisode.clear();
}

export async function sendMessage(opts: {
  identity: Identity;
  recipientAegisId: string;
  recipientPublicKey: Uint8Array;
  plaintext: string;
  replyToId?: string;
  type?: string;
  expiresAt?: number | null;
  skipLocalAppend?: boolean;
}): Promise<void> {
  const { useIdentity } = require('../store/identity');
  const idState = useIdentity.getState();
  const senderName = idState.displayName;
  const senderColor = idState.avatarColor;
  const senderStatus = idState.profileStatus;

  const id = Crypto.randomUUID();
  const createdAt = Date.now();

  let expiresAt = opts.expiresAt ?? null;
  const msgType = opts.type ?? 'direct_msg';
  if (msgType === 'direct_msg' && !expiresAt) {
    const timer = useMessages.getState().getEphemeralTimer(opts.recipientAegisId);
    if (timer > 0) {
      expiresAt = createdAt + timer * 1000;
    }
  }

  // A-3: tell the relay the disappearing-message TTL so a queued (offline)
  // ephemeral message is purged at its intended expiry instead of lingering for
  // the 30-day default. Only the coarse TTL is exposed (accepted in roadmap).
  const ephemeralTtlMs =
    expiresAt && expiresAt > createdAt ? expiresAt - createdAt : undefined;

  // Optimistic local append — skip when caller already pre-appended (e.g. media messages)
  if (!opts.skipLocalAppend) {
    await useMessages.getState().append({
      id,
      chatId: opts.recipientAegisId,
      direction: 'out',
      body: opts.plaintext,
      createdAt,
      replyToId: opts.replyToId ?? null,
      type: msgType as any,
      expiresAt,
    });
  }

  // Include senderImage only on the first message to each contact per session.
  // This avoids embedding a large base64 blob in every envelope while still
  // ensuring the recipient always has an up-to-date avatar.
  const rawImage = idState.avatarImage;
  let senderImage: string | null = null;
  if (!profiledContacts.has(opts.recipientAegisId)) {
    senderImage = await toDataUri(rawImage);
    if (senderImage) profiledContacts.add(opts.recipientAegisId);
  }

  const payloadObj = {
    type: msgType,
    text: opts.plaintext,
    senderName,
    senderColor,
    senderStatus,
    senderImage,
    replyToId: opts.replyToId,
    expiresAt,
  };
  const payload = JSON.stringify(payloadObj);
  const recipientPublicKeyB64 = encodeBase64(opts.recipientPublicKey);

  // ── Outbox: persist before attempting to emit ────────────────────────────
  // The job survives app close / crash; flushOutbox() will retry on reconnect.
  const jobId = Crypto.randomUUID();
  try {
    await enqueueOutboxJob({
      jobId,
      msgId: id,
      recipientAegisId: opts.recipientAegisId,
      recipientPubkeyB64: recipientPublicKeyB64,
      payload,
      kind: 'direct',
      groupId: null,
      createdAt,
    });
  } catch (e) {
    // If we can't persist to the outbox (e.g. DB not ready on first launch),
    // still attempt the send — the best-effort path is better than silence.
    if (__DEV__) logger.warn('[socket] enqueueOutboxJob failed (best-effort send anyway):', e);
  }

  // If offline, the job is already persisted — return so UI shows offline indicator
  if (!socket || !connected || !authenticated) {
    return; // flushOutbox() will drain on next auth:ok
  }

  // Glare avoidance: if we are the WAITING (lower-aegisId) peer mid-recovery for
  // this contact, do NOT build a fresh session now — that would create a second
  // init the higher peer would ignore (and our message would be lost). The job is
  // already in the outbox; it flushes once the higher peer's init establishes the
  // converged session. We DO send if we are the initiator (our own init is valid).
  if (
    isInRecovery(opts.recipientAegisId) &&
    !amInitiatorFor(opts.identity.aegisId, opts.recipientAegisId)
  ) {
    // [RDIAG] Dev-only (rdiag).
    rdiag(
      `[RDIAG] deferring send to outbox (waiting for peer init) me=${opts.identity.aegisId} peer=${opts.recipientAegisId}`,
    );
    return; // flushOutbox() drains after convergence
  }

  const session = await getOrCreateSession(opts.recipientAegisId, recipientPublicKeyB64, opts.identity);

  // ── Sealed-sender transport selector (v1 vs v2) ─────────────────────────────
  // Use v2 only when: the flag is on, the session is ESTABLISHED (no pending
  // x3dhInit — first contact must bootstrap over v1), and we already hold the
  // recipient's delivery token (shared earlier over E2EE). Otherwise fall back
  // to v1 — the recipient handles both wires.
  const v2Token =
    SEALED_TRANSPORT_VERSION === 'v2' && !session.x3dhInit
      ? await getContactDeliveryToken(opts.recipientAegisId)
      : null;

  let emitEvent: 'envelope' | 'envelope:v2';
  let emitPayload: Record<string, unknown>;
  let newState: RatchetState;
  if (v2Token) {
    const r = encryptMessageV2(
      payload,
      opts.identity.aegisId,
      opts.recipientPublicKey,
      opts.identity.signingSecretKey,
      session,
      Date.now(),
    );
    newState = r.newState;
    emitEvent = 'envelope:v2';
    emitPayload = { id, to: opts.recipientAegisId, ciphertext: r.wire.ciphertext, nonce: r.wire.nonce, epk: r.wire.epk, deliveryToken: v2Token, ...(ephemeralTtlMs ? { ephemeralTtl: ephemeralTtlMs } : {}) };
  } else {
    const r = encryptMessage(payload, opts.identity.aegisId, opts.recipientPublicKey, opts.identity.secretKey, session);
    newState = r.newState;
    emitEvent = 'envelope';
    emitPayload = { id, to: opts.recipientAegisId, ciphertext: r.envelope.ciphertextB64, nonce: r.envelope.nonceB64, ...(ephemeralTtlMs ? { ephemeralTtl: ephemeralTtlMs } : {}) };
  }
  await saveSessionState(opts.recipientAegisId, newState);

  // ── Fase 4: mailbox addressing ──────────────────────────────────────────────
  // When mailbox mode is up and we hold the recipient's mailbox root, route the
  // SAME v2 wire over the dedicated mailbox socket, addressed to their opaque
  // rotating mailbox id — the relay learns neither `from` nor real `to`. The
  // mailbox socket is itself possession-authenticated, so no deliveryToken is
  // needed (the relay rate-limits per sending mailbox). Ephemeral messages ride
  // the mailbox too (Slice 5): the TTL bounds only the relay's offline-queue life;
  // the recipient burns from the decrypted payload.
  //
  // DELIVERY-CONFIRMED (no silent loss): we treat the mailbox send as terminal
  // success ONLY when the relay reports `delivered:true` — i.e. the recipient's
  // mailbox socket was LIVE and got the wire immediately. A merely-`queued` ack
  // (recipient's mailbox offline) is NOT trusted: the recipient's Tor mailbox may
  // never come up (slow/flaky bootstrap on mobile), leaving the queued blob to
  // silently expire undelivered. On queued/null/!ok we fall through to the aegisId
  // transport, whose offline queue the recipient reliably drains on its normal
  // (non-Tor) socket connect. The queued mailbox copy is harmless — it dedups by
  // `id` (INSERT OR REPLACE) if ever drained, or expires. Mailbox stays the
  // preferred path whenever both peers are online; the fallback only fires when
  // mailbox delivery cannot be confirmed. Also falls back when not eligible: no
  // recipient root yet, or our own mailbox socket isn't authed.
  if (emitEvent === 'envelope:v2' && MAILBOX_ENABLED && isMailboxAuthed()) {
    const mboxTo = await getContactCurrentMailboxId(opts.recipientAegisId, Date.now());
    if (mboxTo) {
      const ack = await sendViaMailbox({
        id,
        to: mboxTo,
        ciphertext: emitPayload.ciphertext as string,
        nonce: emitPayload.nonce as string,
        epk: emitPayload.epk as string,
        ...(ephemeralTtlMs ? { ephemeralTtl: ephemeralTtlMs } : {}),
      });
      // Only a LIVE mailbox delivery is terminal. `queued` (recipient mailbox
      // offline) falls through so the reliable aegisId transport also delivers.
      if (mailboxAckConfirmsDelivery(ack)) {
        try { await deleteOutboxJob(jobId); } catch { /* non-fatal */ }
        // Multi-device self-copy stays on the aegisId control socket (it is
        // identity-scoped sync, not a recipient-graph leak). Same as below.
        const selfEphemeralSeconds = expiresAt ? Math.round((expiresAt - createdAt) / 1000) : 0;
        void sendSelfCopy(socket!, opts.identity, opts.recipientAegisId, id, payload, {
          viewOnce: msgType === 'view_once',
          ephemeralSeconds: selfEphemeralSeconds,
        });
        return;
      }
      // queued / null / !ok → fall through to the aegisId transport (no silent loss).
    }
  }

  try {
    await new Promise<void>((resolve, reject) => {
      socket!
        .timeout(EMIT_ACK_TIMEOUT_MS)
        .emit(
          emitEvent,
          emitPayload,
          (err: Error | null, ack?: { ok: boolean; queued?: boolean; error?: string }) => {
            // `.timeout()` changes the ack callback to (err, ack): err is set
            // when the server never responds in time (zombie transport / lost
            // frame) — treat identically to an explicit !ok failure below.
            if (err) { reject(err); return; }
            if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'send_failed'));
            else resolve();
          },
        );
    });
    // ACK received — remove from outbox
    try { await deleteOutboxJob(jobId); } catch { /* non-fatal */ }
  } catch (e) {
    // Emit failed — job stays in outbox for retry on next reconnect
    if (__DEV__) logger.warn('[socket] sendMessage emit failed, job retained in outbox:', e);
    try { await incrementOutboxAttempts(jobId); } catch { /* non-fatal */ }
    throw e; // surface to caller so UI can show error
  }

  // Multi-device sync: also push a self-encrypted copy so the user's other
  // devices can render this message as direction:'out'. Best-effort — never
  // throws, never blocks the primary send result.
  const ephemeralSeconds = expiresAt ? Math.round((expiresAt - createdAt) / 1000) : 0;
  void sendSelfCopy(
    socket!,
    opts.identity,
    opts.recipientAegisId,
    id,
    payload,
    {
      viewOnce: msgType === 'view_once',
      ephemeralSeconds,
    },
  );
}

/**
 * Push a silent profile-update envelope to every contact. Receivers apply the
 * new senderName/Color/Image via updateContactProfile without writing anything
 * to their chat history. Failures are swallowed per-contact so one offline
 * peer doesn't block the rest.
 */
/**
 * Persist a received group avatar (data URI) to documentDirectory so the file
 * survives app restarts. Returns the local file:// path on success, or
 * undefined on failure (caller falls back to no avatar).
 * Groups that never send an avatar leave this function un-called.
 */
async function saveGroupAvatarToFile(groupId: string, dataUri: string): Promise<string | undefined> {
  try {
    const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
    const dir = `${FS.documentDirectory}avatars/`;
    await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
    // Sanitise groupId for use as a filename — replace anything that isn't
    // alphanumeric or underscore with '_'.
    const safe = groupId.replace(/[^a-zA-Z0-9_]/g, '_');
    const path = `${dir}group_${safe}.jpg`;
    const base64 = dataUri.includes(',') ? dataUri.split(',')[1] : dataUri;
    await FS.writeAsStringAsync(path, base64, { encoding: FS.EncodingType.Base64 });
    return path;
  } catch {
    return undefined;
  }
}

/** Convert a local file:// or content:// URI to a data: URI by reading the file as base64.
 *  Returns the original string unchanged if it is already a data: URI, emoji, or null. */
async function toDataUri(imageField: string | null): Promise<string | null> {
  if (!imageField) return null;
  if (imageField.startsWith('data:') || imageField.startsWith('http')) return imageField;
  // Emoji or short non-path string — pass through as-is (used as avatar text)
  if (!imageField.startsWith('file://') && !imageField.startsWith('content://')) return imageField;
  try {
    // expo-file-system v19 removed EncodingType/readAsStringAsync from the main
    // entry point — use the legacy subpath which still exports them.
    const { readAsStringAsync, EncodingType } = require('expo-file-system/legacy');
    const b64 = await readAsStringAsync(imageField, { encoding: EncodingType.Base64 });
    return `data:image/jpeg;base64,${b64}`;
  } catch (e) {
    if (__DEV__) logger.warn('[socket] toDataUri failed:', e);
    return null;
  }
}

/**
 * Cheap, stable fingerprint (FNV-1a) of the broadcast-relevant profile fields.
 * NOT cryptographic — it only answers "did my own profile change since the last
 * broadcast?", so a rare collision would at worst defer ONE profile refresh to a
 * contact until the next real change (self-healing), never corrupt anything.
 */
function profileFingerprint(canonical: string): string {
  let h = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < canonical.length; i++) {
    h ^= canonical.charCodeAt(i);
    h = Math.imul(h, 0x01000193); // FNV-1a 32-bit prime
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** SecureStore key holding the last successfully-broadcast profile fingerprint. */
function profileBroadcastHashKey(aegisId: string): string {
  return `aegis.pbh.${aegisId}`;
}

export async function broadcastProfileUpdate(identity: Identity): Promise<void> {
  if (!socket || !connected || !authenticated) return;

  const { useIdentity } = require('../store/identity');
  const idState = useIdentity.getState();
  const senderName = idState.displayName;
  const senderColor = idState.avatarColor;
  const senderStatus = idState.profileStatus;
  const rawImage = idState.avatarImage;
  // Encode local file URIs to base64 data URIs so other devices can render them
  const senderImage = await toDataUri(rawImage);

  // Identity-global fields (identical for every contact) — compute once, out of
  // the loop, and fold them into the change fingerprint below.
  const deliveryTokenField = await ownDeliveryTokenField();
  const mailboxRootField = await ownMailboxRootField();

  // Phantom-notification guard (audit 2026-07-26). A profile broadcast is a real
  // E2EE envelope: to an OFFLINE contact the relay queues it and fires the SAME
  // generic "Nuevo mensaje cifrado" wake-up push as a real message — but on open
  // there is nothing to show (profile_update is applied silently). Broadcasting on
  // EVERY auth:ok therefore spammed every established contact with a phantom
  // notification on each reconnect. The broadcast only needs to propagate a
  // CHANGE — brand-new contacts receive the profile with the first message, and
  // the !existing guard below skips sessionless peers — so skip the whole thing
  // when nothing has changed since the last broadcast for THIS identity.
  const fingerprint = profileFingerprint(
    JSON.stringify({ senderName, senderColor, senderStatus, senderImage, ...deliveryTokenField, ...mailboxRootField }),
  );
  const hashKey = profileBroadcastHashKey(identity.aegisId);
  try {
    if ((await SecureStore.getItemAsync(hashKey)) === fingerprint) return;
  } catch { /* unreadable → fall through and broadcast (correctness over dedupe) */ }

  const contacts = useContacts.getState().contacts;
  for (const contact of contacts) {
    try {
      // CRITICAL: a profile broadcast must NEVER initiate a session. When both
      // peers connect and broadcast, each would run X3DH as initiator for a
      // contact it has no session with → two mismatched sessions (glare) that
      // never converge → "messages don't arrive / profile won't sync". Only
      // refresh the profile over an ALREADY-ESTABLISHED session. For brand-new
      // contacts the profile is exchanged when the first real message sets up the
      // session (initiator's message + the responder's adopt-reply in
      // decryptAndAppend). Skip peers we have no session with.
      const existing = await loadRatchetSession(contact.aegisId);
      if (!existing) continue;
      const recipientPub = decodeBase64(contact.publicKeyB64);
      const payload = JSON.stringify({
        type: 'profile_update',
        senderName,
        senderColor,
        senderImage,
        senderStatus,
        ...deliveryTokenField,
        ...mailboxRootField,
      });
      const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, identity);
      const isInit = !!session.x3dhInit;
      const { envelope, newState } = encryptMessage(
        payload,
        identity.aegisId,
        recipientPub,
        identity.secretKey,
        session
      );
      await saveSessionState(contact.aegisId, newState);

      const id = Crypto.randomUUID();
      socket!.emit('envelope', {
        id,
        to: contact.aegisId,
        ciphertext: envelope.ciphertextB64,
        nonce: envelope.nonceB64,
        ...(isInit ? { init: true } : {}),
      });
    } catch (e) {
      if (__DEV__) logger.warn('[socket] profile broadcast failed:', (e as Error).message);
    }
  }

  // Persist the fingerprint only AFTER the broadcast attempt, so a change is
  // always sent at least once. Best-effort: a write failure just re-broadcasts on
  // the next connect — a bounded, self-healing cost, never a lost update.
  try {
    await SecureStore.setItemAsync(hashKey, fingerprint, {
      keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
    });
  } catch { /* best-effort */ }
}

/** Send our profile (name + avatar as data URI) to one specific contact. */
export async function sendProfileTo(contact: { aegisId: string; publicKeyB64: string }, identity: Identity, lockCtx?: LockCtx): Promise<void> {
  const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
  const idState = useIdentity.getState();
  const senderImage = await toDataUri(idState.avatarImage);
  const payload = JSON.stringify({
    type: 'profile_update',
    senderName: idState.displayName,
    senderColor: idState.avatarColor,
    senderImage,
    senderStatus: idState.profileStatus,
    ...(await ownDeliveryTokenField()),
    ...(await ownMailboxRootField()),
  });

  // Persist the first-contact profile/init in the outbox so it is retried on the
  // next reconnect. Without this, adding a contact while WE are offline silently
  // dropped the init — the peer never received it, never auto-added us, and the
  // reconnect broadcast skips session-less contacts, so the two sides never
  // converged (the user had to re-add manually on the other device).
  const enqueueForRetry = async (): Promise<void> => {
    try {
      await enqueueOutboxJob({
        jobId: Crypto.randomUUID(),
        msgId: Crypto.randomUUID(),
        recipientAegisId: contact.aegisId,
        recipientPubkeyB64: contact.publicKeyB64,
        payload,
        kind: 'direct',
        groupId: null,
        createdAt: Date.now(),
      });
      rdiag(`[RDIAG] sendProfileTo ENQUEUED (offline) to=${contact.aegisId}`);
    } catch (e) {
      if (__DEV__) logger.warn('[socket] sendProfileTo enqueue failed:', (e as Error).message);
    }
  };

  // Offline / not yet authenticated: don't emit (and don't advance the ratchet);
  // queue it and let flushOutbox() re-encrypt + send on the next auth:ok.
  if (!socket || !connected || !authenticated) {
    await enqueueForRetry();
    return;
  }

  try {
    const recipientPub = decodeBase64(contact.publicKeyB64);
    // Forward lockCtx so that when this runs inside a desync-recovery (already
    // holding contact.aegisId's lock) the nested acquire passes through.
    const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, identity, lockCtx);
    // Mark first-contact (X3DH-initial) envelopes `init` so the relay attaches
    // our public key when queued for an offline recipient — otherwise the peer
    // cannot decrypt this first profile message and never auto-adds us back.
    const isInit = !!session.x3dhInit;
    const { envelope, newState } = encryptMessage(payload, identity.aegisId, recipientPub, identity.secretKey, session);
    await saveSessionState(contact.aegisId, newState);
    socket!.emit('envelope', { id: Crypto.randomUUID(), to: contact.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64, ...(isInit ? { init: true } : {}) });
    rdiag(`[RDIAG] sendProfileTo EMITTED to=${contact.aegisId} isInit=${isInit}`);
  } catch (e) {
    rdiag(`[RDIAG] sendProfileTo FAILED to=${contact.aegisId} err=${(e as Error).message}`);
    if (__DEV__) logger.warn('[socket] sendProfileTo failed:', (e as Error).message);
    await enqueueForRetry();
  }
}

// Per-peer record of the last sealed typing signal sent (mailbox mode), used by
// shouldSendSealedTyping to throttle keystroke-rate refreshes. Keyed by aegisId.
const sealedTypingState = new Map<string, { isTyping: boolean; at: number }>();

export function emitTyping(to: string, isTyping: boolean): void {
  if (!socket || !authenticated) return;
  if (MAILBOX_ENABLED) {
    // The plaintext `typing` event carries the peer's aegisId on the control-
    // plane socket, relinking the me↔to edge mailbox mode just sealed. Send it
    // SEALED through the E2EE channel instead (same pattern as read receipts).
    // It arrives with mailbox/Tor latency — acceptable for a best-effort signal.
    const now = Date.now();
    if (!shouldSendSealedTyping(sealedTypingState.get(to), isTyping, now)) return;
    sealedTypingState.set(to, { isTyping, at: now });
    const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
    const identity = useIdentity.getState().identity;
    const contact = useContacts.getState().contacts.find((c) => c.aegisId === to);
    if (!identity || !contact?.publicKeyB64) return;
    void sendMessage({
      identity,
      recipientAegisId: to,
      recipientPublicKey: decodeBase64(contact.publicKeyB64),
      plaintext: JSON.stringify({ isTyping }),
      type: 'typing',
      expiresAt: null,
      skipLocalAppend: true,
    }).catch((e) => {
      if (__DEV__) logger.warn('[socket] sealed typing failed:', (e as Error).message);
    });
    return;
  }
  socket.emit('typing', { to, isTyping });
}

export function sendReadReceipts(to: string, msgIds: string[]): void {
  if (!socket || !authenticated || msgIds.length === 0) return;
  // Mailbox mode: send the receipt sealed through the E2EE channel so the relay
  // never sees the me↔to aegisId edge on the plaintext control-plane socket.
  // Outside mailbox mode, keep the lightweight plaintext event — it exposes no
  // more than the v2 message transport already does (same aegisId routing).
  if (MAILBOX_ENABLED) {
    const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
    const identity = useIdentity.getState().identity;
    const contact = useContacts.getState().contacts.find((c) => c.aegisId === to);
    if (!identity || !contact?.publicKeyB64) return;
    void sendMessage({
      identity,
      recipientAegisId: to,
      recipientPublicKey: decodeBase64(contact.publicKeyB64),
      plaintext: JSON.stringify(msgIds),
      type: 'read_receipt',
      expiresAt: null,
      skipLocalAppend: true,
    }).catch((e) => {
      if (__DEV__) logger.warn('[socket] sealed read receipt failed:', (e as Error).message);
    });
    return;
  }
  socket.emit('msg:read', { to, msgIds });
}

export function sendDeleteForEveryone(to: string, msgId: string): void {
  // E2EE + durable: rides the normal sealed message path (Double Ratchet,
  // outbox retry, mailbox delivery). The old plaintext `msg:delete` event
  // leaked the sender↔recipient pair to the relay and was silently dropped
  // whenever the peer had no live socket — mailbox-mode peers almost never do.
  const { useIdentity } = require('../store/identity') as typeof import('../store/identity');
  const identity = useIdentity.getState().identity;
  const contact = useContacts.getState().contacts.find((c) => c.aegisId === to);
  if (!identity || !contact?.publicKeyB64) {
    if (__DEV__) logger.warn('[socket] sendDeleteForEveryone: missing identity or peer key — not sent');
    return;
  }
  void sendMessage({
    identity,
    recipientAegisId: to,
    recipientPublicKey: decodeBase64(contact.publicKeyB64),
    plaintext: msgId,
    type: 'msg_delete',
    expiresAt: null,
    skipLocalAppend: true,
  }).catch((e) => {
    if (__DEV__) logger.warn('[socket] sendDeleteForEveryone failed:', (e as Error).message);
  });
}

export async function sendGroupMessage(opts: {
  identity: Identity;
  groupId: string;
  plaintext: string;
  /** Optional message type override: 'audio' | 'image' | 'file' etc. */
  msgType?: string;
  /** Optional encrypted blob URI: blob:<id>:<key>:<nonce> */
  mediaUri?: string;
  /**
   * When true, skip the optimistic local append. Use this when the caller
   * already pre-appended a bubble (e.g. image/video/audio media messages).
   * Mirrors the same flag on sendMessage() for 1:1 chats.
   */
  skipLocalAppend?: boolean;
  /**
   * Admin-only, signed group-dissolution marker (see groupSig.ts,
   * canonicalGroupDissolveBytes). When present the payload carries
   * `dissolved: true` + `dissolveSig` so every member's receive path can
   * verify-then-wipe the group. Set only by broadcastGroupDissolve.
   */
  dissolve?: { adminId: string; dissolveSig: string };
}): Promise<void> {
  const { getGroup, saveGroup } = require('../db/local');
  const group = await getGroup(opts.groupId);
  if (!group) throw new Error('group_not_found');

  // Compute the size gate ONCE, before any signing or the fan-out loop. Large
  // groups (> threshold) use the v2 roster-by-reference wire format; small
  // groups stay on the v1 path with the roster inlined every message.
  const { LARGE_GROUP_THRESHOLD } = require('../store/groups') as typeof import('../store/groups');
  const isLarge = group.members.length > LARGE_GROUP_THRESHOLD;

  // Roster reference fields are computed ONCE here (not per-member) so the cost
  // is O(1) regardless of group size — this is the whole point of v2.
  const rosterHash = computeRosterHash(group.members);
  const rosterVersion = group.rosterVersion ?? 1;

  // Ensure the group has an admin signature. If we created the group locally
  // and never signed it yet (legacy install), sign it now with our identity
  // signing key and persist. Receivers will validate before honoring metadata.
  // The signature format must match the size gate: v2 for large, v1 for small.
  if (!group.adminId) {
    group.adminId = opts.identity.aegisId;
  }
  if (group.adminId === opts.identity.aegisId && !group.adminSig) {
    group.adminSig = isLarge
      ? signGroupMetadataV2(
          { groupId: group.id, groupName: group.name, rosterHash, rosterVersion, createdAt: group.createdAt },
          opts.identity.signingSecretKey,
        )
      : signGroupMetadata(
          { groupId: group.id, groupName: group.name, members: group.members, createdAt: group.createdAt },
          opts.identity.signingSecretKey,
        );
    await saveGroup(group);
  }

  // The full roster is sent ONLY in carrier messages (metadata sync). For large
  // groups this is the single message type that transports the member list;
  // content messages omit it and rely on the receiver's locally-trusted roster.
  const isCarrier = opts.plaintext === GROUP_META_SYNC_BODY;

  const contacts = useContacts.getState().contacts;

  // Read identity fields once, outside the per-member loop
  const { useIdentity: _useIdentity } = require('../store/identity') as typeof import('../store/identity');
  const _idState = _useIdentity.getState();
  const senderName = _idState.displayName;
  const senderColor = _idState.avatarColor;
  const rawImage = _idState.avatarImage;

  // Pre-compute the sender data URI once if at least one member hasn't received it yet.
  // Same profiledContacts optimization as 1:1 messages — image is sent only on
  // the first message per contact per session to avoid embedding a 50–100 KB blob
  // in every group envelope.
  const anyNeedsImage = group.members.some(
    (m: string) => m !== opts.identity.aegisId && !profiledContacts.has(m),
  );
  const imageDataUri = anyNeedsImage ? await toDataUri(rawImage) : null;

  // Group avatar: color always included (7 bytes). Image included only on the
  // first message per group per session — same optimization as senderImage.
  const groupAvatarColor = group.avatarColor ?? null;
  const groupAvatarImage = profiledGroupImages.has(group.id)
    ? null
    : await toDataUri(group.avatarImage ?? null);
  if (groupAvatarImage) profiledGroupImages.add(group.id);

  const nowMs = Date.now();

  // ── Per-member outbox fan-out ────────────────────────────────────────────────
  // Fan-out is sequential so that ratchet state advances monotonically and
  // FIFO ordering within each session is preserved.
  // Each member gets its own outbox job so a delivery failure to one member
  // does NOT silently drop the message — it stays pending for that member
  // and is retried on the next reconnect/drain.
  for (const memberId of group.members) {
    if (memberId === opts.identity.aegisId) continue;
    // Group membership is defined by the roster, NOT by the sender's personal
    // contact list. A member we have not added manually must still receive the
    // message, otherwise two members who never added each other can never talk
    // in a shared group. Resolve the recipient from contacts when present, else
    // materialize them from the directory (same auto-add the RECEIVE path does
    // for unknown senders — keeps both directions symmetric and caches the key).
    let contact = contacts.find((c) => c.aegisId === memberId);
    if (!contact) {
      try {
        contact = await useContacts.getState().addByAegisId(memberId);
      } catch (e) {
        // Truly unresolvable (offline, or not in the directory yet). Skip this
        // member for now — the outbox/retry path is per-contact, so we cannot
        // queue without a pubkey; they will be reachable once resolvable.
        if (__DEV__) logger.warn('[socket] group fan-out: could not resolve member', memberId, e);
        continue;
      }
    }
    if (!contact) continue;

    const senderImage = profiledContacts.has(contact.aegisId) ? null : imageDataUri;
    if (senderImage) profiledContacts.add(contact.aegisId);

    const msgId = Crypto.randomUUID();

    // Roster transport policy:
    //  • Small group (v1): always inline `members` — unchanged from before.
    //  • Large group + carrier: inline `members` + roster reference (the ONLY
    //    message that ships the full list in a large group).
    //  • Large group + content: OMIT `members`; ship only the roster reference.
    //    The signed v2 metadata lets the receiver verify authenticity against
    //    its locally-trusted roster without re-sending the list. Constant size.
    const includeMembers = !isLarge || isCarrier;
    const rosterFields = isLarge
      ? { rosterHash, rosterVersion }
      : {};

    const payload = JSON.stringify({
      type: 'group_msg',
      groupId: group.id,
      groupName: group.name,
      ...(includeMembers ? { members: group.members } : {}),
      ...rosterFields,
      groupCreatedAt: group.createdAt,
      adminId: group.adminId,
      adminSig: group.adminSig,
      // Governance (roles + permissions), Phase 2b. Included only when signed —
      // admins/moderators travel too so the receiver can reconstruct the exact
      // canonical bytes the owner signed. Absent → receiver keeps local defaults
      // (graceful degradation for pre-governance senders).
      ...(group.govSig
        ? {
            admins: group.admins ?? [],
            moderators: group.moderators ?? [],
            permissions: group.permissions,
            govSig: group.govSig,
            govVersion: group.govVersion,
          }
        : {}),
      groupAvatarColor,
      groupAvatarImage,
      // Group dissolution (admin only, signed — see canonicalGroupDissolveBytes).
      // Absent for every ordinary message; only set by broadcastGroupDissolve.
      ...(opts.dissolve
        ? { dissolved: true, dissolveAdminId: opts.dissolve.adminId, dissolveSig: opts.dissolve.dissolveSig }
        : {}),
      senderId: opts.identity.aegisId,
      senderName,
      senderColor,
      senderImage,
      body: opts.plaintext,
      msgType: opts.msgType ?? null,
      mediaUri: opts.mediaUri ?? null,
    });

    // Persist to outbox BEFORE emitting so the job survives app close/crash.
    const jobId = Crypto.randomUUID();
    try {
      await enqueueOutboxJob({
        jobId,
        msgId,
        recipientAegisId: contact.aegisId,
        recipientPubkeyB64: contact.publicKeyB64,
        payload,
        kind: 'group',
        groupId: opts.groupId,
        createdAt: nowMs,
      });
    } catch (e) {
      // Outbox write failed — still attempt the send (best-effort path)
      if (__DEV__) logger.warn('[socket] group enqueueOutboxJob failed for member', contact.aegisId, e);
    }

    // If offline, job is already persisted — skip emit; flushOutbox handles it.
    if (!socket || !connected || !authenticated) continue;

    try {
      const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, opts.identity);
      // Sealed-sender selector (shared with flushOutbox / sendMessage): group
      // message content is per-member envelopes, so v2 hides the sender's
      // aegisId from the relay for group chat exactly as it does for 1:1.
      const { event, wire, newState } = await buildOutgoingEnvelope(
        payload,
        contact.aegisId,
        decodeBase64(contact.publicKeyB64),
        opts.identity,
        session,
      );
      await saveSessionState(contact.aegisId, newState);

      await new Promise<void>((resolve, reject) => {
        socket!.emit(
          event,
          { id: msgId, to: contact.aegisId, ...wire },
          (ack: { ok: boolean; error?: string } | undefined) => {
            if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'send_failed'));
            else resolve();
          },
        );
      });
      // ACK ok — delete from outbox
      try { await deleteOutboxJob(jobId); } catch { /* non-fatal */ }
    } catch (e) {
      // Delivery failed for this member — job stays in outbox for retry.
      // DO NOT swallow silently: log and increment attempts so monitoring can detect stuck jobs.
      if (__DEV__) logger.warn('[socket] group message delivery failed for member', contact.aegisId, '— job retained in outbox', e);
      try { await incrementOutboxAttempts(jobId); } catch { /* non-fatal */ }
      // Continue to next member — one failure must not block others.
    }
  }

  // Optimistic local append — skip when caller already pre-appended (e.g. media messages)
  if (!opts.skipLocalAppend) {
    const localId = Crypto.randomUUID();
    await useMessages.getState().append({
      id: localId,
      chatId: opts.groupId,
      direction: 'out',
      // Store the RAW body (no "name: " prefix). The sender's own bubble never
      // strips/show a sender prefix (only incoming messages do, see
      // GroupMessageBubble), so prefixing here broke special bodies on the
      // sender's screen — e.g. `[poll:…]`/`[gif:…]` failed their startsWith()
      // parse and rendered as literal text.
      body: opts.plaintext,
      createdAt: nowMs,
      type: (opts.msgType as 'text' | 'image' | 'audio' | 'file' | 'poll' | 'location' | 'view_once' | undefined) ?? 'text',
      mediaUri: opts.mediaUri ?? undefined,
    });
  }
}

/**
 * Push the current (already-persisted, re-signed) group metadata — name,
 * members, avatar color/image — to every member RIGHT NOW, without waiting for
 * the admin's next chat message and without showing a bubble on either side.
 *
 * Members apply the change through the normal group_msg metadata path (which
 * runs for every group message); the `[group:meta]` body is then suppressed on
 * receipt. The avatar image data URI rides along only when the caller has
 * re-armed it via forgetGroupAvatarSent() (e.g. after updateGroupAvatar).
 *
 * Offline-safe: sendGroupMessage enqueues per-member outbox jobs, so the sync
 * is retried on the next reconnect if the admin is offline.
 */
export async function broadcastGroupMetadata(identity: Identity, groupId: string): Promise<void> {
  await sendGroupMessage({
    identity,
    groupId,
    plaintext: GROUP_META_SYNC_BODY,
    skipLocalAppend: true,
  });
}

/**
 * Admin-only: dissolve a group for every member. Signs a dedicated
 * {groupId, adminId, createdAt} marker (canonicalGroupDissolveBytes) — NOT the
 * roster/name signature, which covers different bytes — so a non-admin, or a
 * replay against a different group, can never forge it. The signed marker
 * rides the existing group_msg carrier (`[group:dissolved]` body, no bubble),
 * fanned out to every member via sendGroupMessage's outbox, so it survives the
 * caller being offline. The caller (store/groups.ts dissolveGroup) is
 * responsible for wiping the group LOCALLY only after this resolves — mirrors
 * the "broadcast first, then local wipe" ordering used by leaveGroup's peers
 * (removeMember re-keys/broadcasts before touching local state).
 *
 * Throws if the local identity is not the group's admin — callers must gate
 * on `group.adminId === identity.aegisId` before invoking (dissolveGroup does).
 */
export async function broadcastGroupDissolve(identity: Identity, groupId: string): Promise<void> {
  const { getGroup } = require('../db/local');
  const group = await getGroup(groupId);
  if (!group) throw new Error('group_not_found');
  if (group.adminId !== identity.aegisId) throw new Error('not_group_admin');

  const { signGroupDissolve } = require('../crypto/groupSig') as typeof import('../crypto/groupSig');
  const dissolveSig = signGroupDissolve(
    { groupId, adminId: identity.aegisId, createdAt: group.createdAt },
    identity.signingSecretKey,
  );

  await sendGroupMessage({
    identity,
    groupId,
    plaintext: GROUP_DISSOLVE_BODY,
    skipLocalAppend: true,
    dissolve: { adminId: identity.aegisId, dissolveSig },
  });
}

/**
 * Send an anonymous vote to all members of a group.
 *
 * Wire-format guarantee (audited 2026-05):
 *   The plaintext `[vote:<messageId>:<optionIndex>]` is wrapped in a
 *   `group_msg` JSON payload and then encrypted per-recipient through the
 *   Double Ratchet (`encryptMessage` → XSalsa20-Poly1305 secretbox over a
 *   chain-key-derived message key). The object handed to `socket.emit`
 *   contains ONLY: { id, to, ciphertext, nonce }. The optionIndex never
 *   appears on the wire in cleartext, nor does any field named `vote`,
 *   `optionIndex`, `pollId`, etc. Relay sees opaque bytes; only group
 *   members holding the ratchet state can recover the vote.
 *
 * The vote is NOT appended to the local chat history.
 */
export async function sendGroupVote(opts: {
  identity: Identity;
  groupId: string;
  pollMessageId: string;
  optionIndex: number;
  /** Commitment and nonce produced by usePollsStore.castVote — required for anonymity. */
  commitment: string;
  nonceHex: string;
}): Promise<void> {
  // Wire format: [vote:<pollId>:<optionIndex>:<commitment>:<nonceHex>]
  // The commitment = sha256(aegisId + pollId + nonceHex) lets receivers deduplicate
  // without learning the voter identity.  senderId is still present in the outer
  // group_msg envelope (needed for ratchet state attribution) but is NOT used to
  // attribute the vote — receivers MUST ignore senderId for vote counting purposes.
  const plaintext = `[vote:${opts.pollMessageId}:${opts.optionIndex}:${opts.commitment}:${opts.nonceHex}]`;

  if (!socket || !connected || !authenticated) {
    // Votes are best-effort (anonymous commitment scheme) — if offline, drop silently.
    // The user will need to reconnect and re-cast the vote.
    return;
  }

  const { getGroup } = require('../db/local');
  const group = await getGroup(opts.groupId);
  if (!group) return;

  const contacts = useContacts.getState().contacts;

  const { useIdentity } = require('../store/identity');
  const idState = useIdentity.getState();
  const senderName = idState.displayName;
  const senderColor = idState.avatarColor;

  const sendPromises = group.members.map(async (memberId: string) => {
    if (memberId === opts.identity.aegisId) return;
    const contact = contacts.find((c: { aegisId: string }) => c.aegisId === memberId);
    if (!contact) return;

    const payload = JSON.stringify({
      type: 'group_msg',
      groupId: group.id,
      groupName: group.name,
      members: group.members,
      senderId: opts.identity.aegisId,
      senderName,
      senderColor,
      senderImage: null,
      body: plaintext,
    });

    try {
      const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, opts.identity);
      const { envelope, newState } = encryptMessage(
        payload,
        opts.identity.aegisId,
        decodeBase64(contact.publicKeyB64),
        opts.identity.secretKey,
        session
      );
      await saveSessionState(contact.aegisId, newState);

      const envId = Crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        socket!.emit(
          'envelope',
          { id: envId, to: contact.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 },
          (ack: { ok: boolean; error?: string } | undefined) => {
            if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'vote_send_failed'));
            else resolve();
          }
        );
      });
    } catch (e) {
      if (__DEV__) logger.warn('[socket] sendGroupVote failed for member', memberId, e);
    }
  });

  await Promise.all(sendPromises);
}
