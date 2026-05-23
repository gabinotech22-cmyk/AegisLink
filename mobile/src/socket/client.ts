import { io, type Socket } from 'socket.io-client';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64, encodeUTF8 } from 'tweetnacl-util';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';
import { SERVER_URL, ONION_URL } from '../config';
import { usePreferences } from '../store/preferences';
import { encryptMessage, openEnvelope } from '../crypto/messaging';
import type { Identity } from '../crypto/identity';
import { useContacts } from '../store/contacts';
import { useConnection } from '../store/connection';
import { useMessages } from '../store/messages';
import { performX3DH, performX3DHReceiver, generatePreKeys, type PreKeyBundle } from '../crypto/signal/x3dh';
import { initRatchet, ratchetDecrypt, ratchetEncrypt, trimOldSkippedKeys, MAX_SKIPPED_KEYS, type RatchetState } from '../crypto/signal/ratchet';
import { loadRatchetSession, saveRatchetSession } from '../db/local';

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

interface WireSealedEnvelope {
  id: string;
  to: string;
  from?: string;
  ciphertext: string;
  nonce: string;
  createdAt?: number;
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
 * Members are sorted lexicographically so the same set always serializes
 * identically regardless of insertion order. Any change to this format MUST
 * be versioned — old signatures will no longer verify.
 */
function canonicalGroupBytes(args: {
  groupId: string;
  groupName: string;
  members: string[];
  createdAt: number;
}): Uint8Array {
  const sorted = [...args.members].sort();
  // Explicit key order via array literal — JSON.stringify on object literals
  // would still depend on engine insertion order; we hand-roll the JSON.
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
      await sendGroupMessage({ identity, groupId: item.groupId, plaintext: item.plaintext });
    } catch (e) {
      if (__DEV__) console.warn('[socket] group offline queue flush error', e);
      groupOfflineQueue.push(item);
    }
  }
}

async function flushOfflineQueue(identity: Identity) {
  if (offlineQueue.length === 0) return;
  const items = offlineQueue.splice(0); // drain
  for (const item of items) {
    try {
      const recipientPublicKey = decodeBase64(item.recipientPublicKeyB64);
      const session = await getOrCreateSession(item.recipientAegisId, item.recipientPublicKeyB64, identity);
      const { envelope, newState } = encryptMessage(item.plaintext, identity.aegisId, recipientPublicKey, identity.secretKey, session);
      await saveSessionState(item.recipientAegisId, newState);
      await new Promise<void>((resolve, reject) => {
        socket!.emit('envelope', { id: item.msgId, to: item.recipientAegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 },
          (ack: { ok: boolean; error?: string } | undefined) => {
            if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'flush_failed'));
            else resolve();
          }
        );
      });
    } catch (e) {
      if (__DEV__) console.warn('[socket] offline queue flush error', e);
      // Re-queue on failure so we retry next time
      offlineQueue.push(item);
    }
  }
}

// ── Ratchet state JSON revival ────────────────────────────────────────────────
// JSON.stringify converts Uint8Array to a sparse-keyed object like
// {"0":12,"1":244,...}. We strictly detect bytes-shapes and never use
// `instanceof Object` as a catch-all (that fires for any object, including
// MKSKIPPED whose values may already be plain objects). Only Buffer-shaped
// objects ({type:'Buffer',data:[]}), pure number arrays, and pure
// number-keyed objects of byte values are converted to Uint8Array.
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
    const keys = Object.keys(o).map((k) => parseInt(k, 10)).sort((a, b) => a - b);
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

