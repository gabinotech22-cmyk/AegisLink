import { create } from 'zustand';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { SERVER_URL } from '../config';

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
  parent_id?: string | null;
  reply_count?: number;
  attachments?: WorkAttachment[];
}

interface PinEvent {
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
  append: (msg: WorkMessage) => void;
  appendThreadReply: (reply: WorkMessage) => void;
  updateReplyCount: (parentId: string, replyCount: number) => void;
  sendMessage: (channelId: string, orgId: string, body: string, parentId?: string, attachments?: WorkAttachment[]) => void;
}

// ---------------------------------------------------------------------------
// signAdminAction — same pattern as desktop work.ts
// ---------------------------------------------------------------------------

function signAdminAction(orgId: string, action: string): { sig: string; ts: number } | null {
  const { useIdentity } = require('../store/identity') as {
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
  const { useIdentity } = require('../store/identity') as {
    useIdentity: { getState: () => { identity: { aegisId: string } | null } };
  };
  return useIdentity.getState().identity?.aegisId ?? null;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWorkMessages = create<WorkMessagesState>((set, _get) => ({
  byChannel: {},
  pinnedMessages: [],
  threadMessages: {},

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
      const data = (await res.json()) as { pinned?: WorkMessage[] };
      const pinned: WorkMessage[] = Array.isArray(data.pinned) ? data.pinned : [];
      set({ pinnedMessages: pinned });
    } catch {
      // Offline — keep existing pinned state
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
        `${SERVER_URL}/work/org/${orgId}/channels/${channelId}/messages/${encodeURIComponent(parentId)}/thread?${query}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { messages?: WorkMessage[] };
      const messages: WorkMessage[] = Array.isArray(data.messages) ? data.messages : [];
      set((s) => ({
        threadMessages: { ...s.threadMessages, [parentId]: messages },
      }));
    } catch {
      // Offline — keep existing thread state
    }
  },

  handlePinEvent(ev) {
    set((s) => {
      if (ev.pin) {
        // Find message in byChannel to add full object; fall back to stub
        const channelMsgs = s.byChannel[ev.channelId] ?? [];
        const found = channelMsgs.find((m) => m.id === ev.messageId);
        if (!found) return s;
        const alreadyPinned = s.pinnedMessages.some((m) => m.id === ev.messageId);
        if (alreadyPinned) return s;
        return { pinnedMessages: [...s.pinnedMessages, found] };
      } else {
        return {
          pinnedMessages: s.pinnedMessages.filter((m) => m.id !== ev.messageId),
        };
      }
    });
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

  append(msg) {
    set((s) => {
      const existing = s.byChannel[msg.channelId] ?? [];
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
        const idx = msgs.findIndex((m) => m.id === parentId);
        if (idx !== -1) {
          const copy = [...msgs];
          copy[idx] = { ...copy[idx], reply_count: replyCount };
          updated[channelId] = copy;
        } else {
          updated[channelId] = msgs;
        }
      }
      return { byChannel: updated };
    });
  },

  sendMessage(channelId, orgId, body, parentId, attachments) {
    const aegisId = getAegisId();
    if (!aegisId) return;

    const id = crypto.randomUUID();
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
      attachments: attachments ?? [],
    };

    if (!parentId) {
      set((s) => {
        const existing = s.byChannel[channelId] ?? [];
        return {
          byChannel: { ...s.byChannel, [channelId]: [...existing, msg] },
        };
      });
    } else {
      set((s) => {
        const existing = s.threadMessages[parentId] ?? [];
        if (existing.some((m) => m.id === id)) return s;
        return {
          threadMessages: { ...s.threadMessages, [parentId]: [...existing, msg] },
        };
      });
    }

    const { emitChannelMsg } = require('../socket/client') as {
      emitChannelMsg: (payload: object) => void;
    };
    emitChannelMsg({
      id,
      channelId,
      orgId,
      body,
      type: msgType,
      parent_id: parentId ?? undefined,
      attachments: attachments ?? [],
    });
  },
}));
