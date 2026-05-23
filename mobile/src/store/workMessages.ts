import { create } from 'zustand';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { SERVER_URL } from '../config';
import {
  generateSenderKey,
  encryptChannelMessage,
  decryptChannelMessage,
  ratchetSenderKey,
  type SenderKey,
} from '../crypto/channelKey';
import { loadSenderKey, saveSenderKey } from '../crypto/channelKeyStore';

const ENCRYPTED_PENDING_PLACEHOLDER = '🔐 Mensaje cifrado (clave pendiente)';

/**
 * Advance a recipient-held SenderKey forward to `targetIteration`, decrypt, and
 * persist the resulting key. The sender ratchets once per message; a recipient
 * may receive messages out of order or have missed some, so we fast-forward the
 * chain (one-way) until iterations align. Returns null if the target iteration
 * is behind what we already hold (cannot rewind — forward secrecy).
 */
async function decryptAtIteration(
  channelId: string,
  senderAegisId: string,
  ciphertextB64: string,
  nonceB64: string,
  targetIteration: number,
): Promise<string | null> {
  let sk = await loadSenderKey(channelId, senderAegisId);
  if (!sk) return null;
  if (targetIteration < sk.iteration) return null;
  while (sk.iteration < targetIteration) {
    sk = ratchetSenderKey(sk);
  }
  const body = decryptChannelMessage(ciphertextB64, nonceB64, sk);
  // Persist the ratcheted-forward key (advance past this message).
  await saveSenderKey(channelId, senderAegisId, ratchetSenderKey(sk));
  return body;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkAttachment {
  id: string;
  messageId: string;
  blobId: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  uploadedBy: string;
  createdAt: string;
}

export interface WorkMessage {
  id: string;
  channelId: string;
  orgId: string;
  senderId: string;
  body: string;
  type: 'text' | 'image' | 'file';
  createdAt: number;
  is_pinned?: boolean;
  parent_id?: string | null;
  reply_count?: number;
  attachments?: WorkAttachment[];
  encrypted?: boolean;
  nonce?: string;
  keyIteration?: number;
}

export interface PinEvent {
  channelId: string;
  messageId: string;
  pin: boolean;
  pinnedBy: string;
  pinnedAt: string;
}

interface WorkMessagesState {
  byChannel: Record<string, WorkMessage[]>;
  pinnedMessages: WorkMessage[];
  threadMessages: Record<string, WorkMessage[]>;
  loadMessages: (channelId: string, orgId: string) => Promise<void>;
  loadPinned: (orgId: string, channelId: string) => Promise<void>;
  loadThread: (orgId: string, channelId: string, parentId: string) => Promise<void>;
  handlePinEvent: (ev: PinEvent) => void;
  markDeleted: (channelId: string, messageId: string) => void;
  deleteMessage: (orgId: string, channelId: string, messageId: string) => Promise<void>;
  append: (msg: WorkMessage) => void;
  appendThreadReply: (reply: WorkMessage) => void;
  updateReplyCount: (parentId: string, replyCount: number) => void;
  sendMessage: (channelId: string, orgId: string, body: string, parentId?: string, attachments?: WorkAttachment[]) => void;
}

// ---------------------------------------------------------------------------
// signAdminAction — copied from work.ts (same pattern, no import cycle)
// ---------------------------------------------------------------------------

function signAdminAction(orgId: string, action: string): { sig: string; ts: number } | null {
  const { useIdentity } = require('./identity') as {
    useIdentity: { getState: () => { identity: { signingSecretKeyB64: string } | null } };
  };
  const skB64 = useIdentity.getState().identity?.signingSecretKeyB64;
  if (!skB64) return null;
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const message = new TextEncoder().encode(`${orgId}:${action}:${timeBucket}`);
  const sigBytes = nacl.sign.detached(message, decodeBase64(skB64));
  return { sig: encodeBase64(sigBytes), ts };
}

function getAegisId(): string | null {
  const { useIdentity } = require('./identity') as {
    useIdentity: { getState: () => { identity: { aegisId: string } | null } };
  };
  return useIdentity.getState().identity?.aegisId ?? null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWorkMessages = create<WorkMessagesState>((set, get) => ({
  byChannel: {},
  pinnedMessages: [],
  threadMessages: {},

  async loadPinned(orgId, channelId) {
    const aegisId = getAegisId();
    if (!aegisId) return;

    const adminSig = signAdminAction(orgId, 'read_pinned');
    const query = adminSig
      ? `aegisId=${encodeURIComponent(aegisId)}&sig=${encodeURIComponent(adminSig.sig)}&ts=${adminSig.ts}`
      : `aegisId=${encodeURIComponent(aegisId)}`;

    try {
      const res = await fetch(
        `${SERVER_URL}/work/org/${orgId}/channels/${channelId}/pinned?${query}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: WorkMessage[] };
      const messages: WorkMessage[] = Array.isArray(data.messages) ? data.messages : [];
      set({ pinnedMessages: messages });
    } catch {
      // Offline — keep existing pinned state, do not crash
    }
  },

  handlePinEvent(ev) {
    const { byChannel, pinnedMessages } = get();
    if (ev.pin) {
      // Find the message in byChannel to append to pinnedMessages
      const channelMsgs = byChannel[ev.channelId] ?? [];
      const msg = channelMsgs.find((m) => m.id === ev.messageId);
      if (!msg) return;
      // Avoid duplicates
      if (pinnedMessages.some((m) => m.id === ev.messageId)) return;
      set({ pinnedMessages: [...pinnedMessages, { ...msg, is_pinned: true }] });
      // Also update is_pinned flag in byChannel
      set((s) => ({
        byChannel: {
          ...s.byChannel,
          [ev.channelId]: (s.byChannel[ev.channelId] ?? []).map((m) =>
            m.id === ev.messageId ? { ...m, is_pinned: true } : m,
          ),
        },
      }));
    } else {
      set({ pinnedMessages: pinnedMessages.filter((m) => m.id !== ev.messageId) });
      // Also clear is_pinned flag in byChannel
      set((s) => ({
        byChannel: {
          ...s.byChannel,
          [ev.channelId]: (s.byChannel[ev.channelId] ?? []).map((m) =>
            m.id === ev.messageId ? { ...m, is_pinned: false } : m,
          ),
        },
      }));
    }
  },

  async loadMessages(channelId, orgId) {
    const aegisId = getAegisId();
    if (!aegisId) return;

    const adminSig = signAdminAction(orgId, 'read_messages');
    const query = adminSig
      ? `aegisId=${encodeURIComponent(aegisId)}&sig=${encodeURIComponent(adminSig.sig)}&ts=${adminSig.ts}&limit=50`
      : `aegisId=${encodeURIComponent(aegisId)}&limit=50`;

    try {
      const res = await fetch(
        `${SERVER_URL}/work/org/${orgId}/channels/${channelId}/messages?${query}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: WorkMessage[] };
      const messages: WorkMessage[] = Array.isArray(data.messages) ? data.messages : [];
      set((s) => ({
        byChannel: { ...s.byChannel, [channelId]: messages },
      }));
    } catch {
      // Offline — keep existing messages in state, do not crash
    }
  },

  async loadThread(orgId, channelId, parentId) {
    const aegisId = getAegisId();
    if (!aegisId) return;

    const adminSig = signAdminAction(orgId, 'read_thread');
    const query = adminSig
      ? `aegisId=${encodeURIComponent(aegisId)}&sig=${encodeURIComponent(adminSig.sig)}&ts=${adminSig.ts}`
      : `aegisId=${encodeURIComponent(aegisId)}`;

    try {
      const res = await fetch(
        `${SERVER_URL}/work/org/${orgId}/channels/${channelId}/messages/${parentId}/thread?${query}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { replies?: WorkMessage[] };
      const replies: WorkMessage[] = Array.isArray(data.replies) ? data.replies : [];
      set((s) => ({
        threadMessages: { ...s.threadMessages, [parentId]: replies },
      }));
    } catch {
      // Offline — keep existing thread state, do not crash
    }
  },

  markDeleted(channelId, messageId) {
    set((s) => ({
      byChannel: {
        ...s.byChannel,
        [channelId]: (s.byChannel[channelId] ?? []).map((m) =>
          m.id === messageId ? { ...m, body: '', type: 'deleted' as WorkMessage['type'] } : m,
        ),
      },
    }));
  },

  async deleteMessage(orgId, channelId, messageId) {
    const aegisId = getAegisId();
    if (!aegisId) return;

    const adminSig = signAdminAction(orgId, 'delete_message');
    if (!adminSig) return;

    const query = `aegisId=${encodeURIComponent(aegisId)}&sig=${encodeURIComponent(adminSig.sig)}&ts=${adminSig.ts}`;
    try {
      const res = await fetch(
        `${SERVER_URL}/work/org/${orgId}/channels/${channelId}/messages/${messageId}?${query}`,
        { method: 'DELETE' },
      );
      if (!res.ok) return;
      // Optimistic already done by caller; the socket event will confirm
      get().markDeleted(channelId, messageId);
    } catch {
      // Offline — silent
    }
  },

  append(msg) {
    // Encrypted incoming messages: insert a placeholder synchronously, then
    // decrypt asynchronously and patch the body in place.
    if (msg.encrypted && msg.type === 'text') {
      const myAegisId = getAegisId();
      const placeholder: WorkMessage = { ...msg, body: ENCRYPTED_PENDING_PLACEHOLDER };
      set((s) => {
        const existing = s.byChannel[msg.channelId] ?? [];
        if (existing.some((m) => m.id === msg.id)) return s;
        return {
          byChannel: { ...s.byChannel, [msg.channelId]: [...existing, placeholder] },
        };
      });

      // Our own echoed message: we already rendered the plaintext optimistically;
      // skip self-decrypt (our SenderKey has already ratcheted past it).
      if (myAegisId && msg.senderId === myAegisId) return;

      void (async () => {
        const targetIteration = typeof msg.keyIteration === 'number' ? msg.keyIteration : 0;
        const nonceB64 = msg.nonce ?? '';
        let plaintext: string | null = null;
        try {
          plaintext = await decryptAtIteration(
            msg.channelId,
            msg.senderId,
            msg.body,
            nonceB64,
            targetIteration,
          );
        } catch {
          plaintext = null;
        }

        if (plaintext === null) {
          // No SenderKey for this sender yet — ask them to distribute one.
          const { emitRequestSenderKey } = require('../socket/client') as {
            emitRequestSenderKey: (p: { channelId: string; orgId: string; fromAegisId: string }) => void;
          };
          emitRequestSenderKey({ channelId: msg.channelId, orgId: msg.orgId, fromAegisId: msg.senderId });
          return;
        }

        const decrypted = plaintext;
        set((s) => ({
          byChannel: {
            ...s.byChannel,
            [msg.channelId]: (s.byChannel[msg.channelId] ?? []).map((m) =>
              m.id === msg.id ? { ...m, body: decrypted, encrypted: false } : m,
            ),
          },
        }));
      })();
      return;
    }

    set((s) => {
      const existing = s.byChannel[msg.channelId] ?? [];
      // Deduplicate by id
      if (existing.some((m) => m.id === msg.id)) return s;
      return {
        byChannel: {
          ...s.byChannel,
          [msg.channelId]: [...existing, msg],
        },
      };
    });
  },

  appendThreadReply(reply) {
    if (!reply.parent_id) return;
    const parentId = reply.parent_id;
    set((s) => {
      const existing = s.threadMessages[parentId] ?? [];
      if (existing.some((m) => m.id === reply.id)) return s;
      return {
        threadMessages: {
          ...s.threadMessages,
          [parentId]: [...existing, reply],
        },
      };
    });
  },

  updateReplyCount(parentId, replyCount) {
    set((s) => {
      const updated: Record<string, WorkMessage[]> = {};
      for (const [channelId, msgs] of Object.entries(s.byChannel)) {
        updated[channelId] = msgs.map((m) =>
          m.id === parentId ? { ...m, reply_count: replyCount } : m,
        );
      }
      return { byChannel: updated };
    });
  },

  sendMessage(channelId, orgId, body, parentId, attachments) {
    const aegisId = getAegisId();
    if (!aegisId) return;

    const id =
      typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2) + Date.now().toString(36);

    const msgType: WorkMessage['type'] =
      attachments && attachments.length > 0
        ? attachments[0].mimeType.startsWith('image/')
          ? 'image'
          : 'file'
        : 'text';

    const msg: WorkMessage = {
      id,
      channelId,
      orgId,
      senderId: aegisId,
      body,
      type: msgType,
      createdAt: Date.now(),
      parent_id: parentId ?? null,
      attachments,
    };

    if (parentId) {
      // Optimistic append to thread
      set((s) => {
        const existing = s.threadMessages[parentId] ?? [];
        return {
          threadMessages: { ...s.threadMessages, [parentId]: [...existing, msg] },
        };
      });
    } else {
      // Optimistic local append to channel
      set((s) => {
        const existing = s.byChannel[channelId] ?? [];
        return {
          byChannel: { ...s.byChannel, [channelId]: [...existing, msg] },
        };
      });
    }

    // Encrypt with the sender's SenderKey, then emit. Done async so the
    // optimistic local append (plaintext, above) renders immediately.
    void (async () => {
      const { emitChannelMsg } = require('../socket/client') as {
        emitChannelMsg: (payload: object) => void;
      };

      // Attachments-only messages have no text body to seal under the channel
      // SenderKey; the attachment payload is itself ephemeral-key encrypted.
      if (msgType === 'text') {
        let mySenderKey: SenderKey | null = await loadSenderKey(channelId, aegisId);
        if (!mySenderKey) {
          mySenderKey = generateSenderKey();
          await saveSenderKey(channelId, aegisId, mySenderKey);
        }
        const usedIteration = mySenderKey.iteration;
        const { ciphertextB64, nonceB64, newSenderKey } = encryptChannelMessage(body, mySenderKey);
        await saveSenderKey(channelId, aegisId, newSenderKey);

        emitChannelMsg({
          id,
          channelId,
          orgId,
          body: ciphertextB64,
          nonce: nonceB64,
          keyIteration: usedIteration,
          encrypted: true,
          type: msgType,
          parent_id: parentId ?? undefined,
          attachments,
        });
        return;
      }

      emitChannelMsg({
        id,
        channelId,
        orgId,
        body,
        type: msgType,
        parent_id: parentId ?? undefined,
        attachments,
      });
    })();
  },
}));
