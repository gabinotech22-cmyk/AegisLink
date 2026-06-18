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

import { io, type Socket } from 'socket.io-client';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import { RELAY_URL } from '../config';
import { encryptMessage, openEnvelope } from '../crypto/messaging';
import type { Identity } from '../crypto/identity';
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

const DEV = import.meta.env.DEV;

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
const SECURE_OPK_IDS_KEY = () => `aegis.${getSlotPrefix()}opkIds.json`;
const opkSecretKey = (keyId: number) => `aegis.${getSlotPrefix()}opkSecret.${keyId}`;
const spkSecretKey = (keyId: number) => `aegis.${getSlotPrefix()}spkSecret.${keyId}`;
// PQXDH (v2): ML-KEM-768 signed PQ prekey secret (2400 bytes) per keyId, plus a
// durable counter of the current keyId. Mirrors mobile's DB-backed PQSPK store,
// but desktop persists in the encrypted keystore (window.aegis.secureStorage).
const pqSpkSecretKey = (keyId: number) => `aegis.${getSlotPrefix()}pqSpkSecret.${keyId}`;
const SECURE_PQSPK_KEYID_KEY = () => `aegis.${getSlotPrefix()}pqSpk.keyId`;

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
interface QueuedGroupSend { groupId: string; plaintext: string }
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

async function flushGroupOfflineQueue(identity: Identity) {
  if (groupOfflineQueue.length === 0) return;
  const items = groupOfflineQueue.splice(0);
  for (const item of items) {
    try {
      // The optimistic local append already ran when this item was enqueued,
      // so the replay must NOT append again.
      await sendGroupMessage({ identity, groupId: item.groupId, plaintext: item.plaintext, skipLocalAppend: true });
    } catch (e) {
      if (DEV) console.warn('[socket] group offline queue flush error', e);
      groupOfflineQueue.push(item);
    }
  }
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
      const { envelope, newState } = encryptMessage(
        item.plaintext,
        identity.aegisId,
        recipientPublicKey,
        identity.secretKey,
        session,
      );
      await saveSessionState(item.recipientAegisId, newState);
      await new Promise<void>((resolve, reject) => {
        socket!.emit(
          'envelope',
          {
            id: item.msgId,
            to: item.recipientAegisId,
            ciphertext: envelope.ciphertextB64,
            nonce: envelope.nonceB64,
          },
          (ack: { ok: boolean; error?: string } | undefined) => {
            if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'flush_failed'));
            else resolve();
          },
        );
      });
    } catch (e) {
      if (DEV) console.warn('[socket] offline queue flush error', e);
      offlineQueue.push(item);
    }
  }
}

// ── Ratchet state JSON revival ────────────────────────────────────────────────
function isBufferShape(o: unknown): o is { type: 'Buffer'; data: number[] } {
  return (
    typeof o === 'object' &&
    o !== null &&
    (o as { type?: unknown }).type === 'Buffer' &&
    Array.isArray((o as { data?: unknown }).data) &&
    (o as { data: unknown[] }).data.every((x) => typeof x === 'number')
  );
}

function isNumberArray(o: unknown): o is number[] {
  return Array.isArray(o) && o.every((x) => typeof x === 'number');
}

function isByteIndexedObject(o: unknown): o is Record<string, number> {
  if (typeof o !== 'object' || o === null || Array.isArray(o)) return false;
  const keys = Object.keys(o as object);
  if (keys.length === 0) return false;
  for (const k of keys) {
    if (!/^\d+$/.test(k)) return false;
    const v = (o as Record<string, unknown>)[k];
    if (typeof v !== 'number' || v < 0 || v > 255) return false;
  }
  return true;
}

function reviveBytes(o: unknown): Uint8Array | null {
  if (o === null || o === undefined) return null;
  if (o instanceof Uint8Array) return o;
  if (isBufferShape(o)) return new Uint8Array(o.data);
  if (isNumberArray(o)) return new Uint8Array(o);
  if (isByteIndexedObject(o)) {
    const keys = Object.keys(o)
      .map((k) => parseInt(k, 10))
      .sort((a, b) => a - b);
    const out = new Uint8Array(keys.length);
    for (let i = 0; i < keys.length; i++) out[i] = o[String(keys[i])];
    return out;
  }
  return null;
}

