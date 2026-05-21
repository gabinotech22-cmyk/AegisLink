import { create } from 'zustand';
import {
  loadMessagesByChat,
  saveMessage,
  lastMessageByChat,
  getChatState,
  setChatDraft,
  incrementUnread,
  resetUnread,
  getAllUnreadCounts,
  deleteExpiredMessages,
  deleteContactMessages,
  deleteChatState,
  deleteContactRatchetSession,
  type StoredMessage,
} from '../db/local';

interface MessagesState {
  byChat: Record<string, StoredMessage[]>;
  previews: Record<string, StoredMessage>;
  pinnedMsg: Record<string, StoredMessage | null>;
  ephemeralTimer: number;
  pendingMediaUri: string | null;
  /** Unread incoming message count per chatId */
  unreadCounts: Record<string, number>;
  /** Saved draft text per chatId */
  drafts: Record<string, string>;

  loadChat: (chatId: string) => Promise<StoredMessage[]>;
  append: (m: StoredMessage) => Promise<void>;
  refreshPreview: (chatId: string) => Promise<void>;
  setEphemeralTimer: (seconds: number) => void;
  pruneExpired: () => void;
  setPendingMedia: (uri: string | null) => void;
  markRead: (chatId: string) => Promise<void>;
  saveDraft: (chatId: string, text: string) => Promise<void>;
  loadAllUnreads: () => Promise<void>;
  // Message actions
  toggleStar: (chatId: string, id: string) => Promise<void>;
  softDelete: (chatId: string, id: string) => Promise<void>;
  toggleReaction: (chatId: string, id: string, emoji: string, aegisId?: string) => Promise<void>;
  updateDelivery: (chatId: string, id: string, status: 'sent' | 'delivered' | 'read') => Promise<void>;
  remoteDelete: (chatId: string, id: string) => Promise<void>;
  togglePin: (chatId: string, id: string) => Promise<void>;
  clearChat: (chatId: string) => Promise<void>;
}