async function uploadPreKeys(identity: Identity, deviceId: string) {
  if (!socket) return;

  // SPK keyId must be monotonic per Signal X3DH spec — read the previous
  // keyId from SecureStore and increment. On first run (no stored keyId)
  // start at 1. The previous SPK secret is deleted after the new one is
  // persisted so old session material doesn't linger in Keychain/Keystore.
  let prevSpkKeyId: number | null = null;
  try {
    const stored = await SecureStore.getItemAsync(SECURE_SPK_KEYID_KEY());
    if (stored) {
      const parsed = parseInt(stored, 10);
      if (Number.isFinite(parsed) && parsed > 0) prevSpkKeyId = parsed;
    }
  } catch {/* treat as first run */}
  const nextSpkKeyId = (prevSpkKeyId ?? 0) + 1;

  const preKeys = generatePreKeys(identity, 1, 100, nextSpkKeyId);
  mySpkSecretCache = preKeys.signedPreKey.secretKey;
  opkSecretsCache = preKeys.opkSecrets;

  // expo-secure-store has a ~2KB-per-item limit on iOS. Stuffing 100 OPK
  // secrets into a single JSON blob (~5KB) used to silently fail and break
  // X3DH receiver-side decryption. Store each OPK secret as its own item
  // and keep a separate index of active keyIds for cleanup.
  try {
    // Persist the new SPK secret under both the legacy single-slot key
    // (used by decryptAndAppend for current-session reads) and a
    // per-keyId slot. Write the per-keyId slot first so the legacy slot
    // always points at a complete secret.
    const newSecretB64 = encodeBase64(preKeys.signedPreKey.secretKey);
    await SecureStore.setItemAsync(spkSecretKey(nextSpkKeyId), newSecretB64);
    await SecureStore.setItemAsync(SECURE_SPK_SECRET_KEY(), newSecretB64);
    await SecureStore.setItemAsync(SECURE_SPK_KEYID_KEY(), String(nextSpkKeyId));

    // Forward secrecy: wipe the previous SPK secret from SecureStore once
    // the new one is fully persisted. Skip if there was no previous keyId
    // (first arranque) or it matches the new keyId (paranoia guard).
    if (prevSpkKeyId !== null && prevSpkKeyId !== nextSpkKeyId) {
      try {
        await SecureStore.deleteItemAsync(spkSecretKey(prevSpkKeyId));
      } catch {/* best-effort; key may not exist on pre-rotation installs */}
    }

    // Clean up any previously stored OPK secrets that aren't in this batch.
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
      JSON.stringify(Array.from(preKeys.opkSecrets.keys()))
    );
  } catch (err) {
    if (__DEV__) console.error('[socket] Failed to persist prekey secrets to SecureStore:', err);
  }

  return new Promise<void>((resolve, reject) => {
    socket!.emit('prekeys:upload', {
      deviceId,
      signedPreKey: {
        keyId: preKeys.signedPreKey.keyId,
        publicKeyB64: preKeys.signedPreKey.publicKeyB64,
        signatureB64: preKeys.signedPreKey.signatureB64
      },
      oneTimePreKeys: preKeys.oneTimePreKeys
    }, (ack: { ok: boolean, error?: string }) => {
      if (ack?.ok) resolve();
      else reject(new Error(ack?.error || 'failed to upload prekeys'));
    });
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

  // Read Tor preference synchronously from Zustand store (no hook needed outside React)
  const { routeViaTor } = usePreferences.getState();
  const relayUrl = routeViaTor && ONION_URL ? ONION_URL : SERVER_URL;

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
    transports: ['websocket'],
    auth: { aegisId: identity.aegisId, platform: 'mobile' },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 8000,
  });

  socket.on('connect', () => {
    connected = true;
    authenticated = false;
    useConnection.getState().setOnline(true);
    if (__DEV__) console.log('[socket] connected, awaiting auth challenge');
  });

  socket.on('disconnect', (reason) => {
    connected = false;
    authenticated = false;
    useConnection.getState().setOnline(false);
    if (__DEV__) console.log('[socket] disconnected:', reason);
  });

  socket.on('error_msg', async (e: { code?: string }) => {
    if (__DEV__) console.warn('[socket] server error:', e);
    if (e?.code === 'unknown_identity') {
      // Server doesn't know us — re-register with PoW then reconnect.
      if (__DEV__) console.log('[socket] unknown_identity — re-registering and reconnecting');
      try {
        const { fetchPowChallenge, solvePoW, uploadIdentityAndPrekeys } = await import('../crypto/registration');
        const { SERVER_URL } = await import('../config');
        const { generatePreKeys } = await import('../crypto/signal/x3dh');
        const { challenge, difficulty } = await fetchPowChallenge(SERVER_URL);
        const nonce = await solvePoW(challenge, difficulty);
        const preKeys = generatePreKeys(identity);
        const result = await uploadIdentityAndPrekeys(
          identity,
          {
            signedPreKey: { keyId: preKeys.signedPreKey.keyId, secretKey: preKeys.signedPreKey.secretKey },
            opkSecrets: preKeys.opkSecrets,
          },
          SERVER_URL,
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
          if (__DEV__) console.log('[socket] re-registered — reconnecting');
          socket?.disconnect();
          // Socket.IO's built-in reconnect will re-trigger after disconnect.
        } else {
          if (__DEV__) console.warn('[socket] re-registration failed:', result.error);
          useConnection.getState().setOnline(false);
        }
      } catch (err) {
        if (__DEV__) console.warn('[socket] re-registration failed:', err);
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
      if (__DEV__) console.warn('[socket] auth failure:', (e as Error).message);
      socket?.disconnect();
    }
  });

  socket.on('auth:ok', async (res?: { opkCount?: number }) => {
    authenticated = true;
    if (__DEV__) console.log('[socket] authenticated');

    // Ensure deviceId is resolved before using it below
    const deviceId = resolvedDeviceId || await deviceIdReady;

    // Patch the auth object on the live socket so reconnection attempts also carry deviceId
    if (socket) {
      (socket.auth as Record<string, unknown>).deviceId = deviceId;
    }

    // Flush any messages queued while offline
    void flushOfflineQueue(identity);
    void flushGroupOfflineQueue(identity);

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
        const savedToken = await SecureStore.getItemAsync('aegis.pushToken');

        if (savedToken !== freshToken) {
          const { Platform } = require('react-native');
          socket!.emit('push:register', {
            token: freshToken,
            platform: Platform.OS === 'ios' ? 'ios' : Platform.OS === 'android' ? 'android' : 'unknown',
          });
          await SecureStore.setItemAsync('aegis.pushToken', freshToken);
        }
      } catch (e) {
        if (__DEV__) console.warn('[socket] push token registration failed:', e);
      }
    })();

    const count = res?.opkCount ?? 0;
    if (count < 20) {
      try {
        await uploadPreKeys(identity, deviceId);
        if (__DEV__) console.log('[socket] prekeys uploaded (refilled count from', count, ')');
      } catch (err) {
        if (__DEV__) console.error('[socket] prekey upload error:', err);
      }
    } else {
      if (__DEV__) console.log('[socket] prekeys count healthy:', count, '— no refill needed');
    }

    // Push our profile (name + avatar as data URI) to all contacts on every connect
    // so they always have our latest image even if they were offline when we updated it
    void broadcastProfileUpdate(identity);
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

  socket.on('msg:delete', ({ from, msgId }: { from: string; msgId: string }) => {
    void useMessages.getState().remoteDelete(from, msgId);
  });

  socket.on('typing', ({ from, isTyping }: { from: string; isTyping: boolean }) => {
    const { useTyping } = require('../store/typing');
    useTyping.getState().setTyping(from, isTyping);
    // Auto-clear after 5 s in case the stop signal is lost
    if (isTyping) {
      setTimeout(() => useTyping.getState().setTyping(from, false), 5000);
    }
  });

  socket.on('envelope', async (env: WireSealedEnvelope) => {
    await handleIncoming(env, identity);
  });

  socket.on('channel:msg', (msg: import('../store/workMessages').WorkMessage) => {
    const { useWorkMessages } = require('../store/workMessages') as typeof import('../store/workMessages');
    useWorkMessages.getState().append(msg);
  });

  // ── Group re-key fan-out (forward secrecy on member removal) ─────────────────
  // The admin who removed a member sealed a fresh group SenderKey for each
  // remaining member; the relay delivers our individual copy here. We open it
  // with our X25519 secret against the admin's identity key and persist it,
  // overwriting any older SenderKey for that sender so future group messages
  // decrypt with the new chain — and the removed member's old key cannot.
  socket.on(
    'group:rekey_dist',
    async (dist: {
      groupId: string;
      senderAegisId: string;
      ciphertextB64: string;
      nonceB64: string;
      chainKeyB64: string;
      iteration: number;
    }) => {
      try {
        const { openSenderKeyDistribution } =
          require('../crypto/channelKey') as typeof import('../crypto/channelKey');
        const { saveSenderKey } =
          require('../crypto/channelKeyStore') as typeof import('../crypto/channelKeyStore');

        const sender = useContacts.getState().contacts.find(
          (c) => c.aegisId === dist.senderAegisId,
        );
        if (!sender) return; // unknown distributor — ignore

        const senderKey = openSenderKeyDistribution(
          {
            senderAegisId: dist.senderAegisId,
            channelId: dist.groupId,
            chainKeyB64: dist.chainKeyB64,
            iteration: dist.iteration,
            ciphertextB64: dist.ciphertextB64,
            nonceB64: dist.nonceB64,
          },
          identity.secretKeyB64,
          sender.publicKeyB64,
        );
        await saveSenderKey(dist.groupId, dist.senderAegisId, senderKey);
      } catch (e) {
        if (__DEV__) console.warn('[socket] group:rekey_dist handling failed:', (e as Error).message);
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

  const { generateSenderKey, sealSenderKeyFor } =
    require('../crypto/channelKey') as typeof import('../crypto/channelKey');
  const { saveSenderKey } =
    require('../crypto/channelKeyStore') as typeof import('../crypto/channelKeyStore');

  // 1. Fresh SenderKey — breaks the chain; the removed member's copy is now useless.
  const newSenderKey = generateSenderKey();

  // 2. Persist locally (SecureStore only) before distributing.
  await saveSenderKey(groupId, identity.aegisId, newSenderKey);

  // 3. Seal the new key for every remaining member except ourselves and the
  //    removed member (the latter simply isn't in `remainingMembers`).
  const contacts = useContacts.getState().contacts;
  const distributions: Array<{
    aegisId: string;
    ciphertextB64: string;
    nonceB64: string;
    chainKeyB64: string;
    iteration: number;
    senderAegisId: string;
  }> = [];

  for (const memberId of remainingMembers) {
    if (memberId === identity.aegisId) continue;
    const contact = contacts.find((c) => c.aegisId === memberId);
    if (!contact) continue;
    const dist = sealSenderKeyFor(
      newSenderKey,
      groupId,
      identity.aegisId,
      contact.publicKeyB64,
      identity.secretKeyB64,
    );
    distributions.push({
      aegisId: memberId,
      ciphertextB64: dist.ciphertextB64,
      nonceB64: dist.nonceB64,
      chainKeyB64: dist.chainKeyB64,
      iteration: dist.iteration,
      senderAegisId: dist.senderAegisId,
    });
  }

  if (distributions.length === 0) return; // nobody else to re-key

  // 4. Single fan-out event — the relay validates admin and routes per recipient.
  await new Promise<void>((resolve, reject) => {
    socket!.emit(
      'group:rekey',
      { groupId, distributions },
      (ack: { ok: boolean; error?: string } | undefined) => {
        if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'rekey_failed'));
        else resolve();
      },
    );
  });
}

