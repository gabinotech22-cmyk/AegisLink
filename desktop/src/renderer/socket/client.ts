/**
 * AegisLink Desktop — Socket.IO relay client (Electron renderer).
 *
 * Ported from mobile/src/socket/client.ts.
 * Changes vs. mobile:
 *  - expo-crypto.randomUUID() → crypto.randomUUID() (Web Crypto API, Chromium)
 *  - expo-secure-store → window.aegis.secureStorage (IPC to main process keychain)
 *  - expo-file-system → URL.createObjectURL / fetch for media cache (browser APIs)
 *  - react-native Platform / expo-notifications → removed; desktop has no push tokens
 *  - __DEV__ guard → import.meta.env.DEV (Vite)
 *  - SERVER_URL → RELAY_URL from ../config
 *  - require('../notifications/push') → static import from ../notifications/push
 */

import { logger } from '../utils/logger';
import { io, type Socket } from 'socket.io-client';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha2.js';
import { RELAY_URL, SEALED_TRANSPORT_VERSION, MAILBOX_ENABLED } from '../config';
import { encryptMessage, openEnvelope, encryptMessageV2, openEnvelopeV2, parseRatchetHeader } from '../crypto/messaging';
import { getOwnDeliveryToken, hashDeliveryToken, setContactDeliveryToken, getContactDeliveryToken } from '../crypto/deliveryToken';
import { getOwnMailboxRootB64, setContactMailboxRoot, getContactCurrentMailboxId } from '../crypto/mailboxStore';
import { connectMailboxSocket, disconnectMailboxSocket, sendViaMailbox, isMailboxAuthed } from './mailboxSocket';
import type { SealedWire } from '../crypto/sealedSender';
import type { Identity } from '../crypto/identity';
import { spkRotationDecision, spkPruneTargetKeyId } from './spkRotation';
import { serializeRatchetState, reviveRatchetState } from './ratchetSerde';
import { useContacts } from '../store/contacts';
import { useConnection } from '../store/connection';
import { useMessages } from '../store/messages';
import {
  performX3DH,
  performX3DHReceiver,
  generatePreKeys,
  shouldUsePqReceiver,
  type PreKeyBundle,
  type PqSignedPreKeyPublic,
} from '../crypto/signal/x3dh';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { useSecurityDiagnostics } from '../store/securityDiagnostics';
import {
  initRatchet,
  ratchetDecrypt,
  ratchetEncrypt,
  trimOldSkippedKeys,
  MAX_SKIPPED_KEYS,
  type RatchetState,
} from '../crypto/signal/ratchet';
import { stripAndPad } from '../crypto/metadata';
import { loadRatchetSession, saveRatchetSession, deleteContactRatchetSession } from '../db/local';
import { showIncomingNotification } from '../notifications/push';
import { useTyping } from '../store/typing';
import { useCall } from '../store/call';

const DEV = import.meta.env.DEV;

// Verbose ratchet-state diagnostics are gated behind a DEDICATED opt-in flag,
// never the general DEV flag — DEV can be true in staging/test Electron builds
// where we still don't want ratchet counters/key fingerprints in the console.
// (Golden rule #6.) Fingerprints below are hashed, not raw key prefixes.
const RATCHET_DEBUG =
  DEV &&
  typeof localStorage !== 'undefined' &&
  localStorage.getItem('AEGIS_RATCHET_DEBUG') === '1';

/** Non-reversible 6-hex fingerprint for diagnostics (SHA-256 prefix). */
const ratchetFp = (b: Uint8Array | null): string =>
  b ? encodeBase64(sha256(b)).slice(0, 6) : 'null';

const AEGIS_ID_RE = /^[0-9A-HJKMNP-TV-Z]{3}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/;

// ── SecureStore shim: delegates to window.aegis.secureStorage via Electron IPC ──
const SecureStore = {
  getItemAsync: (key: string): Promise<string | null> => window.aegis.secureStorage.get(key),
  setItemAsync: (key: string, value: string): Promise<void> =>
    window.aegis.secureStorage.set(key, value),
  deleteItemAsync: (key: string): Promise<void> => window.aegis.secureStorage.delete(key),
};

// ── Slot prefix helpers (mirrors mobile logic) ────────────────────────────────
const getSlotPrefix = (): string => {
  // Desktop supports a single slot for now — multi-profile support is Fase 11+
  return '';
};

const SECURE_SPK_SECRET_KEY = () => `aegis.${getSlotPrefix()}spkSecret.b64`;
const SECURE_SPK_KEYID_KEY = () => `aegis.${getSlotPrefix()}spk.keyId`;
// B-3: wall-clock ms at which the current SPK was created — powers age-based
// rotation. Desktop mirrors mobile's DB sentinel using the encrypted keystore.
const SECURE_SPK_CREATED_KEY = () => `aegis.${getSlotPrefix()}spk.createdAt`;
const SECURE_OPK_IDS_KEY = () => `aegis.${getSlotPrefix()}opkIds.json`;
const opkSecretKey = (keyId: number) => `aegis.${getSlotPrefix()}opkSecret.${keyId}`;
const spkSecretKey = (keyId: number) => `aegis.${getSlotPrefix()}spkSecret.${keyId}`;
// PQXDH (v2): ML-KEM-768 signed PQ prekey secret (2400 bytes) per keyId, plus a
// durable counter of the current keyId. Mirrors mobile's DB-backed PQSPK store,
// but desktop persists in the encrypted keystore (window.aegis.secureStorage).
const pqSpkSecretKey = (keyId: number) => `aegis.${getSlotPrefix()}pqSpkSecret.${keyId}`;
const SECURE_PQSPK_KEYID_KEY = () => `aegis.${getSlotPrefix()}pqSpk.keyId`;

export async function saveSpkSecret(keyId: number, b64: string): Promise<void> {
  // Keep the per-keyId archive slot (used for older SPKs still referenced by
  // in-flight X3DH inits)…
  await SecureStore.setItemAsync(spkSecretKey(keyId), b64);
  // …but ALSO populate the "current SPK" slots that the inbound decrypt paths
  // actually read (SECURE_SPK_SECRET_KEY / SECURE_SPK_KEYID_KEY). Without this a
  // freshly linked/synced device holds the secret in an archive slot nobody
  // reads and fails every SPK decrypt with "no-spk".
  await SecureStore.setItemAsync(SECURE_SPK_SECRET_KEY(), b64);
  await SecureStore.setItemAsync(SECURE_SPK_KEYID_KEY(), String(keyId));
  try { await SecureStore.setItemAsync(SECURE_SPK_CREATED_KEY(), String(Date.now())); }
  catch { /* best-effort age marker */ }
}

/** Durably persist a PQSPK secret with the SAME write-then-readback invariant
 * as the SPK: never advertise a PQ prekey whose 2400-byte secret we cannot
 * recover (that would silently break every inbound v2 handshake). Returns true
 * only if the secret reads back intact and the keyId counter was advanced. */
export async function persistPqSpkSecret(keyId: number, secret: Uint8Array): Promise<boolean> {
  const b64 = encodeBase64(secret);
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await SecureStore.setItemAsync(pqSpkSecretKey(keyId), b64);
      const back = await SecureStore.getItemAsync(pqSpkSecretKey(keyId));
      if (back === b64) {
        try { await SecureStore.setItemAsync(SECURE_PQSPK_KEYID_KEY(), String(keyId)); }
        catch {/* best-effort counter */}
        return true;
      }
    } catch {/* retry once */}
  }
  return false;
}

/** Read the active PQSPK keyId (the one we last advertised), or null if this
 * device has never published a PQSPK (→ v1-only, weAdvertisedPq = false). */
