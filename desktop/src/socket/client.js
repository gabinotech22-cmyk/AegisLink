import { io } from 'socket.io-client';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { hkdfSHA256 } from '../crypto/signal/kdf.js';
import { useStore } from '../store/index.js';
import { saveMessage, updateMessageStatus, loadRatchetSession, saveRatchetSession } from '../db/local.js';
import { tryDecryptMessage, encryptMessage } from '../crypto/messaging.js';
import { initRatchet } from '../crypto/signal/ratchet.js';

let socket = null;

// ─── Ratchet state cache (in-memory, backed by DB) ───────────────────────────

const ratchetCache = new Map(); // aegisId -> ratchetState

/**
 * Derive a deterministic shared root key from static DH between the two parties.
 * This bootstraps the Double Ratchet without requiring a full X3DH prekey flow,
 * which is acceptable for desktop↔desktop or desktop↔mobile when both sides
 * use the same derivation.
 *
 * Role (isAlice) is determined by lexicographic order of aegisIds so both
 * sides agree without coordination.
 */
function deriveStaticRootKey(mySecretKey, contactPublicKey, myAegisId, contactAegisId) {
  const dh = nacl.scalarMult(mySecretKey, contactPublicKey);
  const salt = new Uint8Array(32);
  const info = new TextEncoder().encode('AegisLinkStaticRatchet');
  return hkdfSHA256(dh, salt, info, 32);
}

function isAliceRole(myAegisId, contactAegisId) {
  return myAegisId < contactAegisId;
}

async function getRatchetState(aegisId, identity, contact) {
  if (ratchetCache.has(aegisId)) return ratchetCache.get(aegisId);
  const json = await loadRatchetSession(aegisId);
  if (json) {
    try {
      const parsed = JSON.parse(json);
      const state = deserializeRatchetState(parsed);
      ratchetCache.set(aegisId, state);
      return state;
    } catch {
      // Fall through to create new
    }
  }
  const contactPubKey = decodeBase64(contact.publicKeyB64);
  const rootKey = deriveStaticRootKey(
    decodeBase64(identity.secretKeyB64),
    contactPubKey,
    identity.aegisId,
    contact.aegisId,
  );
  const alice = isAliceRole(identity.aegisId, contact.aegisId);
  const state = initRatchet(rootKey, contactPubKey, alice, null);
  ratchetCache.set(aegisId, state);
  await persistRatchetState(aegisId, state);
  return state;
}

async function persistRatchetState(aegisId, state) {
  await saveRatchetSession(aegisId, JSON.stringify(serializeRatchetState(state)));
}

function serializeRatchetState(state) {
  const s = { ...state };
  if (s.DHs) s.DHs = { publicKey: encodeBase64(s.DHs.publicKey), secretKey: encodeBase64(s.DHs.secretKey) };
  if (s.DHr) s.DHr = encodeBase64(s.DHr);
  if (s.RK) s.RK = encodeBase64(s.RK);
  if (s.CKs) s.CKs = encodeBase64(s.CKs);
  if (s.CKr) s.CKr = encodeBase64(s.CKr);
  // MKSKIPPED map -> array of [key, b64val]
  if (s.MKSKIPPED instanceof Map) {
    s.MKSKIPPED = [...s.MKSKIPPED.entries()].map(([k, v]) => [k, encodeBase64(v)]);
  }
  return s;
}

function deserializeRatchetState(s) {
  const state = { ...s };
  if (state.DHs) state.DHs = { publicKey: decodeBase64(state.DHs.publicKey), secretKey: decodeBase64(state.DHs.secretKey) };
  if (state.DHr && typeof state.DHr === 'string') state.DHr = decodeBase64(state.DHr);
  if (state.RK && typeof state.RK === 'string') state.RK = decodeBase64(state.RK);
  if (state.CKs && typeof state.CKs === 'string') state.CKs = decodeBase64(state.CKs);
  if (state.CKr && typeof state.CKr === 'string') state.CKr = decodeBase64(state.CKr);
  if (Array.isArray(state.MKSKIPPED)) {
    state.MKSKIPPED = new Map(state.MKSKIPPED.map(([k, v]) => [k, decodeBase64(v)]));
  } else {
    state.MKSKIPPED = new Map();
  }
  return state;
}

// ─── Connect ─────────────────────────────────────────────────────────────────

