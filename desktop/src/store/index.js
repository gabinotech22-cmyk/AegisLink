import { create } from 'zustand';

export const useStore = create((set, get) => ({
  // Identity
  identity: null,
  setIdentity: (id) => set({ identity: id }),

  // Contacts
  contacts: [],
  addContact: (c) =>
    set((s) => ({
      contacts: [...s.contacts.filter((x) => x.aegisId !== c.aegisId), c],
      auditLog: [
        { sev: 'info', msg: `Contact added · ${c.name || c.aegisId}`, ts: Date.now() },
        ...s.auditLog,
      ].slice(0, 100),
    })),

  updateContact: (aegisId, data) =>
    set((s) => ({
      contacts: s.contacts.map((c) =>
        c.aegisId === aegisId ? { ...c, ...data } : c,
      ),
    })),

  // Conversations index by aegisId of contact
  conversations: {},
  updateConversation: (aegisId, data) =>
    set((s) => ({
      conversations: {
        ...s.conversations,
        [aegisId]: { ...s.conversations[aegisId], ...data },
      },
    })),

  // Messages index by aegisId of contact
  messages: {},
  appendMessage: (aegisId, msg) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [aegisId]: [...(s.messages[aegisId] ?? []), msg],
      },
    })),
  setMessages: (aegisId, msgs) =>
    set((s) => ({
      messages: { ...s.messages, [aegisId]: msgs },
    })),
  updateMessage: (aegisId, msgId, data) =>
    set((s) => {
      const msgs = s.messages[aegisId] ?? [];
      const idx = msgs.findIndex((m) => m.id === msgId);
      if (idx === -1) return {};
      const updated = [...msgs];
      updated[idx] = { ...updated[idx], ...data };
      return { messages: { ...s.messages, [aegisId]: updated } };
    }),
  removeMessage: (aegisId, msgId) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [aegisId]: (s.messages[aegisId] ?? []).filter((m) => m.id !== msgId),
      },
    })),

  // Socket connection
  connected: false,
  setConnected: (v) => set({ connected: v }),

  // Active chat
  activeChat: null,
  setActiveChat: (id) => set({ activeChat: id }),

  // Profile
  displayName: '',
  avatarColor: '#00ff88',
  profileEmoji: null,
  setDisplayName: (n) => set({ displayName: n }),
  setAvatarColor: (c) => set({ avatarColor: c }),
  setProfileEmoji: (e) => set({ profileEmoji: e }),

  // Active profile
  activeProfile: 'personal',
  workDisplayName: '',
  workAvatarColor: '#8b5cf6',
  setActiveProfile: (p) => set({ activeProfile: p }),
  setWorkDisplayName: (n) => set({ workDisplayName: n }),
  setWorkAvatarColor: (c) => set({ workAvatarColor: c }),

  // Remove contact
  removeContact: (aegisId) =>
    set((s) => ({ contacts: s.contacts.filter((c) => c.aegisId !== aegisId) })),

  // Audit log (Work dashboard)
  auditLog: [],
  addAuditEntry: (entry) =>
    set((s) => ({
      auditLog: [{ ...entry, ts: Date.now() }, ...s.auditLog].slice(0, 100),
    })),

  // Groups
  groups: [],
  groupMessages: {},
  typing: {},
  polls: {},
  calls: {
    status: null,
    peerId: null,
    callId: null,
    media: null,
    offerSdp: null,
  },
  pinnedMsg: {},
  drafts: {},
  unreadCounts: {},

  setTyping: (aegisId, bool) => {
    set((s) => ({ typing: { ...s.typing, [aegisId]: bool } }));
    if (bool) {
      setTimeout(() => {
        set((s) => ({ typing: { ...s.typing, [aegisId]: false } }));
      }, 5000);
    }
  },
  receiveGroupMessage: (groupId, msg) =>
    set((s) => ({
      groupMessages: {
        ...s.groupMessages,
        [groupId]: [...(s.groupMessages[groupId] ?? []), msg],
      },
    })),
  receivePollVote: (messageId, optionIndex) =>
    set((s) => {
      const poll = s.polls[messageId];
      if (!poll) return {};
      const votes = { ...poll.votes, [optionIndex]: (poll.votes[optionIndex] ?? 0) + 1 };
      return { polls: { ...s.polls, [messageId]: { ...poll, votes } } };
    }),
  setPinnedMsg: (chatId, msg) =>
    set((s) => ({ pinnedMsg: { ...s.pinnedMsg, [chatId]: msg } })),
  saveDraft: (chatId, text) =>
    set((s) => ({ drafts: { ...s.drafts, [chatId]: text } })),
  markChatRead: (chatId) =>
    set((s) => ({ unreadCounts: { ...s.unreadCounts, [chatId]: 0 } })),
  setCallState: (patch) =>
    set((s) => ({ calls: { ...s.calls, ...patch } })),

  // Settings (in-memory mirror of DB settings table)
  settings: {
    read_receipts_enabled: true,
    ephemeral_default_seconds: null,
    notifications_enabled: true,
    sound_enabled: true,
    theme: 'dark',
  },
  setSetting: (key, value) =>
    set((s) => ({
      settings: { ...s.settings, [key]: value },
    })),
}));
