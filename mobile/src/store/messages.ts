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
  setChatEphemeralTimer,
  getAllChatEphemeralTimers,
  type StoredMessage,
  type Attachment,
} from '../db/local';

interface MessagesState {
  byChat: Record<string, StoredMessage[]>;
  previews: Record<string, StoredMessage>;
  pinnedMsg: Record<string, StoredMessage | null>;
  /** @deprecated Use ephemeralTimers[chatId] instead. Kept for backward compatibility. */
  ephemeralTimer: number;
  /** Per-chat ephemeral timer in seconds (0 = off). Persisted in SQLite. */
  ephemeralTimers: Record<string, number>;
  pendingMediaUri: string | null;
  /** A trimmed video URI staged by the media editor, to be sent by the chat screen. */
  pendingVideoUri: string | null;
  /** Unread incoming message count per chatId */
  unreadCounts: Record<string, number>;
  /** Saved draft text per chatId */
  drafts: Record<string, string>;

  loadChat: (chatId: string) => Promise<StoredMessage[]>;
  append: (m: StoredMessage) => Promise<void>;
  refreshPreview: (chatId: string) => Promise<void>;
  /** @deprecated Use setEphemeralTimer(chatId, seconds) instead. */
  setEphemeralTimer: (seconds: number) => void;
  /** Set per-chat ephemeral timer. Persisted in SQLite. */
  setChatEphemeralTimer: (chatId: string, seconds: number) => Promise<void>;
  /** Read per-chat ephemeral timer. Returns 0 if not set. */
  getEphemeralTimer: (chatId: string) => number;
  /** Load all per-chat timers from SQLite (call at app startup). */
  loadAllEphemeralTimers: () => Promise<void>;
  pruneExpired: () => void;
  setPendingMedia: (uri: string | null) => void;
  setPendingVideo: (uri: string | null) => void;
  markRead: (chatId: string) => Promise<void>;
  saveDraft: (chatId: string, text: string) => Promise<void>;
  loadAllUnreads: () => Promise<void>;
  // Message actions
  toggleStar: (chatId: string, id: string) => Promise<void>;
  softDelete: (chatId: string, id: string) => Promise<void>;
  toggleReaction: (chatId: string, id: string, emoji: string, aegisId?: string) => Promise<void>;
  updateDelivery: (chatId: string, id: string, status: 'sent' | 'delivered' | 'read') => Promise<void>;
  /** Replace a message's media reference in place (e.g. local URI → persistent blob ref after upload). */
  setMediaUri: (chatId: string, id: string, mediaUri: string) => Promise<void>;
  /** Replace a message's attachments array in place (local URIs → blob refs after upload). */
  setAttachments: (chatId: string, id: string, attachments: Attachment[]) => Promise<void>;
  remoteDelete: (chatId: string, id: string) => Promise<void>;
  togglePin: (chatId: string, id: string) => Promise<void>;
  clearChat: (chatId: string) => Promise<void>;
}

export const useMessages = create<MessagesState>((set, get) => ({
  byChat: {},
  previews: {},
  pinnedMsg: {},
  ephemeralTimer: 0,
  ephemeralTimers: {},
  pendingMediaUri: null,
  pendingVideoUri: null,
  unreadCounts: {},
  drafts: {},

  setPendingMedia(uri) {
    set({ pendingMediaUri: uri });
  },

  setPendingVideo(uri) {
    set({ pendingVideoUri: uri });
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
    // A message that arrives while its own chat screen is focused has already
    // been seen — it must NOT bump the unread badge. We key off the same active
    // chat id the push-banner / in-app-sound guards use. When this chat is
    // active we also clear any residual persisted count so the badge stays at 0.
    let isActiveChat = false;
    if (m.direction === 'in') {
      try {
        const { getActiveChatNotificationId } = require('../notifications/push') as typeof import('../notifications/push');
        isActiveChat = getActiveChatNotificationId() === m.chatId;
      } catch { /* push module unavailable (e.g. tests) — fall through to counting */ }
    }
    if (isActiveChat) resetUnread(m.chatId).catch(() => {});
    set((s) => {
      const existing = s.byChat[m.chatId] ?? [];
      const next: Partial<MessagesState> = {
        byChat: { ...s.byChat, [m.chatId]: [...existing, m] },
        previews: { ...s.previews, [m.chatId]: m },
      };
      if (m.direction === 'in' && !isActiveChat) {
        next.unreadCounts = { ...s.unreadCounts, [m.chatId]: (s.unreadCounts[m.chatId] ?? 0) + 1 };
        incrementUnread(m.chatId).catch(() => {});
      } else if (m.direction === 'in') {
        // Active chat: keep the in-memory badge pinned at 0.
        next.unreadCounts = { ...s.unreadCounts, [m.chatId]: 0 };
      }
      return next;
    });
    // A new message (sent or received) un-hides a chat that was "deleted" from
    // the list, so it reappears — without ever having removed the contact.
    try {
      const { useContacts } = require('./contacts');
      const contact = useContacts.getState().contacts.find((c: { aegisId: string; hidden?: boolean }) => c.aegisId === m.chatId);
      if (contact?.hidden) void useContacts.getState().setChatHidden(m.chatId, false);
    } catch { /* ignore */ }
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
    // Deprecated global setter — kept for backward compat. Does not persist.
    set({ ephemeralTimer: seconds });
  },

  async setChatEphemeralTimer(chatId, seconds) {
    await setChatEphemeralTimer(chatId, seconds);
    set((s) => ({
      ephemeralTimers: { ...s.ephemeralTimers, [chatId]: seconds },
    }));
  },

  getEphemeralTimer(chatId) {
    return get().ephemeralTimers[chatId] ?? 0;
  },

  async loadAllEphemeralTimers() {
    const timers = await getAllChatEphemeralTimers();
    set((s) => ({ ephemeralTimers: { ...s.ephemeralTimers, ...timers } }));
  },

  pruneExpired() {
    const now = Date.now();
    const updatedByChat = { ...get().byChat };
    let changed = false;

    for (const [chatId, list] of Object.entries(updatedByChat)) {
      // Only prune messages that have an explicit expiresAt — never retroactively
      // delete messages without one based on the global timer.
      const filtered = list.filter((m) => {
        if (m.expiresAt != null && now >= m.expiresAt) return false;
        return true;
      });
      if (filtered.length !== list.length) {
        updatedByChat[chatId] = filtered;
        changed = true;
      }
    }

    if (changed) set({ byChat: updatedByChat });
    deleteExpiredMessages().catch(() => {});
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

  async setMediaUri(chatId, id, mediaUri) {
    const { updateMessageMediaUri } = require('../db/local');
    await updateMessageMediaUri(id, mediaUri);
    const list = get().byChat[chatId] ?? [];
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) => (m.id === id ? { ...m, mediaUri } : m)),
      },
    }));
  },

  async setAttachments(chatId, id, attachments) {
    const { updateMessageAttachments } = require('../db/local');
    await updateMessageAttachments(id, attachments);
    const list = get().byChat[chatId] ?? [];
    set((s) => ({
      byChat: {
        ...s.byChat,
        [chatId]: list.map((m) => (m.id === id ? { ...m, attachments } : m)),
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