export function emitDeleteChannelMsg(payload: {
  channelId: string;
  orgId: string;
  messageId: string;
}): void {
  socket?.emit('channel:delete_msg', payload);
}

async function getOrCreateSession(contactAegisId: string, contactPublicKeyB64: string, identity: Identity): Promise<RatchetState> {
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

  // No session exists, fetch PreKey bundle and perform X3DH as Alice (Sender)
  if (!socket) throw new Error('Cannot fetch prekeys offline');
  type PreKeyFetchAck = { ok: true; bundle: PreKeyBundle } | { ok: false; error?: string };
  const bundle = await new Promise<PreKeyBundle>((resolve, reject) => {
    socket!.emit('prekeys:fetch', { aegisId: contactAegisId }, (ack: PreKeyFetchAck) => {
      if (!ack?.ok) reject(new Error(ack?.error ?? 'prekeys_fetch_failed'));
      else resolve(ack.bundle);
    });
  });

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
      if (__DEV__) console.warn('[socket] failed to fetch signing key from directory');
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
  const ratchetState = initRatchet(x3dh.rootKey, decodeBase64(bundle.signedPreKey.publicKeyB64), true);
  
  // Attach Alice's Ephemeral Key and Bob's PreKey IDs for Bob's X3DH receiver calculation
  ratchetState.x3dhInit = {
    aliceEKB64: x3dh.myEphemeralPublicKeyB64,
    spkId: bundle.signedPreKey.keyId,
    opkId: bundle.oneTimePreKey ? bundle.oneTimePreKey.keyId : null
  };
  
  await saveSessionState(contactAegisId, ratchetState);
  return ratchetState;
}