function reviveMkSkipped(raw: unknown): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  if (!Array.isArray(raw)) return out;
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length !== 2) continue;
    const [k, v] = entry as [unknown, unknown];
    if (typeof k !== 'string') continue;
    const bytes = reviveBytes(v);
    if (bytes) out.set(k, bytes);
  }
  return out;
}

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

    if (prevSpkKeyId !== null && prevSpkKeyId !== nextSpkKeyId) {
      try {
        await SecureStore.deleteItemAsync(spkSecretKey(prevSpkKeyId));
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
    if (DEV) console.error('[socket] Failed to persist prekey secrets:', err);
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
        if (ack?.ok) resolve();
        else reject(new Error(ack?.error || 'failed to upload prekeys'));
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
    if (DEV) console.log('[socket] connected, awaiting auth challenge');
  });

  socket.on('disconnect', (reason) => {
    connected = false;
    authenticated = false;
    useConnection.getState().setOnline(false);
    if (DEV) console.log('[socket] disconnected:', reason);
  });

  socket.on('error_msg', async (e: { code?: string }) => {
    if (DEV) console.warn('[socket] server error:', e);
    if (e?.code === 'unknown_identity') {
      if (DEV) console.log('[socket] unknown_identity — re-registering and reconnecting');
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
          if (DEV) console.log('[socket] re-registered — reconnecting');
          socket?.disconnect();
        } else {
          if (DEV) console.warn('[socket] re-registration failed:', result.error);
          useConnection.getState().setOnline(false);
        }
      } catch (err) {
        if (DEV) console.warn('[socket] re-registration failed:', err);
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
      if (DEV) console.warn('[socket] auth failure:', (e as Error).message);
      socket?.disconnect();
    }
  });

  socket.on('auth:ok', async (res?: { opkCount?: number }) => {
    authenticated = true;
    if (DEV) console.log('[socket] authenticated');
    void flushOfflineQueue(identity);
    void flushGroupOfflineQueue(identity);

    // Desktop has no push tokens — skip push:register entirely

    const count = res?.opkCount ?? 0;
    if (count < 20) {
      try {
        await uploadPreKeys(identity);
        if (DEV) console.log('[socket] prekeys uploaded (refilled count from', count, ')');
      } catch (err) {
        if (DEV) console.error('[socket] prekey upload error:', err);
      }
    } else {
      if (DEV) console.log('[socket] prekeys count healthy:', count, '— no refill needed');
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

  socket.on('msg:delete', ({ from, msgId }: { from: string; msgId: string }) => {
    void useMessages.getState().remoteDelete(from, msgId);
  });

  socket.on('typing', ({ from, isTyping }: { from: string; isTyping: boolean; channelId?: string }) => {
    useTyping.getState().setTyping(from, isTyping);
    if (isTyping) {
      setTimeout(() => useTyping.getState().setTyping(from, false), 5000);
    }
  });

  socket.on('envelope', async (env: WireSealedEnvelope) => {
    await handleIncoming(env, identity);
  });

  return socket;
}


async function getOrCreateSession(
  contactAegisId: string,
  contactPublicKeyB64: string,
  identity: Identity,
): Promise<RatchetState> {
  const existingJson = await loadRatchetSession(contactAegisId);
  if (existingJson) {
    const s = JSON.parse(existingJson);
    s.RK = reviveBytes(s.RK);
    s.CKs = reviveBytes(s.CKs);
    s.CKr = reviveBytes(s.CKr);
    s.DHr = reviveBytes(s.DHr);
    s.DHs.publicKey = reviveBytes(s.DHs.publicKey);
    s.DHs.secretKey = reviveBytes(s.DHs.secretKey);
    s.MKSKIPPED = reviveMkSkipped(s.MKSKIPPED);
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
  bundle.signingPublicKeyB64 = contact.signingPublicKeyB64 ?? '';
  bundle.identityKeyB64 = contactPublicKeyB64;

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
    // PQXDH (v2): present iff performX3DH negotiated v2 (peer published a PQSPK).
    // Rides inside the sealed init so the recipient can decapsulate. Absent ⇒ v1.
    ...(x3dh.pqCiphertextB64 ? { pqCtB64: x3dh.pqCiphertextB64 } : {}),
  };

  await saveSessionState(contactAegisId, ratchetState);
  return ratchetState;
}

async function saveSessionState(aegisId: string, state: RatchetState) {
  trimOldSkippedKeys(state, MAX_SKIPPED_KEYS);
  const s = {
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
  await saveRatchetSession(aegisId, JSON.stringify(s));
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
): Promise<boolean> {
  if (!socket || !connected || !authenticated) return false;
  const existingJson = await loadRatchetSession(contact.aegisId);
  if (!existingJson) return false;
  let session: RatchetState;
  try {
    const s = JSON.parse(existingJson);
    s.RK = reviveBytes(s.RK);
    s.CKs = reviveBytes(s.CKs);
    s.CKr = reviveBytes(s.CKr);
    s.DHr = reviveBytes(s.DHr);
    s.DHs.publicKey = reviveBytes(s.DHs.publicKey);
    s.DHs.secretKey = reviveBytes(s.DHs.secretKey);
    s.MKSKIPPED = reviveMkSkipped(s.MKSKIPPED);
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
    if (DEV) console.warn('[socket] desync nudge send failed:', (e as Error).message);
    return false;
  }
}

async function tryRecoverDesync(
  contact: { aegisId: string; publicKeyB64: string },
  existingState: RatchetState | null,
  identity: Identity,
): Promise<boolean> {
  const now = Date.now();

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
  lastRecoveryAttemptMs.set(contact.aegisId, now);

  const initiator = amInitiatorFor(identity.aegisId, contact.aegisId);
  if (DEV)
    console.warn(
      `[socket] ratchet desync detected peer=${contact.aegisId} decision=${initiator ? 'INITIATE' : 'NUDGE'}`,
    );

  inRecoveryUntilMs.set(contact.aegisId, now + RECOVERY_WINDOW_MS);

  if (!initiator) {
    // Lower aegisId: keep the (desynced) session, nudge the higher peer, and
    // wait to adopt its fresh init in decryptAndAppend.
    await sendNudgeOverExistingSession(contact, identity);
    return true;
  }

  // Higher aegisId: drop the dead session and emit a fresh X3DH init (the
  // profile_update ride-along makes getOrCreateSession run a full handshake).
  await deleteContactRatchetSession(contact.aegisId);
  try {
    await sendProfileTo(contact, identity);
  } catch (e) {
    if (DEV) console.warn('[socket] desync re-handshake send failed:', (e as Error).message);
  }

  // Fallback: if no glare init arrives to clear the marker, treat our fresh
  // init session as converged after a short grace.
  const peerId = contact.aegisId;
  setTimeout(() => {
    inRecoveryUntilMs.delete(peerId);
  }, RECOVERY_FALLBACK_MS);

  return true;
}

async function decryptAndAppend(
  env: WireSealedEnvelope,
  parsed: any,
  contact: any,
  identity: Identity,
): Promise<boolean> {
  if (parsed.from !== contact.aegisId) {
    if (DEV) console.warn('[socket] sender mismatch — dropping');
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
        console.warn(
          `[socket] glare: higher peer keeps own init, ignoring lower's (peer=${contact.aegisId})`,
        );
      return false;
    }
    // Established session + lower peer legitimately re-keying → fall through
    // and adopt their fresh init.
  }

  if (existingJson && !parsed.x3dh) {
    const s = JSON.parse(existingJson);
    s.RK = reviveBytes(s.RK);
    s.CKs = reviveBytes(s.CKs);
    s.CKr = reviveBytes(s.CKr);
    s.DHr = reviveBytes(s.DHr);
    s.DHs.publicKey = reviveBytes(s.DHs.publicKey);
    s.DHs.secretKey = reviveBytes(s.DHs.secretKey);
    s.MKSKIPPED = reviveMkSkipped(s.MKSKIPPED);
    ratchetState = s;
  } else {
    if (!parsed.x3dh) {
      if (DEV) console.warn('[socket] No session and no X3DH headers — dropping message');
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
      if (DEV) console.warn('[socket] mySpkSecret not found — cannot decrypt');
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
          console.warn('[socket] OPK secret missing for keyId', parsed.x3dh.opkId, '— aborting (would desync)');
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
        if (DEV) console.warn('[socket] PQSPK secret not found for active keyId — cannot complete v2 handshake');
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
    ratchetState = initRatchet(rootKey, decodeBase64(parsed.ratchet.ratchetKeyB64), false, {
      publicKey: spkPublicKey,
      secretKey: mySpkSecret,
    });

    // Adopting an inbound init — converged. Clear the recovery marker so stale
    // in-flight messages on the old session don't re-trigger recovery, and
    // reply with OUR profile under the now-converged session (the initiator
    // ignored our init under the glare rule, so it never got our profile).
    inRecoveryUntilMs.delete(contact.aegisId);
    setTimeout(() => {
      void sendProfileTo(contact, identity).catch(() => {});
    }, 300);
  }

  const rHeader = {
    ratchetKey: decodeBase64(parsed.ratchet.ratchetKeyB64),
    n: parsed.ratchet.n,
    pn: parsed.ratchet.pn,
  };
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
      if (DEV) console.warn('[socket] ratchetDecrypt threw on existing session:', (e as Error).message);
      await tryRecoverDesync(contact, ratchetState, identity);
    } else if (DEV) {
      console.warn('[socket] Double Ratchet decryption threw:', (e as Error).message);
    }
    return false;
  }
  if (!plaintextBytes) {
    if (DEV) {
      const fp = (b: Uint8Array | null) => (b ? encodeBase64(b).slice(0, 8) : 'null');
      console.warn(
        '[socket] Double Ratchet decryption failed',
        `peer=${contact.aegisId} hadSession=${Boolean(existingJson)} hadX3dh=${Boolean(parsed.x3dh)}`,
        `hdr(n=${rHeader.n} pn=${rHeader.pn} rk=${fp(rHeader.ratchetKey)})`,
        `state(Ns=${ratchetState.Ns} Nr=${ratchetState.Nr} PN=${ratchetState.PN}`,
        `DHr=${fp(ratchetState.DHr)} DHsPub=${fp(ratchetState.DHs.publicKey)}`,
        `CKr=${ratchetState.CKr ? 'set' : 'null'} CKs=${ratchetState.CKs ? 'set' : 'null'})`,
      );
    }
    if (existingJson && !parsed.x3dh) {
      await tryRecoverDesync(contact, ratchetState, identity);
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
        if (parsedPayload.senderName) {
          await useContacts.getState().updateContactProfile(
            contact.aegisId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            parsedPayload.senderImage ?? undefined,
            parsedPayload.senderStatus ?? undefined,
          );
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
              if (DEV) console.warn('[socket] failed to dynamically resolve group admin:', e);
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

        if (!existingGroup) {
          if (!(await metadataIsAuthentic())) {
            if (DEV)
              console.warn('[socket] group_msg create rejected — invalid or missing adminSig');
            return false;
          }
          if (!claimedMembers.includes(identity.aegisId)) {
            if (DEV)
              console.warn('[socket] group_msg create rejected — local id not in members');
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
            console.warn('[socket] group metadata change ignored — sender not admin or sig invalid');
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
    if (DEV) console.warn('[socket] Failed parsing structured E2EE message payload:', e);
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
   * Fetch a blob: URI and return a new persistent object URL.
   * Falls back to the original URI on any error.
   */
  async function resolveBlobUri(uri: string): Promise<string> {
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
          if (DEV) console.log('[socket] auto-added unknown sender from envelope key:', env.from);
        } catch (e2) {
          if (DEV) console.warn('[socket] addFromEnvelope also failed:', e2);
        }
      } else {
        if (DEV) console.warn('[socket] unknown sender and no senderPublicKeyB64 in envelope — dropping');
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
    console.warn(
      '[socket] envelope from unknown sender — add the peer as a contact first to decrypt their messages',
    );
}

// ─── Self-encrypted copy (multi-device sync) ─────────────────────────────────
// Ported from mobile/src/socket/client.ts — see that file for full rationale.

async function getSelfRatchet(myAegisId: string): Promise<RatchetState | null> {
  try {
    const raw = await SecureStore.getItemAsync(SECURE_SELF_RATCHET_KEY(myAegisId));
    if (!raw) return null;
    const s = JSON.parse(raw);
    s.RK = reviveBytes(s.RK);
    s.CKs = reviveBytes(s.CKs);
    s.CKr = reviveBytes(s.CKr);
    s.DHr = reviveBytes(s.DHr);
    s.DHs.publicKey = reviveBytes(s.DHs.publicKey);
    s.DHs.secretKey = reviveBytes(s.DHs.secretKey);
    s.MKSKIPPED = reviveMkSkipped(s.MKSKIPPED);
    return s as RatchetState;
  } catch (e) {
    if (DEV) console.warn('[socket] getSelfRatchet read failed:', (e as Error).message);
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
    if (DEV) console.warn('[socket] sendSelfCopy failed (non-fatal):', (e as Error).message);
  }
}

async function handleSelfCopy(env: WireSealedEnvelope, identity: Identity): Promise<void> {
  const parsed = openEnvelope(
    { ciphertextB64: env.ciphertext, nonceB64: env.nonce },
    identity.publicKey,
    identity.secretKey,
  );
  if (!parsed) {
    if (DEV) console.warn('[socket] self-copy outer decrypt failed');
    return;
  }
  if (parsed.from !== identity.aegisId) {
    if (DEV) console.warn('[socket] self-copy from mismatch — dropping');
    return;
  }
  if ((parsed as { selfCopy?: unknown }).selfCopy !== true) {
    if (DEV) console.warn('[socket] self-copy inner flag missing — dropping');
    return;
  }

  let ratchet = await getSelfRatchet(identity.aegisId);
  if (!ratchet) {
    if (!parsed.x3dh) {
      if (DEV) console.warn('[socket] self-copy: no session and no X3DH headers — dropping');
      return;
    }
    const spkSec = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    if (!spkSec) {
      if (DEV) console.warn('[socket] self-copy: missing local SPK secret — dropping (multi-device SPK sync not implemented)');
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
    if (DEV) console.warn('[socket] self-copy ratchet decrypt threw:', (e as Error).message);
    return;
  }
  if (!plaintextBytes) {
    if (DEV) console.warn('[socket] self-copy ratchet decrypt failed (null)');
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
    if (DEV) console.warn('[socket] self-copy body is not JSON — dropping');
    return;
  }
  if (selfObj.type !== 'self_copy' || !selfObj.msgId || !selfObj.chatId || !selfObj.inner) {
    if (DEV) console.warn('[socket] self-copy malformed payload — dropping');
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
    if (DEV) console.warn('[socket] self-copy inner payload not JSON — falling back to raw');
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
  if (socket) {
    socket.disconnect();
    socket = null;
    connected = false;
    authenticated = false;
  }
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
  const { envelope, newState } = encryptMessage(
    payload,
    opts.identity.aegisId,
    opts.recipientPublicKey,
    opts.identity.secretKey,
    session,
  );
  await saveSessionState(opts.recipientAegisId, newState);

  await new Promise<void>((resolve, reject) => {
    socket!.emit(
      'envelope',
      {
        id,
        to: opts.recipientAegisId,
        ciphertext: envelope.ciphertextB64,
        nonce: envelope.nonceB64,
      },
      (ack: { ok: boolean; queued?: boolean; error?: string } | undefined) => {
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
      if (DEV) console.warn('[socket] profile broadcast failed:', (e as Error).message);
    }
  }
}

export async function sendProfileTo(
  contact: { aegisId: string; publicKeyB64: string },
  identity: Identity,
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
    });
    const recipientPub = decodeBase64(contact.publicKeyB64);
    const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, identity);
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
    if (DEV) console.warn('[socket] sendProfileTo failed:', (e as Error).message);
  }
}

export function emitTyping(to: string, isTyping: boolean): void {
  if (!socket || !authenticated) return;
  socket.emit('typing', { to, isTyping });
}

export function sendReadReceipts(to: string, msgIds: string[]): void {
  if (!socket || !authenticated || msgIds.length === 0) return;
  socket.emit('msg:read', { to, msgIds });
}

export function sendDeleteForEveryone(to: string, msgId: string): void {
  if (!socket || !authenticated) return;
  socket.emit('msg:delete', { to, msgId });
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
    groupOfflineQueue.push({ groupId: opts.groupId, plaintext: opts.plaintext });
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
      const { envelope, newState } = encryptMessage(
        payload,
        opts.identity.aegisId,
        decodeBase64(contact.publicKeyB64),
        opts.identity.secretKey,
        session,
      );

      await saveSessionState(contact.aegisId, newState);

      const id = crypto.randomUUID();
      await new Promise<void>((resolve, reject) => {
        socket!.emit(
          'envelope',
          {
            id,
            to: contact.aegisId,
            ciphertext: envelope.ciphertextB64,
            nonce: envelope.nonceB64,
          },
          (ack: any) => {
            if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'send_failed'));
            else resolve();
          },
        );
      });
    } catch (e) {
      if (DEV) console.error('[socket] Multicast E2EE group message failed:', e);
    }
  });

  await Promise.all(sendPromises);
  // Local append already happened at the top (skipLocalAppend-aware), so there
  // is nothing to append here — doing so would double-post and bake the
  // sender's own name into their bubble.
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
      if (DEV) console.warn('[socket] sendGroupVote failed for member', memberId, e);
    }
  });

  await Promise.all(sendPromises);
}