async function getActivePqSpkKeyId(): Promise<number | null> {
  try {
    const stored = await SecureStore.getItemAsync(SECURE_PQSPK_KEYID_KEY());
    if (!stored) return null;
    const parsed = parseInt(stored, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

// ── B-3: age-based Signed PreKey rotation (Signal ~weekly) ───────────────────
// Rotate the SPK once it exceeds the interval regardless of OPK consumption, so
// a low-volume device that never depletes its OPK pool still gets medium-term
// forward secrecy. The pure decision/prune helpers live in ./spkRotation so the
// node-env vitest suite can test them without the window.aegis import graph.

/** Read the current SPK's creation ms, or null if never stamped (pre-B-3). */
async function getSpkCreatedAt(): Promise<number | null> {
  try {
    const stored = await SecureStore.getItemAsync(SECURE_SPK_CREATED_KEY());
    if (!stored) return null;
    const parsed = parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * True iff the current SPK is older than the rotation interval. Lazy backfill:
 * a pre-B-3 install has an SPK but no stamp — we stamp `now` and return false so
 * the upgrade does not force-rotate every device at once (which would needlessly
 * invalidate in-flight first-contact handshakes). Same policy as mobile.
 */
async function isSignedPreKeyStale(now: number): Promise<boolean> {
  const created = await getSpkCreatedAt();
  const { rotate, backfill } = spkRotationDecision(created, now);
  if (backfill) {
    try { await SecureStore.setItemAsync(SECURE_SPK_CREATED_KEY(), String(now)); }
    catch {/* best-effort backfill */}
  }
  return rotate;
}

interface WireSealedEnvelope {
  id: string;
  to: string;
  from?: string;
  ciphertext: string;
  nonce: string;
  createdAt?: number;
  /** Multi-device self-encrypted copy marker. See mobile counterpart. */
  selfCopy?: boolean;
  /**
   * X25519 public key of the sender injected by the relay at delivery time.
   * Lets the desktop decrypt messages from unknown senders (and auto-save them
   * as contacts) without a separate HTTP round-trip to the identity directory.
   * Only present on online-delivered envelopes.
   */
  senderPublicKeyB64?: string;
}

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
let opkSecretsCache: Map<number, Uint8Array> = new Map();
let mySpkSecretCache: Uint8Array | null = null;

// ── Auth watchdog (mirrors mobile/src/socket/client.ts) ─────────────────────
// The server disconnects unauthenticated sockets after AUTH_TIMEOUT_MS=5s
// (server/src/relay/schemas.ts). If the relay restarts mid-handshake or the
// challenge/response frame is dropped, `connect` can fire with no subsequent
// `auth:ok` and no `disconnect` either. 7000ms (> server's 5s) lets the
// server-side timeout fire first on the clean path; this is the fallback for
// a wedged transport where that timer never runs.
const AUTH_WATCHDOG_MS = 7000;
let authWatchdogTimer: ReturnType<typeof setTimeout> | null = null;

function clearAuthWatchdog(): void {
  if (authWatchdogTimer) {
    clearTimeout(authWatchdogTimer);
    authWatchdogTimer = null;
  }
}

// ── Emit-ack timeout (mirrors mobile/src/socket/client.ts) ──────────────────
// A zombie socket (transport dead, `disconnect` not yet fired) accepts an
// emit() call but the server never sees it — without a timeout the ack
// callback hangs forever. Socket.IO v4's `.timeout(ms)` rejects on no-ack.
const EMIT_ACK_TIMEOUT_MS = 10000;

// ── Offline message queue ─────────────────────────────────────────────────────
interface QueuedSend {
  msgId: string;
  recipientAegisId: string;
  recipientPublicKeyB64: string;
  plaintext: string;
  replyToId?: string;
}
const offlineQueue: QueuedSend[] = [];

// ── Group offline queue ───────────────────────────────────────────────────────
// `dissolve` rides along so a group dissolution requested while offline is
// replayed WITH its signed marker on reconnect — without this field the retry
// would silently downgrade to a no-op metadata sync and members would never
// learn the group was dissolved.
interface QueuedGroupSend {
  groupId: string;
  plaintext: string;
  dissolve?: { adminId: string; dissolveSig: string };
}
const groupOfflineQueue: QueuedGroupSend[] = [];

/**
 * Canonical byte representation of group metadata for signing/verification.
 */
function canonicalGroupBytes(args: {
  groupId: string;
  groupName: string;
  members: string[];
  createdAt: number;
}): Uint8Array {
  const sorted = [...args.members].sort();
  const canonical = JSON.stringify([
    'aegis.group.v1',
    args.groupId,
    args.groupName,
    sorted,
    args.createdAt,
  ]);
  return new TextEncoder().encode(canonical);
}

function signGroupMetadata(
  args: { groupId: string; groupName: string; members: string[]; createdAt: number },
  signingSecretKey: Uint8Array,
): string {
  const sig = nacl.sign.detached(canonicalGroupBytes(args), signingSecretKey);
  return encodeBase64(sig);
}

function verifyGroupMetadata(
  args: { groupId: string; groupName: string; members: string[]; createdAt: number },
  sigB64: string,
  signingPublicKeyB64: string,
): boolean {
  try {
    const sig = decodeBase64(sigB64);
    const pub = decodeBase64(signingPublicKeyB64);
    if (sig.length !== nacl.sign.signatureLength) return false;
    if (pub.length !== nacl.sign.publicKeyLength) return false;
    return nacl.sign.detached.verify(canonicalGroupBytes(args), sig, pub);
  } catch {
    return false;
  }
}

// ── Group dissolution (aegis.group.dissolve.v1) — parity with mobile's
// crypto/groupSig.ts canonicalGroupDissolveBytes/signGroupDissolve/
// verifyGroupDissolve. ADDITIVE and INDEPENDENT of canonicalGroupBytes above;
// same rationale as the mobile module doc: a bare `dissolved: true` with no
// signature would let ANY sender wipe a group for every member, so the marker
// is signed over {groupId, adminId, createdAt} by the ORIGINAL adminId's
// Ed25519 signing key and receivers MUST additionally check that the sealed-
// sender-authenticated sender IS existingGroup.adminId before honoring it.
function canonicalGroupDissolveBytes(args: { groupId: string; adminId: string; createdAt: number }): Uint8Array {
  const canonical = JSON.stringify(['aegis.group.dissolve.v1', args.groupId, args.adminId, args.createdAt]);
  return new TextEncoder().encode(canonical);
}

export function signGroupDissolve(
  args: { groupId: string; adminId: string; createdAt: number },
  signingSecretKey: Uint8Array,
): string {
  const sig = nacl.sign.detached(canonicalGroupDissolveBytes(args), signingSecretKey);
  return encodeBase64(sig);
}

export function verifyGroupDissolve(
  args: { groupId: string; adminId: string; createdAt: number },
  sigB64: string,
  signingPublicKeyB64: string,
): boolean {
  try {
    const sig = decodeBase64(sigB64);
    const pub = decodeBase64(signingPublicKeyB64);
    if (sig.length !== nacl.sign.signatureLength) return false;
    if (pub.length !== nacl.sign.publicKeyLength) return false;
    return nacl.sign.detached.verify(canonicalGroupDissolveBytes(args), sig, pub);
  } catch {
    return false;
  }
}

async function flushGroupOfflineQueue(identity: Identity) {
  if (groupOfflineQueue.length === 0) return;
  const items = groupOfflineQueue.splice(0);
  for (const item of items) {
    try {
      // The optimistic local append already ran when this item was enqueued,
      // so the replay must NOT append again.
      await sendGroupMessage({
        identity,
        groupId: item.groupId,
        plaintext: item.plaintext,
        skipLocalAppend: true,
        dissolve: item.dissolve,
      });
    } catch (e) {
      if (DEV) logger.warn('[socket] group offline queue flush error', e);
      groupOfflineQueue.push(item);
    }
  }
}

/**
 * Sealed-sender transport selector for an outgoing envelope (parity with
 * mobile/src/socket/client.ts buildOutgoingEnvelope). Shared by the group
 * fan-out (sendGroupMessage) and the offline retry (flushOfflineQueue): use v2
 * (sealed-sender, no `from` on the wire) ONLY when the flag is on, the session
 * is ESTABLISHED (no pending x3dhInit), and we hold the recipient's delivery
 * token; otherwise v1. Returns the event name, the wire fields to spread into
 * the emit payload, and the advanced ratchet state the caller must persist.
 */
async function buildOutgoingEnvelope(
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

async function flushOfflineQueue(identity: Identity) {
  if (offlineQueue.length === 0) return;
  const items = offlineQueue.splice(0);
  for (const item of items) {
    try {
      const recipientPublicKey = decodeBase64(item.recipientPublicKeyB64);
      const session = await getOrCreateSession(
        item.recipientAegisId,
        item.recipientPublicKeyB64,
        identity,
      );
      const { event, wire, newState } = await buildOutgoingEnvelope(
        item.plaintext,
        item.recipientAegisId,
        recipientPublicKey,
        identity,
        session,
      );
      await saveSessionState(item.recipientAegisId, newState);
      await new Promise<void>((resolve, reject) => {
        socket!
          .timeout(EMIT_ACK_TIMEOUT_MS)
          .emit(
            event,
            { id: item.msgId, to: item.recipientAegisId, ...wire },
            (err: Error | null, ack?: { ok: boolean; error?: string }) => {
              // `.timeout()` switches the ack callback to (err, ack): err is set
              // when the server never responds (zombie transport / dropped frame).
              if (err) { reject(err); return; }
              if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'flush_failed'));
              else resolve();
            },
          );
      });
    } catch (e) {
      // Includes ack-timeout failures — the item is re-queued (NOT dropped) so
      // it retries on the next reconnect instead of being silently lost.
      if (DEV) logger.warn('[socket] offline queue flush error', e);
      offlineQueue.push(item);
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
 * Persist SPK + OPK secrets to secureStorage and verify the SPK secret reads
 * back. Returns false on any failure — callers must NOT publish the matching
 * public bundle in that case (a published SPK whose secret is unreadable makes
 * every inbound X3DH abort with "no-spk"). Shared by the registration path
 * (store/identity.ts) and the socket refill path below.
 */
export async function persistPrekeySecrets(
  preKeys: {
    signedPreKey: { keyId: number; secretKey: Uint8Array };
    opkSecrets: Map<number, Uint8Array>;
  },
  prevSpkKeyId: number | null = null,
): Promise<boolean> {
  try {
    const nextSpkKeyId = preKeys.signedPreKey.keyId;
    const newSecretB64 = encodeBase64(preKeys.signedPreKey.secretKey);
    await SecureStore.setItemAsync(spkSecretKey(nextSpkKeyId), newSecretB64);
    await SecureStore.setItemAsync(SECURE_SPK_SECRET_KEY(), newSecretB64);
    await SecureStore.setItemAsync(SECURE_SPK_KEYID_KEY(), String(nextSpkKeyId));
    // B-3: start this SPK's age clock for the rotation trigger (isSignedPreKeyStale).
    try {
      await SecureStore.setItemAsync(SECURE_SPK_CREATED_KEY(), String(Date.now()));
    } catch {/* best-effort stamp */}

    // Forward secrecy vs deliverability: retain the last K=5 SPK secrets and drop
    // the one that falls out of the window. With ~weekly age-based rotation (B-3)
    // that keeps ≥28 days of decryptability, so an initial message that slept in
    // the relay queue (TTL 30 days) against an older SPK still decrypts. Deleting
    // only the immediately-previous SPK would break those queued inits once
    // rotation became time-driven. `prevSpkKeyId` is retained intentionally.
    const staleSpkKeyId = spkPruneTargetKeyId(nextSpkKeyId);
    if (staleSpkKeyId !== null) {
      try {
        await SecureStore.deleteItemAsync(spkSecretKey(staleSpkKeyId));
      } catch {/* best-effort */}
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
      await SecureStore.setItemAsync(opkSecretKey(keyId), encodeBase64(secret));
    }
    await SecureStore.setItemAsync(
      SECURE_OPK_IDS_KEY(),
      JSON.stringify(Array.from(preKeys.opkSecrets.keys())),
    );

    // INVARIANT: only report success if the SPK secret reads back intact.
    const readback = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    return readback === newSecretB64;
  } catch (err) {
    if (DEV) logger.error('[socket] Failed to persist prekey secrets:', err);
    return false;
  }
}

async function uploadPreKeys(identity: Identity) {
  if (!socket) return;

  let prevSpkKeyId: number | null = null;
  try {
    const stored = await SecureStore.getItemAsync(SECURE_SPK_KEYID_KEY());
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (Number.isFinite(parsed) && parsed > 0) prevSpkKeyId = parsed;
    }
  } catch {/* treat as first run */}
  const nextSpkKeyId = (prevSpkKeyId ?? 0) + 1;
  const prevPqSpkKeyId = await getActivePqSpkKeyId();
  const nextPqSpkKeyId = (prevPqSpkKeyId ?? 0) + 1;

  const preKeys = generatePreKeys(identity, 1, 100, nextSpkKeyId, nextPqSpkKeyId);
  mySpkSecretCache = preKeys.signedPreKey.secretKey;
  opkSecretsCache = preKeys.opkSecrets;

  const persisted = await persistPrekeySecrets(preKeys, prevSpkKeyId);
  if (!persisted) {
    throw new Error('failed to persist prekey secrets — refusing to publish bundle');
  }

  // PQXDH (v2): persist the PQSPK secret with the same readback invariant. On
  // failure we fall back to a v1-safe upload (omit pqSignedPreKey below) rather
  // than advertising a PQ prekey we could not recover.
  const pqSpkOk = await persistPqSpkSecret(nextPqSpkKeyId, preKeys.pqSignedPreKey.secretKey);
  if (pqSpkOk && prevPqSpkKeyId !== null && prevPqSpkKeyId !== nextPqSpkKeyId) {
    try { await SecureStore.deleteItemAsync(pqSpkSecretKey(prevPqSpkKeyId)); } catch {/* best-effort */}
  }

  let deviceId: string | null = null;
  try {
    deviceId = await window.aegis.secureStorage.get('aegis.deviceId');
  } catch {
    // Non-fatal: relay accepts prekeys:upload without deviceId
  }

  return new Promise<void>((resolve, reject) => {
    socket!.emit(
      'prekeys:upload',
      {
        signedPreKey: {
          keyId: preKeys.signedPreKey.keyId,
          publicKeyB64: preKeys.signedPreKey.publicKeyB64,
          signatureB64: preKeys.signedPreKey.signatureB64,
        },
        oneTimePreKeys: preKeys.oneTimePreKeys,
        ...(deviceId !== null ? { deviceId } : {}),
        // PQXDH (v2): omitted when the PQSPK secret could not be durably
        // persisted+read-back above, keeping the upload v1-safe.
        ...(pqSpkOk
          ? {
              pqSignedPreKey: {
                keyId: preKeys.pqSignedPreKey.keyId,
                publicKeyB64: preKeys.pqSignedPreKey.publicKeyB64,
                signatureB64: preKeys.pqSignedPreKey.signatureB64,
              } satisfies PqSignedPreKeyPublic,
            }
          : {}),
      },
      (ack: { ok: boolean; error?: string }) => {
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
              id: crypto.randomUUID(),
              to: identity.aegisId,
              ciphertext: encodeBase64(outerCiphertext),
              nonce: encodeBase64(outerNonce),
              selfCopy: true,
            });
          } catch (e) {
            if (DEV) logger.warn('[socket] deviceSync broadcast failed:', (e as Error).message);
          }
          resolve();
        } else reject(new Error(ack?.error || 'failed to upload prekeys'));
      },
    );
  });
}

export function connect(identity: Identity): Socket {
  if (
    socket &&
    socket.auth &&
    (socket.auth as { aegisId: string }).aegisId === identity.aegisId
  ) {
    return socket;
  }
  if (socket) socket.disconnect();

  authenticated = false;

  // Resolve (or generate) a stable deviceId before connecting.
  // We use an IIFE that runs asynchronously in the background and patches
  // socket.auth once the value is ready.  The socket is created immediately
  // so callers can attach event listeners straight away.
  void (async () => {
    try {
      const stored = await window.aegis.secureStorage.get('aegis.deviceId');
      const deviceId: string = stored ?? await (async () => {
        const id = crypto.randomUUID();
        await window.aegis.secureStorage.set('aegis.deviceId', id);
        return id;
      })();
      if (socket) {
        (socket.auth as Record<string, string>)['deviceId'] = deviceId;
      }
    } catch {
      // Non-fatal: relay accepts connections without deviceId
    }
  })();

  socket = io(RELAY_URL, {
    transports: ['websocket'],
    auth: { aegisId: identity.aegisId, platform: 'desktop' },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
  });

  socket.on('connect', () => {
    connected = true;
    authenticated = false;
    useConnection.getState().setOnline(true);
    if (DEV) logger.debug('[socket] connected, awaiting auth challenge');

    // Arm the watchdog: if auth:ok never arrives (lost handshake during a
    // relay restart), force a fresh transport instead of sitting on a socket
    // that is connected but permanently unauthenticated.
    clearAuthWatchdog();
    authWatchdogTimer = setTimeout(() => {
      authWatchdogTimer = null;
      if (authenticated) return; // race: auth:ok landed just before the timer fired
      if (DEV) logger.warn('[socket] auth watchdog fired — no auth:ok, forcing reconnect');
      socket?.disconnect();
      socket?.connect();
    }, AUTH_WATCHDOG_MS);
  });

  socket.on('disconnect', (reason) => {
    connected = false;
    authenticated = false;
    clearAuthWatchdog();
    useConnection.getState().setOnline(false);
    // Distinguish a disconnect that lands mid-call from an idle one — mirrors
    // mobile/src/socket/client.ts. A call-time 'ping timeout' used to be the
    // signature of heartbeat starvation during WebRTC setup (see
    // server/src/index.ts pingTimeout comment). Diagnostic only: the reconnect
    // path already recovers signaling safely (socket.io-client buffers emits
    // made while disconnected and flushes on reconnect; App.tsx re-arms
    // attachCallHandlers() after reconnect).
    if (DEV) {
      const callStatus = useCall.getState().status;
      if (callStatus !== 'idle' && callStatus !== 'ended') {
        logger.warn('[socket] disconnected DURING active call — reason:', reason, 'callStatus:', callStatus);
      } else {
        logger.debug('[socket] disconnected:', reason);
      }
    }
  });

  socket.on('error_msg', async (e: { code?: string }) => {
    if (DEV) logger.warn('[socket] server error:', e);
    if (e?.code === 'unknown_identity') {
      if (DEV) logger.debug('[socket] unknown_identity — re-registering and reconnecting');
      try {
        const { fetchPowChallenge, solvePoW, uploadIdentityAndPrekeys } = await import(
          '../crypto/registration'
        );
        const { generatePreKeys: genPK } = await import('../crypto/signal/x3dh');
        const { challenge, difficulty } = await fetchPowChallenge(RELAY_URL);
        const nonce = await solvePoW(challenge, difficulty);
        const preKeys = genPK(identity);
        const result = await uploadIdentityAndPrekeys(
          identity,
          {
            signedPreKey: {
              keyId: preKeys.signedPreKey.keyId,
              secretKey: preKeys.signedPreKey.secretKey,
            },
            opkSecrets: preKeys.opkSecrets,
          },
          RELAY_URL,
          challenge,
          nonce,
          preKeys.oneTimePreKeys,
          {
            keyId: preKeys.signedPreKey.keyId,
            publicKeyB64: preKeys.signedPreKey.publicKeyB64,
            signatureB64: preKeys.signedPreKey.signatureB64,
          },
        );
        if (result.ok) {
          if (DEV) logger.debug('[socket] re-registered — reconnecting');
          socket?.disconnect();
        } else {
          if (DEV) logger.warn('[socket] re-registration failed:', result.error);
          useConnection.getState().setOnline(false);
        }
      } catch (err) {
        if (DEV) logger.warn('[socket] re-registration failed:', err);
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
      if (DEV) logger.warn('[socket] auth failure:', (e as Error).message);
      socket?.disconnect();
    }
  });

  socket.on('auth:ok', async (res?: { opkCount?: number }) => {
    authenticated = true;
    clearAuthWatchdog();
    if (DEV) logger.debug('[socket] authenticated');
    void flushOfflineQueue(identity);
    void flushGroupOfflineQueue(identity);

    // Desktop has no push tokens — skip push:register entirely

    // Sealed-sender v2: register the HASH of our delivery token (raw token never
    // leaves the device; it reaches contacts inside our E2EE profile_update).
    if (SEALED_TRANSPORT_VERSION === 'v2') {
      void (async () => {
        try {
          const raw = await getOwnDeliveryToken();
          socket!.emit('deliveryToken:register', { tokenHashB64: hashDeliveryToken(raw) });
        } catch (e) {
          if (DEV) logger.warn('[socket] deliveryToken register failed:', e);
        }
      })();
    }

    const count = res?.opkCount ?? 0;
    // Two independent reasons to (re)publish prekeys: the OPK pool is low
    // (depletion refill) OR the SPK has aged past the rotation interval (B-3,
    // Signal ~weekly). A single uploadPreKeys refreshes both.
    const needRefill = count < 20;
    const needRotate = await isSignedPreKeyStale(Date.now());
    if (needRefill || needRotate) {
      try {
        await uploadPreKeys(identity);
        if (DEV) {
          logger.debug(
            '[socket] prekeys uploaded —',
            needRotate ? 'SPK rotation (age)' : 'OPK refill',
            '(count was', count, ')',
          );
        }
      } catch (err) {
        if (DEV) logger.error('[socket] prekey upload error:', err);
      }
    } else {
      if (DEV) logger.debug('[socket] prekeys count healthy:', count, '— no refill/rotation needed');
    }

    void broadcastProfileUpdate(identity);
  });

  socket.on('msg:delivered', ({ msgId, to }: { msgId: string; to: string }) => {
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

  socket.on('typing', ({ from, isTyping }: { from: string; isTyping: boolean; channelId?: string }) => {
    useTyping.getState().setTyping(from, isTyping);
    if (isTyping) {
      setTimeout(() => useTyping.getState().setTyping(from, false), 5000);
    }
  });

  socket.on('envelope', async (env: WireSealedEnvelope) => {
    await handleIncoming(env, identity);
  });

  // Sealed-sender v2 (parity with mobile): no `from` on the wire; the ephemeral
  // box opens with our secret + epk, the inner signature authenticates the
  // sender, then the v1 downstream (decryptAndAppend) is reused.
  socket.on('envelope:v2', async (env: WireSealedEnvelopeV2) => {
    await handleIncomingV2(env, identity);
  });

  // ── Fase 4: dedicated mailbox delivery socket ────────────────────────────────
  // When mailbox mode is enabled (and Tor is available — fail-closed inside
  // connectMailboxSocket), open a SEPARATE Tor-routed socket that authenticates
  // by mailbox possession proof and receives `envelope:mb` addressed to our
  // opaque rotating mailbox id. Incoming mailbox envelopes are sealed v2 with the
  // same shape as envelope:v2, so they reuse the exact same decrypt+append path.
  // No-op when mailbox mode is off. Idempotent: a live socket is reused.
  if (MAILBOX_ENABLED) {
    void connectMailboxSocket((env) => {
      void handleIncomingV2(env, identity);
    });
  }

  return socket;
}

/** Sealed-sender v2 wire — see mobile counterpart. No `from`/senderPublicKeyB64. */
interface WireSealedEnvelopeV2 {
  id: string;
  to: string;
  ciphertext: string;
  nonce: string;
  epk: string;
  createdAt?: number;
}

/** `{ deliveryToken }` (our raw token) when v2 is on, else `{}`. See mobile. */
async function ownDeliveryTokenField(): Promise<Record<string, string>> {
  if (SEALED_TRANSPORT_VERSION !== 'v2') return {};
  try { return { deliveryToken: await getOwnDeliveryToken() }; } catch { return {}; }
}

/**
 * `{ mailboxRoot }` (base64 of our own mailbox root) when v2 is on, else `{}`.
 * Parity with mobile. Spread into profile_update so contacts learn our root over
 * E2EE — whoever holds it derives our mailbox id for any epoch, so it ships ONLY
 * inside the sealed profile, never on the wire (see mailboxStore.ts). Shared
 * eagerly under v2 (like the delivery token): pre-distribution makes the
 * mailbox-transport cutover (Fase 4, flag-gated) seamless. No-op under v1.
 */
async function ownMailboxRootField(): Promise<Record<string, string>> {
  if (SEALED_TRANSPORT_VERSION !== 'v2') return {};
  try { return { mailboxRoot: await getOwnMailboxRootB64() }; } catch { return {}; }
}

async function handleIncomingV2(env: WireSealedEnvelopeV2, identity: Identity) {
  const contacts = useContacts.getState().contacts;
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
  if (!inner) return;
  const contact = contacts.find((c) => c.aegisId === inner.from);
  if (!contact || contact.blocked) return;
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


// ─── Session-establishment lock (ported from mobile/src/socket/client.ts) ──
//
// Serialise session establishment per contact aegisId so getOrCreateSession's
// create-init+save can never interleave with decryptAndAppend's load+adopt
// (the glare-divergence fix). The lock is REENTRANT for a single call-chain via
// a threaded LockCtx: the recovery path runs
//   decryptAndAppendLocked [holds peer] → tryRecoverDesync → sendProfileTo
//     → getOrCreateSession [re-acquires peer]
// and the context lets that nested acquire pass through instead of deadlocking
// on its own gate. Two CONCURRENT top-level operations get DISTINCT contexts,
// so a different operation still serialises — only the same chain bypasses.
const sessionLocks = new Map<string, Promise<unknown>>();

interface LockCtx { heldKeys: Set<string> }

async function withSessionLock<T>(
  aegisId: string,
  fn: (ctx: LockCtx) => Promise<T>,
  ctx?: LockCtx,
): Promise<T> {
  if (ctx && ctx.heldKeys.has(aegisId)) {
    return fn(ctx);
  }
  const effectiveCtx: LockCtx = ctx ?? { heldKeys: new Set<string>() };

  const prev = sessionLocks.get(aegisId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((res) => { release = res; });
  sessionLocks.set(aegisId, prev.then(() => gate, () => gate));
  await prev.catch(() => undefined);
  effectiveCtx.heldKeys.add(aegisId);
  try {
    return await fn(effectiveCtx);
  } finally {
    effectiveCtx.heldKeys.delete(aegisId);
    release();
    if (sessionLocks.get(aegisId) === undefined) sessionLocks.delete(aegisId);
  }
}

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

async function getOrCreateSessionLocked(
  contactAegisId: string,
  contactPublicKeyB64: string,
  identity: Identity,
): Promise<RatchetState> {
  const existingJson = await loadRatchetSession(contactAegisId);
  if (existingJson) {
    const s = reviveRatchetState(existingJson);
    return s as RatchetState;
  }

  if (!socket) throw new Error('Cannot fetch prekeys offline');
  const bundle = await new Promise<PreKeyBundle>((resolve, reject) => {
    socket!.emit('prekeys:fetch', { aegisId: contactAegisId }, (ack: any) => {
      if (!ack?.ok) reject(new Error(ack?.error));
      else resolve(ack.bundle);
    });
  });

  const contact = useContacts.getState().contacts.find((c) => c.aegisId === contactAegisId);
  if (!contact) throw new Error('Contact not found');

  // Treat empty strings as missing (legacy identities may have stored '' for
  // the signing key). Order of preference: locally pinned > bundle from relay
  // > directory lookup (ported from mobile/src/socket/client.ts). We MUST end
  // up with a non-empty Ed25519 key — performX3DH already refuses an empty/
  // wrong-length key, but trying the directory first means a legitimate
  // handshake doesn't fail just because the local contact cache is stale.
  const nonEmpty = (s: string | undefined | null): string | undefined =>
    typeof s === 'string' && s.length > 0 ? s : undefined;

  let signingPub: string | undefined =
    nonEmpty(contact.signingPublicKeyB64) ?? nonEmpty(bundle.signingPublicKeyB64);

  if (!signingPub) {
    try {
      const { lookupIdentity } = await import('../api');
      const record = await lookupIdentity(contactAegisId);
      const fetched = nonEmpty(record.signingPublicKey);
      if (fetched) {
        signingPub = fetched;
        const { saveContact } = await import('../db/local');
        const updated = { ...contact, signingPublicKeyB64: fetched };
        await saveContact(updated);
        useContacts.setState((s) => ({
          contacts: s.contacts.map((c) => (c.aegisId === contactAegisId ? updated : c)),
        }));
      }
    } catch (e) {
      if (DEV) logger.warn('[socket] failed to fetch signing key from directory');
      void e;
    }
  }

  bundle.signingPublicKeyB64 = signingPub ?? '';
  bundle.identityKeyB64 = contactPublicKeyB64;

  const x3dh = performX3DH(identity, bundle);
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

  ratchetState.x3dhInit = {
    aliceEKB64: x3dh.myEphemeralPublicKeyB64,
    spkId: bundle.signedPreKey.keyId,
    opkId: bundle.oneTimePreKey ? bundle.oneTimePreKey.keyId : null,
    // PQXDH (v2): present iff performX3DH negotiated v2 (peer published a PQSPK).
    // Rides inside the sealed init so the recipient can decapsulate. Absent ⇒ v1.
    ...(x3dh.pqCiphertextB64 ? { pqCtB64: x3dh.pqCiphertextB64 } : {}),
  };

  await saveSessionState(contactAegisId, ratchetState);
  return ratchetState;
}

async function saveSessionState(aegisId: string, state: RatchetState) {
  trimOldSkippedKeys(state, MAX_SKIPPED_KEYS);
  // serializeRatchetState is the single point of truth for the field list
  // (hand-rolled copies dropped the PQ fields once already — see ratchetSerde.ts).
  await saveRatchetSession(aegisId, serializeRatchetState(state));
}

// ─── Ratchet desync auto-recovery (ported from mobile/src/socket/client.ts) ──
//
// Two peers whose Double Ratchet sessions have permanently desynchronised can
// never decrypt each other's normal messages again (normal messages never
// re-run X3DH). Detection is non-forgeable: the OUTER sealed-sender box already
// authenticated the sender, so "outer box OK + existing session + no x3dh
// header + ratchetDecrypt null/throw" can only mean desync.
//
// Glare resolution: the peer with the HIGHER aegisId is the canonical
// initiator — on desync it deletes its session and sends a fresh X3DH init.
// The LOWER peer keeps its session and sends a NUDGE (a normal ratchet message
// that fails on the higher peer, provoking its initiator recovery), then
// ADOPTS the resulting init. Both converge on the higher-id session.
const RECOVERY_COOLDOWN_MS = 60_000;
const SESSION_GRACE_MS = 30_000;
const RECOVERY_WINDOW_MS = 90_000;
const RECOVERY_FALLBACK_MS = 6_000;
const lastRecoveryAttemptMs = new Map<string, number>();
const inRecoveryUntilMs = new Map<string, number>();
/** Pending recovery fallback-flush timers, keyed by peer — see disconnect(). */
const recoveryFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>();

// ── One-sided desync escalation (parity with mobile/src/socket/client.ts) ───────
// The plain NUDGE assumes desync is SYMMETRIC. When it is ONE-SIDED (only the
// lower peer's RECEIVE chain is broken), the nudge decrypts fine on the higher
// peer, which therefore never re-keys and the lower peer wedges forever. After a
// bounded number of nudges the non-initiator escalates to an AUTHENTICATED
// `sessionReset` flag inside the encrypted payload (MAC + sealed-sender verified,
// never a wire field). The higher peer then force-runs its INITIATE branch even
// though its own decrypt succeeded. Mirrors Session/SimpleX in-band session reset.
const NUDGE_ATTEMPTS_BEFORE_RESET_REQUEST = 2;
/** Per-contact count of plain nudges emitted in the current recovery episode. */
const nudgeAttemptsThisEpisode = new Map<string, number>();

function amInitiatorFor(myAegisId: string, peerAegisId: string): boolean {
  return myAegisId > peerAegisId;
}

function isInRecovery(aegisId: string): boolean {
  const until = inRecoveryUntilMs.get(aegisId);
  return typeof until === 'number' && Date.now() < until;
}

/**
 * Non-initiator's nudge: a normal ratchet message over the EXISTING (desynced)
 * session. It fails to decrypt on the higher peer, triggering its initiator
 * recovery, whose fresh init we then adopt. We never delete or rebuild our own
 * session here — that would clobber the init we are about to adopt.
 */
async function sendNudgeOverExistingSession(
  contact: { aegisId: string; publicKeyB64: string },
  identity: Identity,
  // When true, embed an authenticated `sessionReset` flag so the higher peer
  // force-re-keys even if its own decrypt succeeds (one-sided desync escalation).
  requestSessionReset = false,
): Promise<boolean> {
  if (!socket || !connected || !authenticated) return false;
  const existingJson = await loadRatchetSession(contact.aegisId);
  if (!existingJson) return false;
  let session: RatchetState;
  try {
    const s = reviveRatchetState(existingJson);
    session = s as RatchetState;
  } catch {
    return false;
  }
  // A nudge must be a PLAIN ratchet message — no x3dh header — so it lands on
  // the initiator's existing session and fails there (the desync signal).
  delete session.x3dhInit;
  try {
    const { useIdentity } = await import('../store/identity');
    const idState = useIdentity.getState();
    const payload = JSON.stringify({
      type: 'profile_update',
      senderName: idState.displayName,
      senderColor: idState.avatarColor,
      senderStatus: idState.profileStatus,
      // Rides INSIDE the E2EE ratchet payload — only visible to the higher peer
      // after a MAC-verified decrypt, so it is cryptographically authenticated.
      ...(requestSessionReset ? { sessionReset: true } : {}),
    });
    const recipientPub = decodeBase64(contact.publicKeyB64);
    const { envelope, newState } = encryptMessage(
      payload,
      identity.aegisId,
      recipientPub,
      identity.secretKey,
      session,
    );
    await saveSessionState(contact.aegisId, newState);
    socket!.emit('envelope', {
      id: crypto.randomUUID(),
      to: contact.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
    return true;
  } catch (e) {
    if (DEV) logger.warn('[socket] desync nudge send failed:', (e as Error).message);
    return false;
  }
}

async function tryRecoverDesync(
  contact: { aegisId: string; publicKeyB64: string },
  existingState: RatchetState | null,
  identity: Identity,
  // Present when called from inside decryptAndAppendLocked's session lock. The
  // initiator branch re-handshakes via sendProfileTo → getOrCreateSession for
  // the SAME aegisId; threading the context lets that nested acquire pass
  // through the reentrant fast-path instead of deadlocking on our own gate.
  lockCtx?: LockCtx,
  // Bypass grace/cooldown — used by the authenticated session-reset path, where
  // our OWN decrypt succeeded so those guards would otherwise suppress the re-key.
  force = false,
): Promise<boolean> {
  const now = Date.now();

  if (!force) {
    // Grace: never tear down a session negotiated < grace ago — a stale,
    // in-flight message from the previous session must not kill the new one.
    if (
      existingState &&
      typeof existingState.createdAtMs === 'number' &&
      now - existingState.createdAtMs < SESSION_GRACE_MS
    ) {
      return false;
    }

    // Cooldown: collapse a burst of failing stale messages into one attempt.
    const last = lastRecoveryAttemptMs.get(contact.aegisId);
    if (typeof last === 'number' && now - last < RECOVERY_COOLDOWN_MS) {
      return false;
    }
  }
  lastRecoveryAttemptMs.set(contact.aegisId, now);

  const initiator = amInitiatorFor(identity.aegisId, contact.aegisId);
  if (DEV)
    logger.warn(
      `[socket] ratchet desync detected peer=${contact.aegisId} decision=${initiator ? 'INITIATE' : 'NUDGE'}`,
    );

  inRecoveryUntilMs.set(contact.aegisId, now + RECOVERY_WINDOW_MS);

  if (!initiator) {
    // Lower aegisId: keep the (desynced) session, nudge the higher peer, and
    // wait to adopt its fresh init in decryptAndAppend. One-sided desync
    // escalation: after NUDGE_ATTEMPTS_BEFORE_RESET_REQUEST plain nudges without
    // convergence, escalate to an authenticated sessionReset request so the
    // higher peer re-keys even though our nudge decrypts fine on its side.
    const priorAttempts = nudgeAttemptsThisEpisode.get(contact.aegisId) ?? 0;
    const requestReset = priorAttempts >= NUDGE_ATTEMPTS_BEFORE_RESET_REQUEST;
    const nudged = await sendNudgeOverExistingSession(contact, identity, requestReset);
    if (nudged) nudgeAttemptsThisEpisode.set(contact.aegisId, priorAttempts + 1);
    return true;
  }

  // Higher aegisId: drop the dead session and emit a fresh X3DH init (the
  // profile_update ride-along makes getOrCreateSession run a full handshake).
  await deleteContactRatchetSession(contact.aegisId);
  try {
    // Thread the lock context: this runs inside decryptAndAppendLocked's lock
    // for contact.aegisId, and sendProfileTo → getOrCreateSession re-acquires
    // the same key. Without the context that nested acquire would deadlock.
    await sendProfileTo(contact, identity, lockCtx);
  } catch (e) {
    if (DEV) logger.warn('[socket] desync re-handshake send failed:', (e as Error).message);
  }

  // Fallback: if no glare init arrives to clear the marker, treat our fresh
  // init session as converged after a short grace. Track the timer per peer
  // (ported from mobile/src/socket/client.ts): re-entering recovery for the
  // same peer must replace, not stack, the pending timer, and disconnect()
  // must cancel them all — a stale timer firing after disconnect would flush
  // the outbox over a dead socket and leak a timer handle.
  const peerId = contact.aegisId;
  const prevTimer = recoveryFallbackTimers.get(peerId);
  if (prevTimer) clearTimeout(prevTimer);
  const fallbackTimer = setTimeout(() => {
    recoveryFallbackTimers.delete(peerId);
    inRecoveryUntilMs.delete(peerId);
  }, RECOVERY_FALLBACK_MS);
  recoveryFallbackTimers.set(peerId, fallbackTimer);

  return true;
}

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
    if (DEV) logger.warn('[socket] sender mismatch — dropping');
    return false;
  }

  let ratchetState: RatchetState;
  // OPK to consume only AFTER a successful X3DH-init decrypt — deferring keeps
  // the handshake retryable on transient failure/redelivery.
  let consumeOpkIdAfterDecrypt: number | null = null;
  const existingJson = await loadRatchetSession(contact.aegisId);

  // Deterministic glare resolution: if an X3DH init arrives while we hold our
  // own session AND we are the canonical initiator (higher aegisId), never
  // adopt the lower peer's init while ours is pending or we are mid-recovery.
  if (parsed.x3dh && existingJson && amInitiatorFor(identity.aegisId, contact.aegisId)) {
    let myInitPending = false;
    try {
      myInitPending = !!JSON.parse(existingJson).x3dhInit;
    } catch {
      /* treat as established */
    }
    if (myInitPending || isInRecovery(contact.aegisId)) {
      if (DEV)
        logger.warn(
          `[socket] glare: higher peer keeps own init, ignoring lower's (peer=${contact.aegisId})`,
        );
      return false;
    }
    // Established session + lower peer legitimately re-keying → fall through
    // and adopt their fresh init.
  }

  if (existingJson && !parsed.x3dh) {
    const s = reviveRatchetState(existingJson);
    ratchetState = s;
  } else {
    if (!parsed.x3dh) {
      if (DEV) logger.warn('[socket] No session and no X3DH headers — dropping message');
      return false;
    }

    // Use the EXACT SPK secret whose keyId Alice committed to in her X3DH
    // header — the legacy single slot rotates on every prekey refill, so
    // reading it blindly can derive a root key Alice never derived.
    let spkSec: string | null = null;
    if (typeof parsed.x3dh.spkId === 'number') {
      spkSec = await SecureStore.getItemAsync(spkSecretKey(parsed.x3dh.spkId));
    }
    if (!spkSec) {
      spkSec = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    }
    if (!spkSec) {
      if (DEV) logger.warn('[socket] mySpkSecret not found — cannot decrypt');
      return false;
    }
    const mySpkSecret = decodeBase64(spkSec);

    // If Alice committed to an opkId she DID include DH4 — decrypting without
    // it derives a different root key (guaranteed desync). Hard-abort instead
    // of silently mis-deriving, and defer consumption until after success so a
    // redelivered init can retry with the same OPK.
    let myOpkSecret: Uint8Array | null = null;
    if (parsed.x3dh.opkId !== null) {
      const opkSecBase64 = await SecureStore.getItemAsync(opkSecretKey(parsed.x3dh.opkId));
      if (opkSecBase64) {
        myOpkSecret = decodeBase64(opkSecBase64);
        consumeOpkIdAfterDecrypt = parsed.x3dh.opkId;
      } else {
        if (DEV)
          logger.warn('[socket] OPK secret missing for keyId', parsed.x3dh.opkId, '— aborting (would desync)');
        return false;
      }
    }

    // PQXDH (v2) downgrade decision. weAdvertisedPq reflects whether THIS device
    // has an active PQSPK slot. shouldUsePqReceiver FALLS BACK to 'v1' when we
    // advertised PQ but the init carried no ciphertext (legitimate v1 peer, or a
    // gap in our own bundle) — still full X25519 E2EE. We record the downgrade
    // to a LOCAL-ONLY counter (never on the wire) so a spike is observable.
    const pqCtB64 = (parsed.x3dh as { pqCtB64?: string }).pqCtB64;
    const weAdvertisedPq = (await getActivePqSpkKeyId()) !== null;
    const pqDecision = shouldUsePqReceiver(weAdvertisedPq, !!pqCtB64);
    if (weAdvertisedPq && !pqCtB64) {
      void useSecurityDiagnostics.getState().recordPqDowngrade();
    }
    let pqInputs: { cipherText: Uint8Array; pqSpkSecret: Uint8Array } | null = null;
    if (pqDecision === 'v2') {
      const pqKeyId = await getActivePqSpkKeyId();
      const pqSecB64 = pqKeyId !== null ? await SecureStore.getItemAsync(pqSpkSecretKey(pqKeyId)) : null;
      if (!pqSecB64) {
        if (DEV) logger.warn('[socket] PQSPK secret not found for active keyId — cannot complete v2 handshake');
        return false;
      }
      pqInputs = { cipherText: decodeBase64(pqCtB64!), pqSpkSecret: decodeBase64(pqSecB64) };
    }

    const senderPubKey = decodeBase64(contact.publicKeyB64);
    const rootKey = performX3DHReceiver(
      identity,
      mySpkSecret,
      myOpkSecret,
      senderPubKey,
      decodeBase64(parsed.x3dh.aliceEKB64),
      pqInputs,
    );

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

    // Adopting an inbound init — converged. Clear the recovery marker so stale
    // in-flight messages on the old session don't re-trigger recovery, and
    // reply with OUR profile under the now-converged session (the initiator
    // ignored our init under the glare rule, so it never got our profile).
    inRecoveryUntilMs.delete(contact.aegisId);
    // Converged: reset the one-sided-desync escalation counter so a future,
    // unrelated desync starts again with plain nudges before escalating.
    nudgeAttemptsThisEpisode.delete(contact.aegisId);
    setTimeout(() => {
      void sendProfileTo(contact, identity).catch(() => {});
    }, 300);
  }

  // Hybrid PQ ratchet (R1): parseRatchetHeader forwards pqPub/pqCt — a hybrid
  // receiver treats their absence on a chain turn as a downgrade attack and
  // rejects the message (see dhRatchet in signal/ratchet.ts). A hand-rolled
  // header here that dropped them broke every fresh v2 handshake with
  // "missing PQ material on hybrid session".
  const rHeader = parseRatchetHeader(parsed.ratchet);
  const rCiphertext = decodeBase64(parsed.ratchet.ciphertextB64);
  const rNonce = decodeBase64(parsed.ratchet.nonceB64);

  // A desync surfaces as null (MAC failure) OR a throw ("Too many skipped
  // messages" / low-order DH). On an EXISTING non-x3dh session both are
  // non-forgeable desync signals (outer box already authenticated the sender);
  // ratchetDecrypt is transactional so a throw leaves the live state intact.
  let plaintextBytes: Uint8Array | null;
  try {
    plaintextBytes = ratchetDecrypt(ratchetState, rHeader, rCiphertext, rNonce);
  } catch (e) {
    if (existingJson && !parsed.x3dh) {
      if (DEV) logger.warn('[socket] ratchetDecrypt threw on existing session:', (e as Error).message);
      await tryRecoverDesync(contact, ratchetState, identity, lockCtx);
    } else if (DEV) {
      logger.warn('[socket] Double Ratchet decryption threw:', (e as Error).message);
    }
    return false;
  }
  if (!plaintextBytes) {
    if (RATCHET_DEBUG) {
      logger.warn(
        '[socket] Double Ratchet decryption failed',
        `peer=${contact.aegisId} hadSession=${Boolean(existingJson)} hadX3dh=${Boolean(parsed.x3dh)}`,
        `hdr(n=${rHeader.n} pn=${rHeader.pn} rk=${ratchetFp(rHeader.ratchetKey)})`,
        `state(Ns=${ratchetState.Ns} Nr=${ratchetState.Nr} PN=${ratchetState.PN}`,
        `DHr=${ratchetFp(ratchetState.DHr)} DHsPub=${ratchetFp(ratchetState.DHs.publicKey)}`,
        `CKr=${ratchetState.CKr ? 'set' : 'null'} CKs=${ratchetState.CKs ? 'set' : 'null'})`,
      );
    }
    if (existingJson && !parsed.x3dh) {
      await tryRecoverDesync(contact, ratchetState, identity, lockCtx);
    }
    return false;
  }

  // Init authenticated — NOW consume the one-time prekey (single-use).
  if (consumeOpkIdAfterDecrypt !== null) {
    try {
      await SecureStore.deleteItemAsync(opkSecretKey(consumeOpkIdAfterDecrypt));
    } catch {
      /* best-effort — may already be absent on retry */
    }
  }

  const body = encodeUTF8(plaintextBytes);

  let finalBody = body;
  let parsedPayload: any = null;
  try {
    if (body.startsWith('{')) {
      parsedPayload = JSON.parse(body);

      if (parsedPayload.type === 'profile_update') {
        // One-sided desync escalation (mirrors Session/SimpleX in-band session
        // reset): this message decrypted fine (the peer's SEND chain still
        // matches ours) so our own desync detector never fired. The authenticated
        // `sessionReset` flag — verified by this MAC-checked decrypt AND the outer
        // sealed-sender box, never a forgeable wire field — asks us to re-key.
        // Only the canonical initiator (higher aegisId) may mint the winning init;
        // if we are the lower peer we ignore it to avoid a re-key ping-pong.
        if (parsedPayload.sessionReset === true) {
          if (amInitiatorFor(identity.aegisId, contact.aegisId)) {
            await saveSessionState(contact.aegisId, ratchetState);
            await tryRecoverDesync(contact, ratchetState, identity, lockCtx, true);
            return true;
          }
        }
        if (parsedPayload.senderName) {
          await useContacts.getState().updateContactProfile(
            contact.aegisId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            parsedPayload.senderImage ?? undefined,
            parsedPayload.senderStatus ?? undefined,
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

      // E2EE delete-for-everyone: the peer retracts one of their messages
      // (payload.text = the target msgId). Arrives over the normal ratchet
      // channel — durable (outbox + mailbox), sealed, zero relay metadata —
      // unlike the old plaintext fire-and-forget `msg:delete` event. Apply
      // silently; do NOT append a chat row. Still persist ratchet state.
      if (parsedPayload.type === 'msg_delete') {
        if (typeof parsedPayload.text === 'string' && parsedPayload.text) {
          await useMessages.getState().remoteDelete(contact.aegisId, parsedPayload.text);
        }
        await saveSessionState(contact.aegisId, ratchetState);
        return true;
      }

      // E2EE read receipt (mailbox mode): the peer reports having read some of
      // our messages. payload.text = JSON array of msgIds. Rides the sealed
      // channel so the relay never sees the me↔to aegisId edge (which the old
      // plaintext `msg:read` event handed over on the control-plane socket).
      // Apply silently; do NOT append a chat row. Still persist ratchet state.
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

      if (parsedPayload.type === 'group_msg') {
        const groupId: string = parsedPayload.groupId;
        const claimedName: string = parsedPayload.groupName;
        const senderId: string = parsedPayload.senderId ?? contact.aegisId;
        const msgBody: string = parsedPayload.body;
        const claimedMembers: string[] = parsedPayload.members ?? [senderId, identity.aegisId];
        const claimedAdminId: string | undefined = parsedPayload.adminId;
        const claimedAdminSig: string | undefined = parsedPayload.adminSig;
        const claimedCreatedAt: number | undefined = parsedPayload.groupCreatedAt;

        async function getAdminSigningKey(): Promise<string | null> {
          if (!claimedAdminId) return null;
          if (claimedAdminId === senderId) return contact.signingPublicKeyB64 ?? null;
          let admin = useContacts.getState().contacts.find((c) => c.aegisId === claimedAdminId);
          if (!admin) {
            try {
              admin = await useContacts.getState().addByAegisId(claimedAdminId);
            } catch (e) {
              if (DEV) logger.warn('[socket] failed to dynamically resolve group admin:', e);
            }
          }
          return admin?.signingPublicKeyB64 ?? null;
        }

        async function metadataIsAuthentic(): Promise<boolean> {
          if (!claimedAdminId || !claimedAdminSig || typeof claimedCreatedAt !== 'number')
            return false;
          const pub = await getAdminSigningKey();
          if (!pub) return false;
          return verifyGroupMetadata(
            {
              groupId,
              groupName: claimedName,
              members: claimedMembers,
              createdAt: claimedCreatedAt,
            },
            claimedAdminSig,
            pub,
          );
        }

        const { getGroup, saveGroup } = await import('../db/local');
        const existingGroup = await getGroup(groupId);

        // ── Group dissolution (admin only, signature-gated) ────────────────────
        // Wire shape: { dissolved: true, dissolveAdminId, dissolveSig } riding a
        // `[group:dissolved]` carrier body. Honored ONLY if:
        //   1. We actually have this group locally (nothing to dissolve otherwise).
        //   2. The SEALED-SENDER-AUTHENTICATED sender — contact.aegisId, from the
        //      ratchet session, NEVER the forgeable parsedPayload.senderId used
        //      elsewhere in this handler — IS the group's CURRENT adminId.
        //   3. dissolveAdminId (the claimed signer) also equals existingGroup.adminId.
        //   4. verifyGroupDissolve succeeds against the admin's REAL signing key,
        //      resolved the same way as every other admin-signed field (never
        //      trust a signing key embedded in the payload itself).
        // On success: wipe the group locally exactly like leaveGroup (messages +
        // group record + in-memory chat state). Non-admin or bad-signature
        // dissolve attempts are silently ignored — group and history untouched.
        if (
          parsedPayload.dissolved === true &&
          existingGroup &&
          existingGroup.adminId &&
          contact.aegisId === existingGroup.adminId &&
          parsedPayload.dissolveAdminId === existingGroup.adminId
        ) {
          const claimedDissolveSig: string | undefined =
            typeof parsedPayload.dissolveSig === 'string' ? parsedPayload.dissolveSig : undefined;
          const adminPub = contact.signingPublicKeyB64 ?? null;
          const dissolveIsAuthentic =
            !!claimedDissolveSig &&
            !!adminPub &&
            verifyGroupDissolve(
              { groupId, adminId: existingGroup.adminId, createdAt: existingGroup.createdAt },
              claimedDissolveSig,
              adminPub,
            );
          if (dissolveIsAuthentic) {
            const { deleteContactMessages, deleteGroup } = await import('../db/local');
            await deleteContactMessages(groupId);
            await deleteGroup(groupId);
            const { useGroups } = await import('../store/groups');
            useGroups.setState((s) => ({ groups: s.groups.filter((g) => g.id !== groupId) }));
            useMessages.getState().clearChat(groupId);
            await saveSessionState(contact.aegisId, ratchetState);
            return true;
          }
          if (DEV) logger.warn('[socket] group dissolve rejected — invalid or missing signature');
          // Fall through — treat as an ordinary (untrusted) metadata message so
          // the rest of the pipeline behaves exactly as if `dissolved` were absent.
        }

        if (!existingGroup) {
          if (!(await metadataIsAuthentic())) {
            if (DEV)
              logger.warn('[socket] group_msg create rejected — invalid or missing adminSig');
            return false;
          }
          if (!claimedMembers.includes(identity.aegisId)) {
            if (DEV)
              logger.warn('[socket] group_msg create rejected — local id not in members');
            return false;
          }
          await saveGroup({
            id: groupId,
            name: claimedName,
            members: claimedMembers,
            createdAt: claimedCreatedAt as number,
            adminId: claimedAdminId,
            adminSig: claimedAdminSig,
          });
          const { useGroups } = await import('../store/groups');
          void useGroups.getState().hydrate();
        } else {
          const isAdmin =
            !!existingGroup.adminId &&
            senderId === existingGroup.adminId &&
            claimedAdminId === existingGroup.adminId;

          const nameChanged = claimedName !== existingGroup.name;
          const membersChanged =
            JSON.stringify([...claimedMembers].sort()) !==
            JSON.stringify([...existingGroup.members].sort());

          if ((nameChanged || membersChanged) && isAdmin && (await metadataIsAuthentic())) {
            await saveGroup({
              ...existingGroup,
              name: claimedName,
              members: claimedMembers,
              adminSig: claimedAdminSig,
            });
            const { useGroups } = await import('../store/groups');
            void useGroups.getState().hydrate();
          } else if ((nameChanged || membersChanged) && DEV) {
            logger.warn('[socket] group metadata change ignored — sender not admin or sig invalid');
          }
        }

        const trustedGroup = existingGroup ?? (await getGroup(groupId));
        const trustedGroupName: string = trustedGroup?.name ?? claimedName;

        if (parsedPayload.senderName) {
          void useContacts.getState().updateContactProfile(
            senderId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            parsedPayload.senderImage,
          );
        }

        // Vote intercept
        if (msgBody.startsWith('[vote:') && msgBody.endsWith(']')) {
          const inner = msgBody.slice(6, -1);
          const colonIdx = inner.indexOf(':');
          if (colonIdx !== -1) {
            const voteMessageId = inner.slice(0, colonIdx);
            const voteOptionIndex = parseInt(inner.slice(colonIdx + 1), 10);
            if (voteMessageId && Number.isFinite(voteOptionIndex)) {
              const { usePollsStore } = await import('../store/polls');
              usePollsStore.getState().receiveVote(voteMessageId, voteOptionIndex);
            }
          }
          await saveSessionState(contact.aegisId, ratchetState);
          return true;
        }

        const senderDisp = parsedPayload.senderName || senderId.substring(0, 8);
        const formattedBody = `${senderDisp}: ${msgBody}`;

        await saveSessionState(contact.aegisId, ratchetState);

        await useMessages.getState().append({
          id: env.id,
          chatId: groupId,
          direction: 'in',
          body: formattedBody,
          createdAt: env.createdAt ?? Date.now(),
        });

        void showIncomingNotification(
          senderId,
          parsedPayload.senderName || senderId.substring(0, 8),
          msgBody,
          true,
          trustedGroupName,
        );

        return true;
      } else if (
        parsedPayload.type === 'direct_msg' ||
        parsedPayload.type === 'location' ||
        parsedPayload.type === 'view_once'
      ) {
        finalBody = parsedPayload.text;

        if (parsedPayload.senderName) {
          void useContacts.getState().updateContactProfile(
            contact.aegisId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            undefined,
            parsedPayload.senderStatus ?? undefined,
          );
        }
      }
    }
  } catch (e) {
    if (DEV) logger.warn('[socket] Failed parsing structured E2EE message payload:', e);
  }

  await saveSessionState(contact.aegisId, ratchetState);

  // ── Detect and save media payloads ──────────────────────────────────────────
  // Desktop: media caching uses fetch + URL.createObjectURL / ArrayBuffer
  // instead of expo-file-system. For blob: URIs we download and re-objectURL.
  // For data: URIs we leave them as-is (Chromium can render data URIs natively).
  let detectedType: string = parsedPayload?.type ?? 'text';
  let detectedMediaUri: string | null = null;
  let cleanBody = finalBody;

  /**
   * Resolve a media URI to a renderable object URL.
   *
   * Two cases:
   *  - Wire format `blob:<id>:<keyB64>:<nonceB64>` (4 colon-separated parts):
   *    download ciphertext from relay and decrypt locally.
   *  - Browser object URL `blob:http://...` (>4 parts) or any other URI:
   *    fetch directly and re-wrap (e.g. same-device audio sent as objectURL).
   */
  async function resolveBlobUri(uri: string): Promise<string> {
    const parts = uri.split(':');
    if (parts.length === 4 && parts[0] === 'blob') {
      try {
        const { downloadAndDecryptMedia } = await import('../crypto/media');
        return await downloadAndDecryptMedia(uri);
      } catch {
        return uri;
      }
    }
    try {
      const resp = await fetch(uri);
      const blob = await resp.blob();
      return URL.createObjectURL(blob);
    } catch {
      return uri;
    }
  }

  if (finalBody.startsWith('[audio:') && finalBody.endsWith(']')) {
    const durEnd = finalBody.indexOf('s:', 7);
    if (durEnd > 7) {
      const durStr = finalBody.slice(7, durEnd);
      const dataUri = finalBody.slice(durEnd + 2, -1);
      detectedType = 'audio';
      cleanBody = `[audio:${durStr}s]`;
      if (dataUri.startsWith('blob:')) {
        detectedMediaUri = await resolveBlobUri(dataUri);
      } else if (dataUri.startsWith('data:')) {
        detectedMediaUri = dataUri; // Chromium renders data: URIs natively
      }
    }
  } else if (finalBody.startsWith('[image:blob:') && finalBody.endsWith(']')) {
    const dataUri = finalBody.slice(7, -1);
    detectedType = 'image';
    cleanBody = '';
    detectedMediaUri = await resolveBlobUri(dataUri);
  } else if (finalBody.startsWith('[image:data:') && finalBody.endsWith(']')) {
    const dataUri = finalBody.slice(7, -1);
    detectedType = 'image';
    cleanBody = '';
    detectedMediaUri = dataUri;
  } else if (finalBody.startsWith('[viewonce:audio:') && finalBody.endsWith(']')) {
    const inner = finalBody.slice(16, -1);
    const colonIdx = inner.indexOf(':');
    if (colonIdx !== -1) {
      const durStr = inner.slice(0, colonIdx);
      const dataUri = inner.slice(colonIdx + 1);
      detectedType = 'view_once';
      cleanBody = `[viewonce:audio:${durStr}]`;
      if (dataUri.startsWith('data:')) {
        detectedMediaUri = dataUri;
      }
    }
  } else if (finalBody.startsWith('[viewonce:blob:') && finalBody.endsWith(']')) {
    const dataUri = finalBody.slice(10, -1);
    detectedType = 'view_once';
    cleanBody = '[viewonce]';
    detectedMediaUri = await resolveBlobUri(dataUri);
  } else if (finalBody.startsWith('[viewonce:data:') && finalBody.endsWith(']')) {
    const dataUri = finalBody.slice(10, -1);
    detectedMediaUri = dataUri;
    cleanBody = '[viewonce]';
    detectedType = 'view_once';
  } else if (finalBody.startsWith('[file:') && finalBody.endsWith(']')) {
    const inner = finalBody.slice(6, -1);
    const blobColonIdx = inner.indexOf(':blob:');
    if (blobColonIdx !== -1) {
      const fileName = inner.slice(0, blobColonIdx);
      const blobUri = inner.slice(blobColonIdx + 1);
      detectedType = 'file';
      cleanBody = fileName;
      detectedMediaUri = await resolveBlobUri(blobUri);
    } else {
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
    type: detectedType as any,
    mediaUri: detectedMediaUri,
    expiresAt: parsedPayload?.expiresAt ?? null,
  });

  void showIncomingNotification(contact.aegisId, contact.name, finalBody, false);

  return true;
}

async function handleIncoming(env: WireSealedEnvelope, identity: Identity) {
  // Multi-device self-copy fast path (see mobile counterpart for rationale).
  if (env.selfCopy === true && env.to === identity.aegisId) {
    await handleSelfCopy(env, identity);
    return;
  }

  const contacts = useContacts.getState().contacts;
  let matchedContact = env.from ? contacts.find((c) => c.aegisId === env.from) : null;

  if (matchedContact?.blocked) return;

  if (!matchedContact && env.from && AEGIS_ID_RE.test(env.from)) {
    try {
      matchedContact = await useContacts.getState().addByAegisId(env.from);
    } catch {
      // API unreachable — fall back to the sender's public key embedded in the
      // envelope by the relay.  This lets the desktop receive and decrypt the
      // first message from an unknown peer even when the identity-directory
      // HTTPS endpoint is temporarily unavailable (e.g. nginx not yet deployed).
      if (env.senderPublicKeyB64) {
        try {
          matchedContact = await useContacts.getState().addFromEnvelope(
            env.from,
            env.senderPublicKeyB64,
          );
          if (DEV) logger.debug('[socket] auto-added unknown sender from envelope key:', env.from);
        } catch (e2) {
          if (DEV) logger.warn('[socket] addFromEnvelope also failed:', e2);
        }
      } else {
        if (DEV) logger.warn('[socket] unknown sender and no senderPublicKeyB64 in envelope — dropping');
      }
    }
  }

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
      identity.secretKey,
    );
    if (parsed) {
      const success = await decryptAndAppend(env, parsed, matchedContact, identity);
      if (success) return;
    }
  }

  for (const contact of contacts) {
    if (contact.blocked) continue;
    if (env.from && contact.aegisId === env.from) continue;
    let senderPubKey: Uint8Array;
    try {
      senderPubKey = decodeBase64(contact.publicKeyB64);
    } catch {
      continue;
    }

    const parsed = openEnvelope(
      { ciphertextB64: env.ciphertext, nonceB64: env.nonce },
      senderPubKey,
      identity.secretKey,
    );
    if (!parsed) continue;

    const success = await decryptAndAppend(env, parsed, contact, identity);
    if (success) return;
  }

  if (DEV)
    logger.warn(
      '[socket] envelope from unknown sender — add the peer as a contact first to decrypt their messages',
    );
}

// ─── Self-encrypted copy (multi-device sync) ─────────────────────────────────
// Ported from mobile/src/socket/client.ts — see that file for full rationale.

async function getSelfRatchet(myAegisId: string): Promise<RatchetState | null> {
  try {
    const raw = await SecureStore.getItemAsync(SECURE_SELF_RATCHET_KEY(myAegisId));
    if (!raw) return null;
    const s = reviveRatchetState(raw);
    return s as RatchetState;
  } catch (e) {
    if (DEV) logger.warn('[socket] getSelfRatchet read failed:', (e as Error).message);
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

async function initSelfSession(identity: Identity, sock: Socket): Promise<RatchetState> {
  const bundle = await new Promise<PreKeyBundle>((resolve, reject) => {
    sock.emit('prekeys:fetch', { aegisId: identity.aegisId }, (ack: { ok: boolean; bundle?: PreKeyBundle; error?: string }) => {
      if (!ack?.ok || !ack.bundle) reject(new Error(ack?.error ?? 'self_prekeys_fetch_failed'));
      else resolve(ack.bundle);
    });
  });

  bundle.signingPublicKeyB64 = identity.signingPublicKeyB64;
  bundle.identityKeyB64 = identity.publicKeyB64;

  // Multi-device self-copy stays v1-only for now (matches mobile gap #3): the
  // self-receiver path does NOT pass PQ inputs, so we MUST keep the self-sender
  // on v1 too — otherwise performX3DH would negotiate v2 (the self-bundle
  // advertises our own PQSPK) and derive a root key the receiver can't match.
  // Stripping the PQSPK here forces the classic v1 handshake on both sides.
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

async function sendSelfCopy(
  sock: Socket,
  identity: Identity,
  recipientAegisId: string,
  msgId: string,
  innerPayloadJson: string,
  meta: SelfCopyMeta,
): Promise<void> {
  if (meta.viewOnce) return;
  if (meta.ephemeralSeconds !== undefined && meta.ephemeralSeconds > 0 && meta.ephemeralSeconds < 5) return;

  try {
    let ratchet = await getSelfRatchet(identity.aegisId);
    if (!ratchet) {
      ratchet = await initSelfSession(identity, sock);
    }

    const selfPayloadObj = {
      type: 'self_copy',
      selfCopy: true,
      msgId,
      chatId: recipientAegisId,
      inner: innerPayloadJson,
      sentAt: Date.now(),
    };
    const selfPayload = JSON.stringify(selfPayloadObj);

    const { ciphertext, nonce, header } = ratchetEncrypt(ratchet, new TextEncoder().encode(selfPayload));
    await saveSelfRatchet(identity.aegisId, ratchet);

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
      delete ratchet.x3dhInit;
      await saveSelfRatchet(identity.aegisId, ratchet);
    }

    const innerBytes = stripAndPad(innerPayload);
    const outerNonce = nacl.randomBytes(nacl.box.nonceLength);
    const outerCiphertext = nacl.box(innerBytes, outerNonce, identity.publicKey, identity.secretKey);

    sock.emit('envelope', {
      id: crypto.randomUUID(),
      to: identity.aegisId,
      ciphertext: encodeBase64(outerCiphertext),
      nonce: encodeBase64(outerNonce),
      selfCopy: true,
    });
  } catch (e) {
    if (DEV) logger.warn('[socket] sendSelfCopy failed (non-fatal):', (e as Error).message);
  }
}

async function handleSelfCopy(env: WireSealedEnvelope, identity: Identity): Promise<void> {
  const parsed = openEnvelope(
    { ciphertextB64: env.ciphertext, nonceB64: env.nonce },
    identity.publicKey,
    identity.secretKey,
  );
  if (!parsed) {
    if (DEV) logger.warn('[socket] self-copy outer decrypt failed');
    return;
  }
  if (parsed.from !== identity.aegisId) {
    if (DEV) logger.warn('[socket] self-copy from mismatch — dropping');
    return;
  }
  if ((parsed as { selfCopy?: unknown }).selfCopy !== true) {
    if (DEV) logger.warn('[socket] self-copy inner flag missing — dropping');
    return;
  }

  const deviceSync = (parsed as { deviceSync?: unknown }).deviceSync;
  if (deviceSync !== undefined) {
    // Validate the SPK-sync shape at runtime before trusting it — a malformed
    // self-copy must be dropped, not passed through with unchecked casts.
    if (
      typeof deviceSync === 'object' && deviceSync !== null &&
      (deviceSync as { type?: unknown }).type === 'spk' &&
      typeof (deviceSync as { spkId?: unknown }).spkId === 'number' &&
      typeof (deviceSync as { spkSecretB64?: unknown }).spkSecretB64 === 'string'
    ) {
      const spkSync = deviceSync as { spkId: number; spkSecretB64: string };
      await saveSpkSecret(spkSync.spkId, spkSync.spkSecretB64);
      if (DEV) logger.debug(`[socket] Synced SPK secret for keyId ${spkSync.spkId} from other device`);
      return;
    }
    if (DEV) logger.warn('[socket] self-copy: malformed deviceSync payload — dropping');
    return;
  }

  let ratchet = await getSelfRatchet(identity.aegisId);
  if (!ratchet) {
    if (!parsed.x3dh) {
      if (DEV) logger.warn('[socket] self-copy: no session and no X3DH headers — dropping');
      return;
    }
    const spkSec = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    if (!spkSec) {
      if (DEV) logger.warn('[socket] self-copy: missing local SPK secret — dropping (multi-device SPK sync not implemented)');
      return;
    }
    const mySpkSecret = decodeBase64(spkSec);

    let myOpkSecret: Uint8Array | null = null;
    const x3dhInit = parsed.x3dh as { aliceEKB64: string; spkId: number; opkId: number | null };
    if (x3dhInit.opkId !== null) {
      const opkB64 = await SecureStore.getItemAsync(opkSecretKey(x3dhInit.opkId));
      if (opkB64) {
        myOpkSecret = decodeBase64(opkB64);
        void SecureStore.deleteItemAsync(opkSecretKey(x3dhInit.opkId));
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
    if (DEV) logger.warn('[socket] self-copy ratchet decrypt threw:', (e as Error).message);
    return;
  }
  if (!plaintextBytes) {
    if (DEV) logger.warn('[socket] self-copy ratchet decrypt failed (null)');
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
    if (DEV) logger.warn('[socket] self-copy body is not JSON — dropping');
    return;
  }
  if (selfObj.type !== 'self_copy' || !selfObj.msgId || !selfObj.chatId || !selfObj.inner) {
    if (DEV) logger.warn('[socket] self-copy malformed payload — dropping');
    return;
  }

  const existing = useMessages.getState().byChat[selfObj.chatId];
  if (existing && existing.some((m) => m.id === selfObj.msgId)) {
    return;
  }

  let originalPayload: {
    type?: string;
    text?: string;
    replyToId?: string;
    expiresAt?: number | null;
  } = {};
  try {
    originalPayload = JSON.parse(selfObj.inner);
  } catch {
    if (DEV) logger.warn('[socket] self-copy inner payload not JSON — falling back to raw');
  }

  const displayBody = typeof originalPayload.text === 'string' ? originalPayload.text : selfObj.inner;

  await useMessages.getState().append({
    id: selfObj.msgId,
    chatId: selfObj.chatId,
    direction: 'out',
    body: displayBody,
    createdAt: selfObj.sentAt ?? Date.now(),
    replyToId: originalPayload.replyToId ?? null,
    type: (() => {
      const raw = originalPayload.type as string | undefined;
      if (raw === 'location') return 'location' as const;
      if (raw === 'view_once') return 'view_once' as const;
      return 'text' as const; // wire type 'direct_msg' maps to MessageType 'text'
    })(),
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
  // aegisId control socket (no-op if it was never opened).
  disconnectMailboxSocket();
  // Cancel pending recovery fallback flushes — they would fire over a dead
  // socket and leak timer handles.
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
  const { useIdentity } = await import('../store/identity');
  const idState = useIdentity.getState();
  const senderName = idState.displayName;
  const senderColor = idState.avatarColor;
  const senderStatus = idState.profileStatus;

  // Web Crypto API UUID — available in Chromium renderer
  const id = crypto.randomUUID();
  const createdAt = Date.now();

  let expiresAt = opts.expiresAt ?? null;
  const msgType = opts.type ?? 'direct_msg';
  if (msgType === 'direct_msg' && !expiresAt) {
    const timer = useMessages.getState().ephemeralTimer;
    if (timer > 0) {
      expiresAt = createdAt + timer * 1000;
    }
  }

  // A-3 (parity with mobile): expose the disappearing-message TTL so the relay
  // purges a queued ephemeral message at its intended expiry, not 30 days later.
  const ephemeralTtlMs =
    expiresAt && expiresAt > createdAt ? expiresAt - createdAt : undefined;

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

  if (!socket || !connected || !authenticated) {
    offlineQueue.push({
      msgId: id,
      recipientAegisId: opts.recipientAegisId,
      recipientPublicKeyB64: encodeBase64(opts.recipientPublicKey),
      plaintext: opts.plaintext,
      replyToId: opts.replyToId,
    });
    return;
  }

  const payloadObj = {
    type: msgType,
    text: opts.plaintext,
    senderName,
    senderColor,
    senderStatus,
    replyToId: opts.replyToId,
    expiresAt,
  };
  const payload = JSON.stringify(payloadObj);

  const session = await getOrCreateSession(
    opts.recipientAegisId,
    encodeBase64(opts.recipientPublicKey),
    opts.identity,
  );

  // Sealed-sender transport selector (parity with mobile): v2 only when the flag
  // is on, the session is ESTABLISHED, and we hold the recipient's delivery
  // token; otherwise v1.
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
  // the recipient burns from the decrypted payload. Falls back to the aegisId
  // transport when not eligible: no root yet, or the socket isn't authed.
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
      if (ack && ack.ok) {
        // Multi-device self-copy stays on the aegisId control socket (it is
        // identity-scoped sync, not a recipient-graph leak). Same as below.
        const selfEphemeralSeconds = expiresAt ? Math.round((expiresAt - createdAt) / 1000) : 0;
        void sendSelfCopy(socket!, opts.identity, opts.recipientAegisId, id, payload, {
          viewOnce: msgType === 'view_once',
          ephemeralSeconds: selfEphemeralSeconds,
        });
        return;
      }
      // ack null/!ok → fall through to the aegisId transport (robust degrade).
    }
  }

  await new Promise<void>((resolve, reject) => {
    socket!
      .timeout(EMIT_ACK_TIMEOUT_MS)
      .emit(
        emitEvent,
        emitPayload,
        (err: Error | null, ack?: { ok: boolean; queued?: boolean; error?: string }) => {
          // `.timeout()` switches the ack callback to (err, ack): err is set
          // when the server never responds (zombie transport / dropped frame).
          if (err) { reject(err); return; }
          if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'send_failed'));
          else resolve();
        },
      );
  });

  // Multi-device sync — best-effort self-encrypted copy.
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
 * Desktop has no file:// or content:// URIs for avatars.
 * Images are either already data: URIs or http URLs.
 */
async function toDataUri(imageField: string | null): Promise<string | null> {
  if (!imageField) return null;
  if (imageField.startsWith('data:') || imageField.startsWith('http')) return imageField;
  // Short string (emoji/text avatar) — pass through
  return imageField;
}

export async function broadcastProfileUpdate(identity: Identity): Promise<void> {
  if (!socket || !connected || !authenticated) return;

  const { useIdentity } = await import('../store/identity');
  const idState = useIdentity.getState();
  const senderName = idState.displayName;
  const senderColor = idState.avatarColor;
  const senderStatus = idState.profileStatus;
  const senderImage = await toDataUri(idState.avatarImage);

  const contacts = useContacts.getState().contacts;
  for (const contact of contacts) {
    try {
      const recipientPub = decodeBase64(contact.publicKeyB64);
      const payload = JSON.stringify({
        type: 'profile_update',
        senderName,
        senderColor,
        senderImage,
        senderStatus,
        ...(await ownDeliveryTokenField()),
        ...(await ownMailboxRootField()),
      });
      const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, identity);
      const { envelope, newState } = encryptMessage(
        payload,
        identity.aegisId,
        recipientPub,
        identity.secretKey,
        session,
      );
      await saveSessionState(contact.aegisId, newState);

      const id = crypto.randomUUID();
      socket!.emit('envelope', {
        id,
        to: contact.aegisId,
        ciphertext: envelope.ciphertextB64,
        nonce: envelope.nonceB64,
      });
    } catch (e) {
      if (DEV) logger.warn('[socket] profile broadcast failed:', (e as Error).message);
    }
  }
}

export async function sendProfileTo(
  contact: { aegisId: string; publicKeyB64: string },
  identity: Identity,
  lockCtx?: LockCtx,
): Promise<void> {
  if (!socket || !connected || !authenticated) return;
  try {
    const { useIdentity } = await import('../store/identity');
    const idState = useIdentity.getState();
    const senderName = idState.displayName;
    const senderColor = idState.avatarColor;
    const senderStatus = idState.profileStatus;
    const senderImage = await toDataUri(idState.avatarImage);

    const payload = JSON.stringify({
      type: 'profile_update',
      senderName,
      senderColor,
      senderImage,
      senderStatus,
      ...(await ownDeliveryTokenField()),
      ...(await ownMailboxRootField()),
    });
    const recipientPub = decodeBase64(contact.publicKeyB64);
    // Forward lockCtx so that when this runs inside a desync-recovery (already
    // holding contact.aegisId's lock) the nested acquire passes through.
    const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, identity, lockCtx);
    const { envelope, newState } = encryptMessage(
      payload,
      identity.aegisId,
      recipientPub,
      identity.secretKey,
      session,
    );
    await saveSessionState(contact.aegisId, newState);
    socket!.emit('envelope', {
      id: crypto.randomUUID(),
      to: contact.aegisId,
      ciphertext: envelope.ciphertextB64,
      nonce: envelope.nonceB64,
    });
  } catch (e) {
    if (DEV) logger.warn('[socket] sendProfileTo failed:', (e as Error).message);
  }
}

export function emitTyping(to: string, isTyping: boolean): void {
  if (!socket || !authenticated) return;
  // In mailbox mode the recipient (`to`) is hidden from the relay by design; the
  // plaintext `typing` event would relink the me↔to edge on the control-plane
  // socket. Typing is a best-effort ephemeral signal (durable sealed delivery
  // would arrive stale), so suppress it under mailbox mode. Otherwise unchanged.
  if (MAILBOX_ENABLED) return;
  socket.emit('typing', { to, isTyping });
}

export function sendReadReceipts(to: string, msgIds: string[]): void {
  if (!socket || !authenticated || msgIds.length === 0) return;
  // Mailbox mode: send the receipt sealed through the E2EE channel so the relay
  // never sees the me↔to aegisId edge on the plaintext control-plane socket.
  // Outside mailbox mode, keep the lightweight plaintext event — it exposes no
  // more than the v2 message transport already does (same aegisId routing).
  if (MAILBOX_ENABLED) {
    void (async () => {
      const { useIdentity } = await import('../store/identity');
      const identity = useIdentity.getState().identity;
      const contact = useContacts.getState().contacts.find((c) => c.aegisId === to);
      if (!identity || !contact?.publicKeyB64) return;
      await sendMessage({
        identity,
        recipientAegisId: to,
        recipientPublicKey: decodeBase64(contact.publicKeyB64),
        plaintext: JSON.stringify(msgIds),
        type: 'read_receipt',
        expiresAt: null,
        skipLocalAppend: true,
      });
    })().catch((e) => {
      if (DEV) logger.warn('[socket] sealed read receipt failed:', (e as Error).message);
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
  void (async () => {
    const { useIdentity } = await import('../store/identity');
    const identity = useIdentity.getState().identity;
    const contact = useContacts.getState().contacts.find((c) => c.aegisId === to);
    if (!identity || !contact?.publicKeyB64) {
      if (DEV) logger.warn('[socket] sendDeleteForEveryone: missing identity or peer key — not sent');
      return;
    }
    await sendMessage({
      identity,
      recipientAegisId: to,
      recipientPublicKey: decodeBase64(contact.publicKeyB64),
      plaintext: msgId,
      type: 'msg_delete',
      expiresAt: null,
      skipLocalAppend: true,
    });
  })().catch((e) => {
    if (DEV) logger.warn('[socket] sendDeleteForEveryone failed:', (e as Error).message);
  });
}

export async function sendGroupMessage(opts: {
  identity: Identity;
  groupId: string;
  plaintext: string;
  /**
   * Skip the optimistic local append. Set by callers that already appended the
   * message themselves (media sends) or by the offline-queue replay, which
   * appended at enqueue time. Mirrors the same flag on the mobile client.
   */
  skipLocalAppend?: boolean;
  /**
   * Admin-only, signed group-dissolution marker (see signGroupDissolve above).
   * When present the payload carries `dissolved: true` + `dissolveSig` so
   * every member's receive path can verify-then-wipe the group. Set only by
   * broadcastGroupDissolve. Mirrors mobile/src/socket/client.ts.
   */
  dissolve?: { adminId: string; dissolveSig: string };
}): Promise<void> {
  // Optimistic local append FIRST, before the online check, so the message
  // shows immediately whether or not we are connected. Own messages render
  // without a name prefix — GroupBubble only strips "name: " from INCOMING
  // bodies — so store the plain text, NOT `${displayName}: ${text}`.
  if (!opts.skipLocalAppend) {
    await useMessages.getState().append({
      id: crypto.randomUUID(),
      chatId: opts.groupId,
      direction: 'out',
      body: opts.plaintext,
      createdAt: Date.now(),
      type: 'text',
    });
  }

  if (!socket || !connected || !authenticated) {
    groupOfflineQueue.push({ groupId: opts.groupId, plaintext: opts.plaintext, dissolve: opts.dissolve });
    return;
  }

  const { getGroup, saveGroup } = await import('../db/local');
  const group = await getGroup(opts.groupId);
  if (!group) throw new Error('group_not_found');

  if (!group.adminId) {
    group.adminId = opts.identity.aegisId;
  }
  if (group.adminId === opts.identity.aegisId && !group.adminSig) {
    group.adminSig = signGroupMetadata(
      {
        groupId: group.id,
        groupName: group.name,
        members: group.members,
        createdAt: group.createdAt,
      },
      opts.identity.signingSecretKey,
    );
    await saveGroup(group);
  }

  const contacts = useContacts.getState().contacts;

  const sendPromises = group.members.map(async (memberId: string) => {
    if (memberId === opts.identity.aegisId) return;
    const contact = contacts.find((c) => c.aegisId === memberId);
    if (!contact) return;

    const { useIdentity } = await import('../store/identity');
    const idState = useIdentity.getState();
    const senderName = idState.displayName;
    const senderColor = idState.avatarColor;
    const senderImage = await toDataUri(idState.avatarImage);

    const payload = JSON.stringify({
      type: 'group_msg',
      groupId: group.id,
      groupName: group.name,
      members: group.members,
      groupCreatedAt: group.createdAt,
      adminId: group.adminId,
      adminSig: group.adminSig,
      // Group dissolution (admin only, signed — see signGroupDissolve above).
      // Absent for every ordinary message; only set by broadcastGroupDissolve.
      ...(opts.dissolve
        ? { dissolved: true, dissolveAdminId: opts.dissolve.adminId, dissolveSig: opts.dissolve.dissolveSig }
        : {}),
      senderId: opts.identity.aegisId,
      senderName,
      senderColor,
      senderImage,
      body: opts.plaintext,
    });

    try {
      const session = await getOrCreateSession(
        contact.aegisId,
        contact.publicKeyB64,
        opts.identity,
      );
      // Sealed-sender selector (parity with mobile): group content is per-member
      // envelopes, so v2 hides the sender's aegisId from the relay for group
      // chat exactly as for 1:1.
      const { event, wire, newState } = await buildOutgoingEnvelope(
        payload,
        contact.aegisId,
        decodeBase64(contact.publicKeyB64),
        opts.identity,
        session,
      );

      await saveSessionState(contact.aegisId, newState);

      const id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        socket!.emit(
          event,
          { id, to: contact.aegisId, ...wire },
          (ack: any) => {
            if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'send_failed'));
            else resolve();
          },
        );
      });
    } catch (e) {
      if (DEV) logger.error('[socket] Multicast E2EE group message failed:', e);
    }
  });

  await Promise.all(sendPromises);
  // Local append already happened at the top (skipLocalAppend-aware), so there
  // is nothing to append here — doing so would double-post and bake the
  // sender's own name into their bubble.
}

/**
 * Body of a group-dissolution carrier. Rendered as NO chat bubble/notification
 * (suppressed on receipt) — its entire purpose is to carry the signed
 * `dissolved`/`dissolveSig` fields on the payload (see sendGroupMessage) so
 * the receive path can verify-then-wipe. Mirrors GROUP_META_SYNC_BODY-style
 * carriers on mobile.
 */
const GROUP_DISSOLVE_BODY = '[group:dissolved]';

/**
 * Admin-only: dissolve a group for every member. Signs a dedicated
 * {groupId, adminId, createdAt} marker (canonicalGroupDissolveBytes) — NOT the
 * roster/name signature, which covers different bytes — so a non-admin, or a
 * replay against a different group, can never forge it. The signed marker
 * rides the existing group_msg carrier (`[group:dissolved]` body, no bubble),
 * fanned out to every member via sendGroupMessage; if offline it is queued in
 * groupOfflineQueue (with the dissolve fields attached) and replayed on
 * reconnect. The caller (store/groups.ts dissolveGroup) wipes the group
 * LOCALLY only after this resolves — mirrors mobile's ordering.
 *
 * Throws if the local identity is not the group's admin — callers must gate
 * on `group.adminId === identity.aegisId` before invoking (dissolveGroup does).
 */
export async function broadcastGroupDissolve(identity: Identity, groupId: string): Promise<void> {
  const { getGroup } = await import('../db/local');
  const group = await getGroup(groupId);
  if (!group) throw new Error('group_not_found');
  if (group.adminId !== identity.aegisId) throw new Error('not_group_admin');

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

export async function sendGroupVote(opts: {
  identity: Identity;
  groupId: string;
  pollMessageId: string;
  optionIndex: number;
}): Promise<void> {
  const plaintext = `[vote:${opts.pollMessageId}:${opts.optionIndex}]`;

  if (!socket || !connected || !authenticated) {
    groupOfflineQueue.push({ groupId: opts.groupId, plaintext });
    return;
  }

  const { getGroup } = await import('../db/local');
  const group = await getGroup(opts.groupId);
  if (!group) return;

  const contacts = useContacts.getState().contacts;

  const { useIdentity } = await import('../store/identity');
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
      const session = await getOrCreateSession(
        contact.aegisId,
        contact.publicKeyB64,
        opts.identity,
      );
      const { envelope, newState } = encryptMessage(
        payload,
        opts.identity.aegisId,
        decodeBase64(contact.publicKeyB64),
        opts.identity.secretKey,
        session,
      );
      await saveSessionState(contact.aegisId, newState);

      const envId = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        socket!.emit(
          'envelope',
          {
            id: envId,
            to: contact.aegisId,
            ciphertext: envelope.ciphertextB64,
            nonce: envelope.nonceB64,
          },
          (ack: { ok: boolean; error?: string } | undefined) => {
            if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'vote_send_failed'));
            else resolve();
          },
        );
      });
    } catch (e) {
      if (DEV) logger.warn('[socket] sendGroupVote failed for member', memberId, e);
    }
  });

  await Promise.all(sendPromises);
}