async function saveSessionState(aegisId: string, state: RatchetState) {
  // Forward secrecy: actively shrink the skipped-key window before persisting
  // so an attacker who recovers the DB later cannot decrypt very old skipped
  // messages. The cap is already enforced inside ratchet.ts, but trimming
  // here defends against attacker-induced growth across multiple sessions.
  trimOldSkippedKeys(state, MAX_SKIPPED_KEYS);

  // Persist only the minimal next-state. Previously-consumed CKs/CKr have
  // already been overwritten by their successor via kdfChain in
  // ratchetEncrypt/ratchetDecrypt, so what remains is the smallest state
  // needed to continue the session: RK, DHs, DHr, Ns, Nr, PN, MKSKIPPED.
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

async function decryptAndAppend(
  env: WireSealedEnvelope,
  parsed: any,
  contact: any,
  identity: Identity
): Promise<boolean> {
  if (parsed.from !== contact.aegisId) {
    if (__DEV__) console.warn('[socket] sender mismatch — dropping');
    return false;
  }

  let ratchetState: RatchetState;
  const existingJson = await loadRatchetSession(contact.aegisId);
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
    // Bob doesn't have a session, or the sender is re-keying/starting a fresh session via X3DH setup!
    if (!parsed.x3dh) {
      if (__DEV__) console.warn('[socket] No session and no X3DH headers received — dropping message');
      return false;
    }

    // Load PreKey secrets
    const spkSec = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    if (!spkSec) {
      if (__DEV__) console.warn('[socket] mySpkSecret not found in SecureStore — cannot decrypt');
      return false;
    }
    const mySpkSecret = decodeBase64(spkSec);

    let myOpkSecret: Uint8Array | null = null;
    if (parsed.x3dh.opkId !== null) {
      const opkSecBase64 = await SecureStore.getItemAsync(opkSecretKey(parsed.x3dh.opkId));
      if (opkSecBase64) {
        myOpkSecret = decodeBase64(opkSecBase64);
        // One-time pre-key — consume it after use so the same OPK is never
        // accepted again. (The server already pops it on the sender side.)
        void SecureStore.deleteItemAsync(opkSecretKey(parsed.x3dh.opkId));
      } else {
        if (__DEV__) console.warn('[socket] OPK secret missing for keyId', parsed.x3dh.opkId, '— continuing without DH4');
      }
    }

    // Calculate shared secret using performX3DHReceiver
    const senderPubKey = decodeBase64(contact.publicKeyB64);
    const rootKey = performX3DHReceiver(
      identity,
      mySpkSecret,
      myOpkSecret,
      senderPubKey,
      decodeBase64(parsed.x3dh.aliceEKB64)
    );

    // Initialize Double Ratchet as Bob (Receiver).
    // MUST pass mySpkSecret as DHs so dhRatchet computes the same DH output as Alice:
    //   DH(bobSPK.sec, alice.DHs.pub) == DH(alice.DHs.sec, bobSPK.pub)
    // A random pair here produces a wrong CKr → wrong message key → silent null from secretbox.open.
    const spkPublicKey = nacl.scalarMult.base(mySpkSecret);
    ratchetState = initRatchet(rootKey, decodeBase64(parsed.ratchet.ratchetKeyB64), false, {
      publicKey: spkPublicKey,
      secretKey: mySpkSecret,
    });
  }

  // Now decrypt the message body using the Double Ratchet session
  const rHeader = {
    ratchetKey: decodeBase64(parsed.ratchet.ratchetKeyB64),
    n: parsed.ratchet.n,
    pn: parsed.ratchet.pn
  };
  const rCiphertext = decodeBase64(parsed.ratchet.ciphertextB64);
  const rNonce = decodeBase64(parsed.ratchet.nonceB64);

  const plaintextBytes = ratchetDecrypt(ratchetState, rHeader, rCiphertext, rNonce);
  if (!plaintextBytes) {
    if (__DEV__) console.warn('[socket] Double Ratchet decryption failed');
    return false;
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
        if (parsedPayload.senderName) {
          await useContacts.getState().updateContactProfile(
            contact.aegisId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            parsedPayload.senderImage ?? undefined,
            parsedPayload.senderStatus ?? undefined
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

        // Resolve the admin's Ed25519 signing public key. If admin is the
        // sender we have it from the contact row; otherwise look it up in
        // the contacts store. If we can't find a key, the signature can't be
        // verified and we MUST NOT trust the metadata.
        async function getAdminSigningKey(): Promise<string | null> {
          if (!claimedAdminId) return null;
          if (claimedAdminId === senderId) return contact.signingPublicKeyB64 ?? null;
          let admin = useContacts.getState().contacts.find((c) => c.aegisId === claimedAdminId);
          if (!admin) {
            try {
              admin = await useContacts.getState().addByAegisId(claimedAdminId);
            } catch (e) {
              if (__DEV__) console.warn('[socket] failed to dynamically resolve group admin:', e);
            }
          }
          return admin?.signingPublicKeyB64 ?? null;
        }

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

        const { getGroup, saveGroup } = require('../db/local');
        const existingGroup = await getGroup(groupId);

        if (!existingGroup) {
          // New group: require a valid admin signature before persisting.
          // Without this an attacker could add us to arbitrary groups by
          // crafting a group_msg with chosen groupId/members/name.
          if (!(await metadataIsAuthentic())) {
            if (__DEV__) console.warn('[socket] group_msg create rejected — invalid or missing adminSig');
            return false;
          }
          // We must also be in the member list — otherwise this group isn't
          // actually for us (silently drop).
          if (!claimedMembers.includes(identity.aegisId)) {
            if (__DEV__) console.warn('[socket] group_msg create rejected — local id not in members');
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
          const { useGroups } = require('../store/groups');
          void useGroups.getState().hydrate();
        } else {
          // Existing group: only the original admin may rotate name/members.
          // Anyone else may post messages but their metadata fields are ignored.
          const isAdmin =
            !!existingGroup.adminId &&
            senderId === existingGroup.adminId &&
            claimedAdminId === existingGroup.adminId;

          const nameChanged = claimedName !== existingGroup.name;
          const membersChanged =
            JSON.stringify([...claimedMembers].sort()) !== JSON.stringify([...existingGroup.members].sort());

          if ((nameChanged || membersChanged) && isAdmin && (await metadataIsAuthentic())) {
            await saveGroup({
              ...existingGroup,
              name: claimedName,
              members: claimedMembers,
              adminSig: claimedAdminSig,
            });
            const { useGroups } = require('../store/groups');
            void useGroups.getState().hydrate();
          } else if ((nameChanged || membersChanged) && __DEV__) {
            console.warn('[socket] group metadata change ignored — sender not admin or sig invalid');
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

        // Trigger local notification in alignment with AegisLink notifications spec
        const { showIncomingNotification } = require('../notifications/push');
        void showIncomingNotification(senderId, parsedPayload.senderName || senderId.substring(0, 8), msgBody, true, trustedGroupName);

        return true;
      } else if (
        parsedPayload.type === 'direct_msg' ||
        parsedPayload.type === 'location' ||
        parsedPayload.type === 'view_once'
      ) {
        finalBody = parsedPayload.text;

        // Dynamically update contact name/color/status on every message
        // (image updates only come via dedicated profile_update broadcasts)
        if (parsedPayload.senderName) {
          void useContacts.getState().updateContactProfile(
            contact.aegisId,
            parsedPayload.senderName,
            parsedPayload.senderColor,
            undefined,
            parsedPayload.senderStatus ?? undefined
          );
        }
      }
    }
  } catch (e) {
    if (__DEV__) console.warn('[socket] Failed parsing structured E2EE message payload:', e);
  }

  await saveSessionState(contact.aegisId, ratchetState);

  // ── Detect and save media payloads ──────────────────────────────────────────
  // Use startsWith/indexOf instead of regex on potentially large (400KB+) strings.
  let detectedType: string = parsedPayload?.type ?? 'text';
  let detectedMediaUri: string | null = null;
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
  } else if (finalBody.startsWith('[image:blob:') && finalBody.endsWith(']')) {
    const dataUri = finalBody.slice(7, -1); // '[image:' = 7 chars
    detectedType = 'image';
    cleanBody = '';
    try {
      const { downloadAndDecryptMedia } = require('../crypto/media');
      detectedMediaUri = await downloadAndDecryptMedia(dataUri);
    } catch {
      detectedMediaUri = dataUri;
    }
  } else if (finalBody.startsWith('[image:data:') && finalBody.endsWith(']')) {
    const dataUri = finalBody.slice(7, -1); // '[image:' = 7 chars, strip trailing ]
    detectedType = 'image';
    cleanBody = '';
    try {
      detectedMediaUri = await saveMediaToCache(dataUri, `img_${env.id}.jpg`);
    } catch {
      // Last resort: use in-memory data URI (may be slow for large images)
      detectedMediaUri = dataUri;
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
  } else if (finalBody.startsWith('[viewonce:blob:') && finalBody.endsWith(']')) {
    const dataUri = finalBody.slice(10, -1); // '[viewonce:' = 10 chars
    detectedType = 'view_once';
    cleanBody = '[viewonce]';
    try {
      const { downloadAndDecryptMedia } = require('../crypto/media');
      detectedMediaUri = await downloadAndDecryptMedia(dataUri);
    } catch {
      detectedMediaUri = dataUri;
    }
  } else if (finalBody.startsWith('[viewonce:data:') && finalBody.endsWith(']')) {
    const dataUri = finalBody.slice(10, -1); // '[viewonce:' = 10 chars, strip ]
    const ext = dataUri.startsWith('data:video') ? 'mp4' : 'jpg';
    try {
      detectedMediaUri = await saveMediaToCache(dataUri, `viewonce_${env.id}.${ext}`);
      cleanBody = '[viewonce]';
    } catch {
      detectedMediaUri = dataUri;
      cleanBody = `[viewonce:${dataUri}]`;
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
    type: detectedType as any,
    mediaUri: detectedMediaUri,
    expiresAt: parsedPayload?.expiresAt ?? null,
  });

  // Trigger local notification in alignment with AegisLink notifications spec
  const { showIncomingNotification } = require('../notifications/push');
  void showIncomingNotification(contact.aegisId, contact.name, finalBody, false);

  return true;
}

async function handleIncoming(env: WireSealedEnvelope, identity: Identity) {
  // Multi-device self-copy fast path — routed BEFORE contact matching so a
  // self-copy never falls through to the regular incoming-message handler
  // (which would re-trigger profile/group flows and never decrypt correctly).
  if (env.selfCopy === true && env.to === identity.aegisId) {
    await handleSelfCopy(env, identity);
    return;
  }

  const contacts = useContacts.getState().contacts;
  let matchedContact = env.from ? contacts.find(c => c.aegisId === env.from) : null;

  // Drop messages from blocked contacts immediately — do not decrypt, do not store
  if (matchedContact?.blocked) {
    return;
  }

  if (!matchedContact && env.from) {
    try {
      matchedContact = await useContacts.getState().addByAegisId(env.from);
    } catch (e) {
      if (__DEV__) console.warn('[socket] failed to auto-add unknown sender', e);
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

  if (__DEV__) console.warn('[socket] envelope from unknown sender — add the peer as a contact first to decrypt their messages');
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
    if (__DEV__) console.warn('[socket] getSelfRatchet read failed:', (e as Error).message);
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
    if (__DEV__) console.warn('[socket] sendSelfCopy failed (non-fatal):', (e as Error).message);
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
    if (__DEV__) console.warn('[socket] self-copy outer decrypt failed');
    return;
  }
  if (parsed.from !== identity.aegisId) {
    if (__DEV__) console.warn('[socket] self-copy from mismatch — dropping');
    return;
  }
  // Defence-in-depth: the inner payload MUST also self-declare as a self-copy.
  if ((parsed as { selfCopy?: unknown }).selfCopy !== true) {
    if (__DEV__) console.warn('[socket] self-copy inner flag missing — dropping');
    return;
  }

  let ratchet = await getSelfRatchet(identity.aegisId);
  if (!ratchet) {
    // First self-copy received on this device — derive the session as Bob
    // using OUR OWN SPK secret. If we don't have an SPK secret stored
    // (e.g. desktop hasn't run uploadPreKeys yet) we cannot decrypt; drop.
    if (!parsed.x3dh) {
      if (__DEV__) console.warn('[socket] self-copy: no session and no X3DH headers — dropping');
      return;
    }
    const spkSec = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    if (!spkSec) {
      if (__DEV__) console.warn('[socket] self-copy: missing local SPK secret — dropping (multi-device SPK sync not implemented)');
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
    if (__DEV__) console.warn('[socket] self-copy ratchet decrypt threw:', (e as Error).message);
    return;
  }
  if (!plaintextBytes) {
    if (__DEV__) console.warn('[socket] self-copy ratchet decrypt failed (null)');
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
    if (__DEV__) console.warn('[socket] self-copy body is not JSON — dropping');
    return;
  }
  if (selfObj.type !== 'self_copy' || !selfObj.msgId || !selfObj.chatId || !selfObj.inner) {
    if (__DEV__) console.warn('[socket] self-copy malformed payload — dropping');
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
    if (__DEV__) console.warn('[socket] self-copy inner payload not JSON — falling back to raw');
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
  const { useIdentity } = require('../store/identity');
  const idState = useIdentity.getState();
  const isWork = idState.activeProfile === 'work';
  const senderName = isWork ? idState.workDisplayName : idState.displayName;
  const senderColor = isWork ? idState.workAvatarColor : idState.avatarColor;
  const senderStatus = isWork ? idState.workProfileStatus : idState.profileStatus;

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

  // If offline, queue for delivery on reconnect — message is already saved locally
  if (!socket || !connected || !authenticated) {
    // Cap queue at 200 to prevent OOM during extended offline periods
    if (offlineQueue.length >= 200) offlineQueue.shift(); // drop oldest
    offlineQueue.push({
      msgId: id,
      recipientAegisId: opts.recipientAegisId,
      recipientPublicKeyB64: encodeBase64(opts.recipientPublicKey),
      plaintext: opts.plaintext,
      replyToId: opts.replyToId,
    });
    return; // resolve silently — UI shows "EN COLA" via !online indicator
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

  const session = await getOrCreateSession(opts.recipientAegisId, encodeBase64(opts.recipientPublicKey), opts.identity);
  const { envelope, newState } = encryptMessage(
    payload,
    opts.identity.aegisId,
    opts.recipientPublicKey,
    opts.identity.secretKey,
    session
  );
  await saveSessionState(opts.recipientAegisId, newState);

  await new Promise<void>((resolve, reject) => {
    socket!.emit(
      'envelope',
      { id, to: opts.recipientAegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 },
      (ack: { ok: boolean; queued?: boolean; error?: string } | undefined) => {
        if (!ack || !ack.ok) reject(new Error(ack?.error ?? 'send_failed'));
        else resolve();
      }
    );
  });

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
    if (__DEV__) console.warn('[socket] toDataUri failed:', e);
    return null;
  }
}

export async function broadcastProfileUpdate(identity: Identity): Promise<void> {
  if (!socket || !connected || !authenticated) return;

  const { useIdentity } = require('../store/identity');
  const idState = useIdentity.getState();
  const isWork = idState.activeProfile === 'work';
  const senderName = isWork ? idState.workDisplayName : idState.displayName;
  const senderColor = isWork ? idState.workAvatarColor : idState.avatarColor;
  const senderStatus = isWork ? idState.workProfileStatus : idState.profileStatus;
  const rawImage = isWork ? idState.workAvatarImage : idState.avatarImage;
  // Encode local file URIs to base64 data URIs so other devices can render them
  const senderImage = await toDataUri(rawImage);

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
        session
      );
      await saveSessionState(contact.aegisId, newState);

      const id = Crypto.randomUUID();
      socket!.emit('envelope', {
        id,
        to: contact.aegisId,
        ciphertext: envelope.ciphertextB64,
        nonce: envelope.nonceB64,
      });
    } catch (e) {
      if (__DEV__) console.warn('[socket] profile broadcast failed:', (e as Error).message);
    }
  }
}

/** Send our profile (name + avatar as data URI) to one specific contact. */
export async function sendProfileTo(contact: { aegisId: string; publicKeyB64: string }, identity: Identity): Promise<void> {
  if (!socket || !connected || !authenticated) return;
  try {
    const { useIdentity } = require('../store/identity');
    const idState = useIdentity.getState();
    const isWork = idState.activeProfile === 'work';
    const senderName = isWork ? idState.workDisplayName : idState.displayName;
    const senderColor = isWork ? idState.workAvatarColor : idState.avatarColor;
    const senderStatus = isWork ? idState.workProfileStatus : idState.profileStatus;
    const rawImage = isWork ? idState.workAvatarImage : idState.avatarImage;
    const senderImage = await toDataUri(rawImage);

    const payload = JSON.stringify({ type: 'profile_update', senderName, senderColor, senderImage, senderStatus });
    const recipientPub = decodeBase64(contact.publicKeyB64);
    const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, identity);
    const { envelope, newState } = encryptMessage(payload, identity.aegisId, recipientPub, identity.secretKey, session);
    await saveSessionState(contact.aegisId, newState);
    socket!.emit('envelope', { id: Crypto.randomUUID(), to: contact.aegisId, ciphertext: envelope.ciphertextB64, nonce: envelope.nonceB64 });
  } catch (e) {
    if (__DEV__) console.warn('[socket] sendProfileTo failed:', (e as Error).message);
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
}): Promise<void> {
  if (!socket || !connected || !authenticated) {
    groupOfflineQueue.push({ groupId: opts.groupId, plaintext: opts.plaintext });
    return;
  }

  const { getGroup, saveGroup } = require('../db/local');
  const group = await getGroup(opts.groupId);
  if (!group) throw new Error('group_not_found');

  // Ensure the group has an admin signature. If we created the group locally
  // and never signed it yet (legacy install), sign it now with our identity
  // signing key and persist. Receivers will validate before honoring metadata.
  if (!group.adminId) {
    group.adminId = opts.identity.aegisId;
  }
  if (group.adminId === opts.identity.aegisId && !group.adminSig) {
    group.adminSig = signGroupMetadata(
      { groupId: group.id, groupName: group.name, members: group.members, createdAt: group.createdAt },
      opts.identity.signingSecretKey,
    );
    await saveGroup(group);
  }

  const contacts = useContacts.getState().contacts;

  // Multicast to all members
  const sendPromises = group.members.map(async (memberId: string) => {
    if (memberId === opts.identity.aegisId) return;
    const contact = contacts.find((c) => c.aegisId === memberId);
    if (!contact) return;

    const { useIdentity } = require('../store/identity');
    const idState = useIdentity.getState();
    const isWork = idState.activeProfile === 'work';
    const senderName = isWork ? idState.workDisplayName : idState.displayName;
    const senderColor = isWork ? idState.workAvatarColor : idState.avatarColor;
    const rawImage = isWork ? idState.workAvatarImage : idState.avatarImage;
    const senderImage = await toDataUri(rawImage);

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
      const session = await getOrCreateSession(contact.aegisId, contact.publicKeyB64, opts.identity);
      const { envelope, newState } = encryptMessage(
        payload,
        opts.identity.aegisId,
        decodeBase64(contact.publicKeyB64),
        opts.identity.secretKey,
        session
      );

      await saveSessionState(contact.aegisId, newState);

      const id = Crypto.randomUUID();
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
          }
        );
      });
    } catch (e) {
      if (__DEV__) console.error('[socket] Multicast E2EE group message failed:', e);
    }
  });

  await Promise.all(sendPromises);

  const { useIdentity } = require('../store/identity');
  const idState = useIdentity.getState();
  const isWorkCtx = idState.activeProfile === 'work';
  const myDisplayName = (isWorkCtx ? idState.workDisplayName : idState.displayName)
    || opts.identity.aegisId.substring(0, 8);

  const id = Crypto.randomUUID();
  await useMessages.getState().append({
    id,
    chatId: opts.groupId,
    direction: 'out',
    body: `${myDisplayName}: ${opts.plaintext}`,
    createdAt: Date.now(),
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
    groupOfflineQueue.push({ groupId: opts.groupId, plaintext });
    return;
  }

  const { getGroup } = require('../db/local');
  const group = await getGroup(opts.groupId);
  if (!group) return;

  const contacts = useContacts.getState().contacts;

  const { useIdentity } = require('../store/identity');
  const idState = useIdentity.getState();
  const isWork = idState.activeProfile === 'work';
  const senderName = isWork ? idState.workDisplayName : idState.displayName;
  const senderColor = isWork ? idState.workAvatarColor : idState.avatarColor;

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
      if (__DEV__) console.warn('[socket] sendGroupVote failed for member', memberId, e);
    }
  });

  await Promise.all(sendPromises);
}
