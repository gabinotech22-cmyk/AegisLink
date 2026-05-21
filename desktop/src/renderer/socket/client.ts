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
  type PreKeyBundle,
} from '../crypto/signal/x3dh';
import {
  initRatchet,
  ratchetDecrypt,
  trimOldSkippedKeys,
  MAX_SKIPPED_KEYS,
  type RatchetState,
} from '../crypto/signal/ratchet';
import { loadRatchetSession, saveRatchetSession } from '../db/local';
import { showIncomingNotification } from '../notifications/push';
import { useTyping } from '../store/typing';

const DEV = import.meta.env.DEV;

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

interface WireSealedEnvelope {
  id: string;
  to: string;
  from?: string;
  ciphertext: string;
  nonce: string;
  createdAt?: number;
}

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
      await sendGroupMessage({ identity, groupId: item.groupId, plaintext: item.plaintext });
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

  const preKeys = generatePreKeys(identity, 1, 100, nextSpkKeyId);
  mySpkSecretCache = preKeys.signedPreKey.secretKey;
  opkSecretsCache = preKeys.opkSecrets;

  try {
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
  } catch (err) {
    if (DEV) console.error('[socket] Failed to persist prekey secrets:', err);
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
  socket = io(RELAY_URL, {
    transports: ['websocket'],
    auth: { aegisId: identity.aegisId },
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

  socket.on('typing', ({ from, isTyping }: { from: string; isTyping: boolean }) => {
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
    if (!parsed.x3dh) {
      if (DEV) console.warn('[socket] No session and no X3DH headers — dropping message');
      return false;
    }

    const spkSec = await SecureStore.getItemAsync(SECURE_SPK_SECRET_KEY());
    if (!spkSec) {
      if (DEV) console.warn('[socket] mySpkSecret not found — cannot decrypt');
      return false;
    }
    const mySpkSecret = decodeBase64(spkSec);

    let myOpkSecret: Uint8Array | null = null;
    if (parsed.x3dh.opkId !== null) {
      const opkSecBase64 = await SecureStore.getItemAsync(opkSecretKey(parsed.x3dh.opkId));
      if (opkSecBase64) {
        myOpkSecret = decodeBase64(opkSecBase64);
        void SecureStore.deleteItemAsync(opkSecretKey(parsed.x3dh.opkId));
      } else {
        if (DEV)
          console.warn('[socket] OPK secret missing for keyId', parsed.x3dh.opkId, '— continuing without DH4');
      }
    }

    const senderPubKey = decodeBase64(contact.publicKeyB64);
    const rootKey = performX3DHReceiver(
      identity,
      mySpkSecret,
      myOpkSecret,
      senderPubKey,
      decodeBase64(parsed.x3dh.aliceEKB64),
    );

    const spkPublicKey = nacl.scalarMult.base(mySpkSecret);
    ratchetState = initRatchet(rootKey, decodeBase64(parsed.ratchet.ratchetKeyB64), false, {
      publicKey: spkPublicKey,
      secretKey: mySpkSecret,
    });
  }

  const rHeader = {
    ratchetKey: decodeBase64(parsed.ratchet.ratchetKeyB64),
    n: parsed.ratchet.n,
    pn: parsed.ratchet.pn,
  };
  const rCiphertext = decodeBase64(parsed.ratchet.ciphertextB64);
  const rNonce = decodeBase64(parsed.ratchet.nonceB64);

  const plaintextBytes = ratchetDecrypt(ratchetState, rHeader, rCiphertext, rNonce);
  if (!plaintextBytes) {
    if (DEV) console.warn('[socket] Double Ratchet decryption failed');
    return false;
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
  const contacts = useContacts.getState().contacts;
  let matchedContact = env.from ? contacts.find((c) => c.aegisId === env.from) : null;

  if (matchedContact?.blocked) return;

  if (!matchedContact && env.from) {
    try {
      matchedContact = await useContacts.getState().addByAegisId(env.from);
    } catch (e) {
      if (DEV) console.warn('[socket] failed to auto-add unknown sender', e);
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
  const isWork = idState.activeProfile === 'work';
  const senderName = isWork ? idState.workDisplayName : idState.displayName;
  const senderColor = isWork ? idState.workAvatarColor : idState.avatarColor;
  const senderStatus = isWork ? idState.workProfileStatus : idState.profileStatus;

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
  const isWork = idState.activeProfile === 'work';
  const senderName = isWork ? idState.workDisplayName : idState.displayName;
  const senderColor = isWork ? idState.workAvatarColor : idState.avatarColor;
  const senderStatus = isWork ? idState.workProfileStatus : idState.profileStatus;
  const rawImage = isWork ? idState.workAvatarImage : idState.avatarImage;
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
    const isWork = idState.activeProfile === 'work';
    const senderName = isWork ? idState.workDisplayName : idState.displayName;
    const senderColor = isWork ? idState.workAvatarColor : idState.avatarColor;
    const senderStatus = isWork ? idState.workProfileStatus : idState.profileStatus;
    const rawImage = isWork ? idState.workAvatarImage : idState.avatarImage;
    const senderImage = await toDataUri(rawImage);

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
}): Promise<void> {
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

  const { useIdentity } = await import('../store/identity');
  const idState = useIdentity.getState();
  const isWorkCtx = idState.activeProfile === 'work';
  const myDisplayName =
    (isWorkCtx ? idState.workDisplayName : idState.displayName) ||
    opts.identity.aegisId.substring(0, 8);

  const id = crypto.randomUUID();
  await useMessages.getState().append({
    id,
    chatId: opts.groupId,
    direction: 'out',
    body: `${myDisplayName}: ${opts.plaintext}`,
    createdAt: Date.now(),
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