export const useMessages = create<MessagesState>((set, get) => ({
  byChat: {},
  previews: {},
  pinnedMsg: {},
  ephemeralTimer: 0,
  pendingMediaUri: null,
  unreadCounts: {},
  drafts: {},

  setPendingMedia(uri) {
    set({ pendingMediaUri: uri });
  },

  async loadChat(chatId) {
    const { usePreferences } = require('./preferences');
    if (usePreferences.getState().duressActive) {
      return [];
    }
    const cached = get().byChat[chatId];
    if (cached) return cached;
    let list = await loadMessagesByChat(chatId);

    // Filter already-expired messages (expiresAt is the authoritative expiry field;
    // the ephemeralTimer only applies to messages sent after it was set)
    const now = Date.now();
    list = list.filter((m) => !m.expiresAt || m.expiresAt > now);

    const pinned = list.find((m) => m.pinned) ?? null;
    const { draft, unreadCount } = await getChatState(chatId);

    set((s) => ({
      byChat: { ...s.byChat, [chatId]: list },
      pinnedMsg: { ...s.pinnedMsg, [chatId]: pinned },
      drafts: draft !== null ? { ...s.drafts, [chatId]: draft } : s.drafts,
      unreadCounts: { ...s.unreadCounts, [chatId]: unreadCount },
    }));

    const last = list[list.length - 1];
    if (last) set((s) => ({ previews: { ...s.previews, [chatId]: last } }));
    return list;
  },

  async append(m) {
    await saveMessage(m);
    set((s) => {
      const existing = s.byChat[m.chatId] ?? [];
      const next: Partial<MessagesState> = {
        byChat: { ...s.byChat, [m.chatId]: [...existing, m] },
        previews: { ...s.previews, [m.chatId]: m },
      };
      if (m.direction === 'in') {
        next.unreadCounts = { ...s.unreadCounts, [m.chatId]: (s.unreadCounts[m.chatId] ?? 0) + 1 };
        incrementUnread(m.chatId).catch(() => {});
      }
      return next;
    });
  },

  async refreshPreview(chatId) {
    const last = await lastMessageByChat(chatId);
    if (!last) return;
    set((s) => ({ previews: { ...s.previews, [chatId]: last } }));
  },

  async markRead(chatId) {
    await resetUnread(chatId);
    set((s) => ({ unreadCounts: { ...s.unreadCounts, [chatId]: 0 } }));
  },

  async saveDraft(chatId, text) {
    const trimmed = text.trim();
    await setChatDraft(chatId, trimmed || null);
    set((s) => ({
      drafts: trimmed ? { ...s.drafts, [chatId]: trimmed } : (() => {
        const d = { ...s.drafts };
        delete d[chatId];
        return d;
      })(),
    }));
  },

  async loadAllUnreads() {
    const counts = await getAllUnreadCounts();
    set((s) => ({ unreadCounts: { ...s.unreadCounts, ...counts } }));
  },

  setEphemeralTimer(seconds) {
    set({ ephemeralTimer: seconds });
    get().pruneExpired();
  },

  pruneExpired() {
    const timer = get().ephemeralTimer;
    const now = Date.now();
    const updatedByChat = { ...get().byChat };
    let changed = false;

    for (const [chatId, list] of Object.entries(updatedByChat)) {
      const filtered = list.filter((m) => {
        if (m.expiresAt && now >= m.expiresAt) return false;
        if (timer > 0 && now - m.createdAt >= timer * 1000) return false;
        return true;
      });
      if (filtered.length !== list.length) {
        updatedByChat[chatId] = filtered;
        changed = true;
      }
    }

    if (changed) set({ byChat: updatedByChat });
    // Also delete from DB
    deleteExpiredMessages(timer).catch(() => {});
  },

  async toggleStar(chatId, id) {
    const { setMessageStarred } = require('../db/local');
    const list = get().byChat[chatId] ?? [];
    const msg = list.find((m) => m.id === id);
    if (!msg) return;
    const next = !msg.starred;
    await setMessageStarred(id, next);
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) => (m.id === id ? { ...m, starred: next } : m)),
      },
    }));
  },

  async softDelete(chatId, id) {
    const { setMessageDeleted } = require('../db/local');
    await setMessageDeleted(id);
    const list = get().byChat[chatId] ?? [];
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) =>
          m.id === id ? { ...m, deleted: true, body: '', mediaUri: null } : m
        ),
      },
    }));
  },

  async toggleReaction(chatId, id, emoji, aegisId) {
    const { setMessageReactions } = require('../db/local');
    const list = get().byChat[chatId] ?? [];
    const msg = list.find((m) => m.id === id);
    if (!msg) return;
    const current = { ...(msg.reactions ?? {}) };
    const reactorId = aegisId ?? 'self';
    const reactors = new Set(current[emoji] ?? []);
    if (reactors.has(reactorId)) reactors.delete(reactorId);
    else reactors.add(reactorId);
    if (reactors.size === 0) delete current[emoji];
    else current[emoji] = Array.from(reactors);

    await setMessageReactions(id, current);
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) => (m.id === id ? { ...m, reactions: current } : m)),
      },
    }));
  },

  async updateDelivery(chatId, id, status) {
    const { updateMessageDelivery } = require('../db/local');
    await updateMessageDelivery(id, status);
    const list = get().byChat[chatId] ?? [];
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) => (m.id === id ? { ...m, deliveryStatus: status } : m)),
      },
    }));
  },

  async remoteDelete(chatId, id) {
    const { setMessageDeleted } = require('../db/local');
    await setMessageDeleted(id);
    const list = get().byChat[chatId] ?? [];
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) =>
          m.id === id ? { ...m, deleted: true, body: '', mediaUri: null } : m
        ),
      },
    }));
  },

  async togglePin(chatId, id) {
    const { setMessagePinned } = require('../db/local');
    const list = get().byChat[chatId] ?? [];
    const msg = list.find((m) => m.id === id);
    if (!msg) return;
    const next = !msg.pinned;
    const prevPinned = list.find((m) => m.pinned && m.id !== id);
    if (prevPinned) await setMessagePinned(prevPinned.id, false);
    await setMessagePinned(id, next);
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) => {
          if (m.id === id) return { ...m, pinned: next };
          if (m.pinned && m.id !== id) return { ...m, pinned: false };
          return m;
        }),
      },
      pinnedMsg: {
        ...s.pinnedMsg,
        [chatId]: next ? { ...msg, pinned: true } : null,
      },
    }));
  },

  async clearChat(chatId) {
    await deleteContactMessages(chatId);
    await deleteChatState(chatId);
    // Also drop the Double Ratchet session so message numbering can't drift
    // out of sync with the peer after a one-sided history wipe. The next
    // outbound message will trigger a fresh X3DH + ratchet init.
    try {
      await deleteContactRatchetSession(chatId);
    } catch {
      // chatId may be a groupId (no ratchet row) — safe to ignore
    }
    set((s) => {
      const byChat = { ...s.byChat };
      const previews = { ...s.previews };
      const unreadCounts = { ...s.unreadCounts };
      const pinnedMsg = { ...s.pinnedMsg };
      const drafts = { ...s.drafts };
      delete byChat[chatId];
      delete previews[chatId];
      delete unreadCounts[chatId];
      delete pinnedMsg[chatId];
      delete drafts[chatId];
      return { byChat, previews, unreadCounts, pinnedMsg, drafts };
    });
  },
}));
