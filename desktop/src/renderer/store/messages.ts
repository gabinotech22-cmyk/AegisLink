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
  setMessageStarred,
  setMessageDeleted,
  setRemoteMessageDeleted,
  setMessageReactions,
  setMessagePinned,
  updateMessageDelivery,
  type StoredMessage,
} from '../db/local';

interface MessagesState {
  byChat: Record<string, StoredMessage[]>;
  previews: Record<string, StoredMessage>;
  pinnedMsg: Record<string, StoredMessage | null>;
  ephemeralTimer: number;
  pendingMediaUri: string | null;
  unreadCounts: Record<string, number>;
  drafts: Record<string, string>;

  loadChat: (chatId: string) => Promise<StoredMessage[]>;
  append: (m: StoredMessage) => Promise<void>;
  refreshPreview: (chatId: string) => Promise<void>;
  loadAllPreviews: (chatIds: string[]) => Promise<void>;
  setEphemeralTimer: (seconds: number) => void;
  pruneExpired: () => void;
  setPendingMedia: (uri: string | null) => void;
  markRead: (chatId: string) => Promise<void>;
  saveDraft: (chatId: string, text: string) => Promise<void>;
  loadAllUnreads: () => Promise<void>;
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
    const { usePreferences } = await import('./preferences');
    if (usePreferences.getState().duressActive) return [];

    const cached = get().byChat[chatId];
    if (cached) return cached;
    let list = await loadMessagesByChat(chatId);

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

  // Bulk-load the last message for every chat so the sidebar shows previews at
  // boot — without this, previews only populate as a side effect of opening a
  // chat or receiving a live message ("No messages yet" everywhere on launch).
  // Mirrors loadAllUnreads(); honours duress mode like loadChat().
  async loadAllPreviews(chatIds) {
    const { usePreferences } = await import('./preferences');
    if (usePreferences.getState().duressActive) return;
    const entries = await Promise.all(
      chatIds.map(async (id) => [id, await lastMessageByChat(id)] as const),
    );
    set((s) => {
      const previews = { ...s.previews };
      for (const [id, last] of entries) if (last) previews[id] = last;
      return { previews };
    });
  },

  async markRead(chatId) {
    await resetUnread(chatId);
    set((s) => ({ unreadCounts: { ...s.unreadCounts, [chatId]: 0 } }));
  },

  async saveDraft(chatId, text) {
    const trimmed = text.trim();
    await setChatDraft(chatId, trimmed || null);
    set((s) => ({
      drafts: trimmed
        ? { ...s.drafts, [chatId]: trimmed }
        : (() => {
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
    deleteExpiredMessages(timer).catch(() => {});
  },

  async toggleStar(chatId, id) {
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
    await setMessageDeleted(id);
    const list = get().byChat[chatId] ?? [];
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) => (m.id === id ? { ...m, deleted: true, body: '', mediaUri: null } : m)),
      },
    }));
  },

  async toggleReaction(chatId, id, emoji, aegisId) {
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
    // Authorization-scoped: a peer may only retract a message they sent to us
    // in our chat with them. If nothing matched, do NOT touch in-memory state.
    const deleted = await setRemoteMessageDeleted(id, chatId);
    if (!deleted) return;
    const list = get().byChat[chatId] ?? [];
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) => (m.id === id ? { ...m, deleted: true, body: '', mediaUri: null } : m)),
      },
    }));
  },

  async togglePin(chatId, id) {
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
