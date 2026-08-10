import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'

// Expose electron-toolkit helpers safely
contextBridge.exposeInMainWorld('electron', electronAPI)

// Expose AegisLink IPC surface — no raw ipcRenderer access in renderer
contextBridge.exposeInMainWorld('aegis', {
  secureStorage: {
    set: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('secureStorage:set', key, value),
    get: (key: string): Promise<string | null> =>
      ipcRenderer.invoke('secureStorage:get', key),
    delete: (key: string): Promise<void> =>
      ipcRenderer.invoke('secureStorage:delete', key),
    wipePrekeys: (): Promise<void> =>
      ipcRenderer.invoke('secureStorage:wipe-prekeys')
  },
  db: {
    // ── C-2 Fase 2: PIN-as-second-factor at-rest ──
    lockState: (): Promise<{ pinWrapped: boolean; opened: boolean }> =>
      ipcRenderer.invoke('db:lock-state'),
    unlock: (kekB64: string): Promise<void> =>
      ipcRenderer.invoke('db:unlock', kekB64),
    enablePinWrap: (kekB64: string): Promise<void> =>
      ipcRenderer.invoke('db:enable-pin-wrap', kekB64),
    disablePinWrap: (): Promise<void> =>
      ipcRenderer.invoke('db:disable-pin-wrap'),
    // ── Section 11: isolated profiles ──
    // Closes the current profile's database and opens the next one's. A different
    // FILE with a different key, so nothing can bleed across.
    switchSlot: (slot: string): Promise<void> =>
      ipcRenderer.invoke('db:switch-slot', slot),
    saveIdentity: (activeSlot: string, identity: any): Promise<void> =>
      ipcRenderer.invoke('db:save-identity', activeSlot, identity),
    loadIdentity: (activeSlot: string): Promise<any> =>
      ipcRenderer.invoke('db:load-identity', activeSlot),
    clearIdentity: (): Promise<void> =>
      ipcRenderer.invoke('db:clear-identity'),
    saveContact: (c: any): Promise<void> =>
      ipcRenderer.invoke('db:save-contact', c),
    loadContacts: (profile?: string): Promise<any[]> =>
      ipcRenderer.invoke('db:load-contacts', profile),
    getContact: (aegisId: string): Promise<any> =>
      ipcRenderer.invoke('db:get-contact', aegisId),
    deleteContactMessages: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('db:delete-contact-messages', chatId),
    deleteContactRatchetSession: (aegisId: string): Promise<void> =>
      ipcRenderer.invoke('db:delete-contact-ratchet-session', aegisId),
    deleteContact: (aegisId: string): Promise<void> =>
      ipcRenderer.invoke('db:delete-contact', aegisId),
    saveMessage: (activeSlot: string, m: any): Promise<void> =>
      ipcRenderer.invoke('db:save-message', activeSlot, m),
    updateMessageDelivery: (id: string, status: string): Promise<void> =>
      ipcRenderer.invoke('db:update-message-delivery', id, status),
    loadMessagesByChat: (activeSlot: string, chatId: string): Promise<any[]> =>
      ipcRenderer.invoke('db:load-messages-by-chat', activeSlot, chatId),
    getMessage: (activeSlot: string, id: string): Promise<any> =>
      ipcRenderer.invoke('db:get-message', activeSlot, id),
    setMessagePinned: (id: string, pinned: boolean): Promise<void> =>
      ipcRenderer.invoke('db:set-message-pinned', id, pinned),
    getPinnedMessage: (activeSlot: string, chatId: string): Promise<any> =>
      ipcRenderer.invoke('db:get-pinned-message', activeSlot, chatId),
    setMessageStarred: (id: string, starred: boolean): Promise<void> =>
      ipcRenderer.invoke('db:set-message-starred', id, starred),
    setMessageDeleted: (activeSlot: string, id: string): Promise<void> =>
      ipcRenderer.invoke('db:set-message-deleted', activeSlot, id),
    setRemoteMessageDeleted: (activeSlot: string, id: string, chatId: string): Promise<boolean> =>
      ipcRenderer.invoke('db:set-remote-message-deleted', activeSlot, id, chatId),
    setMessageReactions: (id: string, reactions: any): Promise<void> =>
      ipcRenderer.invoke('db:set-message-reactions', id, reactions),
    lastMessageByChat: (activeSlot: string, chatId: string): Promise<any> =>
      ipcRenderer.invoke('db:last-message-by-chat', activeSlot, chatId),
    saveRatchetSession: (activeSlot: string, aegisId: string, stateJson: string): Promise<void> =>
      ipcRenderer.invoke('db:save-ratchet-session', activeSlot, aegisId, stateJson),
    loadRatchetSession: (activeSlot: string, aegisId: string): Promise<string | null> =>
      ipcRenderer.invoke('db:load-ratchet-session', activeSlot, aegisId),
    saveGroup: (g: any): Promise<void> =>
      ipcRenderer.invoke('db:save-group', g),
    loadGroups: (): Promise<any[]> =>
      ipcRenderer.invoke('db:load-groups'),
    deleteGroup: (id: string): Promise<void> =>
      ipcRenderer.invoke('db:delete-group', id),
    getGroup: (id: string): Promise<any> =>
      ipcRenderer.invoke('db:get-group', id),
    wipeDatabase: (activeSlot: string): Promise<void> =>
      ipcRenderer.invoke('db:wipe-database', activeSlot),
    getChatState: (activeSlot: string, chatId: string): Promise<any> =>
      ipcRenderer.invoke('db:get-chat-state', activeSlot, chatId),
    setChatDraft: (activeSlot: string, chatId: string, draft: string | null): Promise<void> =>
      ipcRenderer.invoke('db:set-chat-draft', activeSlot, chatId, draft),
    incrementUnread: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('db:increment-unread', chatId),
    resetUnread: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('db:reset-unread', chatId),
    deleteChatState: (chatId: string): Promise<void> =>
      ipcRenderer.invoke('db:delete-chat-state', chatId),
    getAllUnreadCounts: (): Promise<Record<string, number>> =>
      ipcRenderer.invoke('db:get-all-unread-counts'),
    deleteExpiredMessages: (timerSeconds: number): Promise<void> =>
      ipcRenderer.invoke('db:delete-expired-messages', timerSeconds),
    saveCall: (c: any): Promise<void> =>
      ipcRenderer.invoke('db:save-call', c),
    getCallHistory: (contactId: string, limit: number): Promise<any[]> =>
      ipcRenderer.invoke('db:get-call-history', contactId, limit),

    // Public channels: local at-rest feed cache.
    saveChannelFeed: (activeSlot: string, channelId: string, postsJson: string): Promise<void> =>
      ipcRenderer.invoke('db:save-channel-feed', activeSlot, channelId, postsJson),
    loadChannelFeed: (activeSlot: string, channelId: string): Promise<string> =>
      ipcRenderer.invoke('db:load-channel-feed', activeSlot, channelId),
    deleteChannelFeed: (channelId: string): Promise<void> =>
      ipcRenderer.invoke('db:delete-channel-feed', channelId)
  },
  notifications: {
    show: (title: string, body: string): Promise<void> =>
      ipcRenderer.invoke('notifications:show', title, body)
  }
})
