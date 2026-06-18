/**
 * Renderer-side IPC contract — mirrors the surface exposed by
 * desktop/src/preload/index.ts via contextBridge.exposeInMainWorld('aegis', ...).
 *
 * The renderer NEVER accesses Node APIs directly. Every persistent / OS
 * operation goes through these typed IPC channels.
 */

export interface AegisIPC {
  secureStorage: {
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<void>;
    /** Panic-wipe: delete all prekey secrets (SPK/OPK/PQSPK) + secdiag counter. */
    wipePrekeys(): Promise<void>;
  };
  db: {
    saveIdentity(activeSlot: string, identity: unknown): Promise<void>;
    loadIdentity(activeSlot: string): Promise<any>;
    clearIdentity(): Promise<void>;
    saveContact(c: unknown): Promise<void>;
    loadContacts(profile?: string): Promise<any[]>;
    getContact(aegisId: string): Promise<any>;
    deleteContactMessages(chatId: string): Promise<void>;
    deleteContactRatchetSession(aegisId: string): Promise<void>;
    deleteContact(aegisId: string): Promise<void>;
    saveMessage(activeSlot: string, m: unknown): Promise<void>;
    updateMessageDelivery(id: string, status: string): Promise<void>;
    loadMessagesByChat(activeSlot: string, chatId: string): Promise<any[]>;
    getMessage(activeSlot: string, id: string): Promise<any>;
    setMessagePinned(id: string, pinned: boolean): Promise<void>;
    getPinnedMessage(activeSlot: string, chatId: string): Promise<any>;
    setMessageStarred(id: string, starred: boolean): Promise<void>;
    setMessageDeleted(activeSlot: string, id: string): Promise<void>;
    setMessageReactions(id: string, reactions: unknown): Promise<void>;
    lastMessageByChat(activeSlot: string, chatId: string): Promise<any>;
    saveRatchetSession(
      activeSlot: string,
      aegisId: string,
      stateJson: string
    ): Promise<void>;
    loadRatchetSession(
      activeSlot: string,
      aegisId: string
    ): Promise<string | null>;
    saveGroup(g: unknown): Promise<void>;
    loadGroups(): Promise<any[]>;
    deleteGroup(id: string): Promise<void>;
    getGroup(id: string): Promise<any>;
    wipeDatabase(activeSlot: string): Promise<void>;
    getChatState(activeSlot: string, chatId: string): Promise<any>;
    setChatDraft(
      activeSlot: string,
      chatId: string,
      draft: string | null
    ): Promise<void>;
    incrementUnread(chatId: string): Promise<void>;
    resetUnread(chatId: string): Promise<void>;
    deleteChatState(chatId: string): Promise<void>;
    getAllUnreadCounts(): Promise<Record<string, number>>;
    deleteExpiredMessages(timerSeconds: number): Promise<void>;
    saveCall(c: unknown): Promise<void>;
    getCallHistory(contactId: string, limit: number): Promise<any[]>;
  };
  notifications: {
    show(title: string, body: string): Promise<void>;
  };
}

declare global {
  interface Window {
    aegis: AegisIPC;
  }
}

export {};