export function connectToRelay(identity) {
  if (socket?.connected) return socket;
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
  }

  const RELAY = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_RELAY_URL)
    ? import.meta.env.VITE_RELAY_URL
    : 'http://localhost:3001';

  socket = io(RELAY, {
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
    reconnectionAttempts: Infinity,
    auth: { aegisId: identity.aegisId, platform: 'desktop' },
  });

  socket.on('auth:challenge', ({ ephemeralPubKey, nonce, ciphertext }) => {
    try {
      const decrypted = nacl.box.open(
        decodeBase64(ciphertext),
        decodeBase64(nonce),
        decodeBase64(ephemeralPubKey),
        decodeBase64(identity.secretKeyB64),
      );
      if (decrypted) {
        socket.emit('auth:response', { plain: encodeBase64(decrypted) });
      }
    } catch {
      // Auth challenge decryption failed — ignore, will timeout
    }
  });

  socket.on('auth:ok', () => {
    useStore.getState().setConnected(true);
    useStore.getState().addAuditEntry({ sev: 'ok', msg: `Relay connected · ${identity.aegisId}` });
  });

  socket.on('disconnect', () => {
    useStore.getState().setConnected(false);
    useStore.getState().addAuditEntry({ sev: 'warn', msg: 'Relay disconnected' });
  });

  socket.on('envelope', (envelope) => {
    handleIncomingEnvelope(envelope, identity);
  });

  socket.on('msg:delivered', ({ msgId }) => {
    updateMessageStatus(msgId, 'delivered').catch(() => {});
    // Update in-memory store: find the message across all conversations and update status
    const { messages } = useStore.getState();
    for (const [aegisId, msgs] of Object.entries(messages)) {
      const idx = msgs.findIndex((m) => m.id === msgId);
      if (idx !== -1) {
        const updated = [...msgs];
        updated[idx] = { ...updated[idx], status: 'delivered' };
        useStore.getState().setMessages(aegisId, updated);
        break;
      }
    }
  });

  socket.on('msg:read', ({ from, msgIds }) => {
    const { messages } = useStore.getState();
    const msgs = messages[from];
    if (!msgs) return;
    const updated = msgs.map((m) =>
      msgIds.includes(m.id) ? { ...m, status: 'read' } : m,
    );
    useStore.getState().setMessages(from, updated);
    // Also persist
    for (const id of msgIds) {
      updateMessageStatus(id, 'read').catch(() => {});
    }
  });

  // Typing indicators
  socket.on('typing', ({ from, isTyping }) => {
    useStore.getState().setTyping(from, isTyping);
  });

  // Message delete (remote)
  socket.on('msg:delete', ({ from, msgId }) => {
    const state = useStore.getState();
    const msgs = state.messages[from] ?? [];
    useStore.setState({
      messages: {
        ...state.messages,
        [from]: msgs.map(m => m.id === msgId
          ? { ...m, deleted: true, body: '', mediaUri: null }
          : m
        ),
      },
    });
  });

  return socket;
}

export function disconnectFromRelay() {
  if (socket) {
    socket.removeAllListeners();
    socket.disconnect();
    socket = null;
    useStore.getState().setConnected(false);
  }
}

export function getSocket() {
  return socket;
}

// ─── Incoming envelope handler ───────────────────────────────────────────────

async function handleIncomingEnvelope(envelope, identity) {
  const contacts = useStore.getState().contacts;
  // Trial-decrypt against each known contact (sealed sender)
  for (const contact of contacts) {
    try {
      const senderPubKey = decodeBase64(contact.publicKeyB64);
      const ratchetState = await getRatchetState(contact.aegisId, identity, contact);
      // Relay sends { ciphertext, nonce } (no B64 suffix in field names)
      const envelopeNormalized = {
        ciphertextB64: envelope.ciphertextB64 ?? envelope.ciphertext,
        nonceB64: envelope.nonceB64 ?? envelope.nonce,
      };
      const result = tryDecryptMessage(
        envelopeNormalized,
        senderPubKey,
        decodeBase64(identity.secretKeyB64),
        ratchetState,
      );
      if (!result) continue;

      // Persist updated ratchet state
      ratchetCache.set(contact.aegisId, result.newState);
      await persistRatchetState(contact.aegisId, result.newState);

      const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

      // Parse extended fields embedded in body (replyToId, mediaUri, type)
      let bodyText = result.body;
      let msgType = envelope.type ?? 'text';
      let replyToId = envelope.replyToId ?? null;
      let mediaUri = envelope.mediaUri ?? null;

      // Detect image / audio / location payloads in body
      if (bodyText.startsWith('[image:') || bodyText.startsWith('[audio:') || bodyText.startsWith('[location:')) {
        if (bodyText.startsWith('[image:')) msgType = 'image';
        else if (bodyText.startsWith('[audio:')) msgType = 'audio';
        else if (bodyText.startsWith('[location:')) msgType = 'location';
      }

      const msg = {
        id: envelope.id ?? String(Date.now()),
        mine: false,
        text: bodyText,
        time,
        status: 'delivered',
        type: msgType,
        replyToId,
        mediaUri,
      };

      // Persist to DB
      await saveMessage({
        id: msg.id,
        chatId: contact.aegisId,
        direction: 'in',
        body: bodyText,
        createdAt: envelope.createdAt ?? Date.now(),
        deliveryStatus: 'delivered',
        type: msgType,
        replyToId,
        mediaUri,
      });

      // Update store
      useStore.getState().appendMessage(contact.aegisId, msg);
      useStore.getState().addAuditEntry({ sev: 'info', msg: `Message received from ${contact.name || contact.aegisId}` });
      useStore.getState().updateConversation(contact.aegisId, {
        lastMsg: msgType !== 'text' ? `[${msgType}]` : bodyText,
        lastTime: time,
        unread: (useStore.getState().conversations[contact.aegisId]?.unread ?? 0) + 1,
      });

      // Send read receipt if this is the active chat
      const activeChat = useStore.getState().activeChat;
      if (activeChat === contact.aegisId && socket?.connected) {
        socket.emit('msg:read', { to: contact.aegisId, msgIds: [msg.id] });
        useStore.getState().updateConversation(contact.aegisId, { unread: 0 });
      }

      // Desktop notification if chat is not active
      if (activeChat !== contact.aegisId) {
        const { settings } = useStore.getState();
        if (settings?.notifications_enabled !== false) {
          try {
            if (Notification.permission === 'default') {
              Notification.requestPermission();
            } else if (Notification.permission === 'granted') {
              new Notification(contact.name || contact.aegisId, {
                body: 'Nuevo mensaje cifrado',
                silent: settings?.sound_enabled === false,
              });
            }
          } catch { /* Notification API may be unavailable */ }
        }
      }

      break;
    } catch {
      // Try next contact
    }
  }
}

// ─── Send message ─────────────────────────────────────────────────────────────

export async function sendMessage(toAegisId, text, identity, contact, msgId, opts = {}) {
  if (!socket?.connected) return false;

  const ratchetState = await getRatchetState(toAegisId, identity, contact);

  const recipientPubKey = decodeBase64(contact.publicKeyB64);
  const mySecretKey = decodeBase64(identity.secretKeyB64);
  let encResult;
  try {
    encResult = encryptMessage(text, identity.aegisId, recipientPubKey, mySecretKey, ratchetState);
  } catch {
    return false;
  }

  const { envelope, newState } = encResult;
  // Persist updated ratchet state
  ratchetCache.set(toAegisId, newState);
  await persistRatchetState(toAegisId, newState);

  return new Promise((resolve) => {
    socket.emit(
      'envelope',
      {
        id: msgId,
        to: toAegisId,
        ciphertext: envelope.ciphertextB64 ?? envelope.ciphertext,
        nonce: envelope.nonceB64 ?? envelope.nonce,
        type: opts.type ?? 'text',
        replyToId: opts.replyToId ?? null,
        mediaUri: opts.mediaUri ?? null,
      },
      (ack) => {
        const status = ack?.ok ? (ack.queued ? 'sent' : 'delivered') : 'sent';
        updateMessageStatus(msgId, status).catch(() => {});
        // Update store status
        const { messages } = useStore.getState();
        const msgs = messages[toAegisId] ?? [];
        const idx = msgs.findIndex((m) => m.id === msgId);
        if (idx !== -1) {
          const updated = [...msgs];
          updated[idx] = { ...updated[idx], status };
          useStore.getState().setMessages(toAegisId, updated);
        }
        resolve(true);
      },
    );
  });
}

// ─── Additional socket emitters ──────────────────────────────────────────────

export function emitTyping(to, isTyping) {
  if (!socket?.connected) return;
  socket.emit('typing', { to, isTyping });
}

export function sendReadReceipts(to, msgIds) {
  if (!socket?.connected || !msgIds.length) return;
  socket.emit('msg:read', { to, msgIds });
}

export function sendDeleteForEveryone(to, msgId) {
  if (!socket?.connected) return;
  socket.emit('msg:delete', { to, msgId });
}

export async function sendGroupMessage({ identity, groupId, plaintext, store: storeRef }) {
  const group = storeRef.getState().groups.find(g => g.id === groupId);
  if (!group) return;
  const contacts = storeRef.getState().contacts;
  const { encryptMessage: encMsg } = await import('../crypto/messaging.js');
  const { initRatchet: initR } = await import('../crypto/signal/ratchet.js');
  group.members.forEach(async (memberId) => {
    if (memberId === identity.aegisId) return;
    const contact = contacts.find(c => c.aegisId === memberId);
    if (!contact) return;
    try {
      const ratchetState = await getRatchetState(memberId, identity, contact);
      const recipientPubKey = decodeBase64(contact.publicKeyB64);
      const mySecretKey = decodeBase64(identity.secretKeyB64);
      const { envelope, newState } = encMsg(plaintext, identity.aegisId, recipientPubKey, mySecretKey, ratchetState);
      ratchetCache.set(memberId, newState);
      await persistRatchetState(memberId, newState);
      socket.emit('envelope', {
        id: crypto.randomUUID(),
        to: memberId,
        ciphertext: envelope.ciphertextB64 ?? envelope.ciphertext,
        nonce: envelope.nonceB64 ?? envelope.nonce,
      });
    } catch(e) { /* group multicast failed for this member */ }
  });
}

// ─── Fetch prekey bundle for a new contact ────────────────────────────────────

export function fetchPrekeyBundle(aegisId) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(new Error('Not connected to relay'));
      return;
    }
    socket.emit('prekeys:fetch', { aegisId }, (res) => {
      if (res?.ok && res.bundle) {
        resolve(res.bundle);
      } else {
        reject(new Error(res?.error ?? 'prekeys:fetch failed'));
      }
    });
  });
}
