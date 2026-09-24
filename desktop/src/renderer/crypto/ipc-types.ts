/**
 * Renderer-side IPC contract — mirrors the surface exposed by
 * desktop/src/preload/index.ts via contextBridge.exposeInMainWorld('aegis', ...).
 *
 * The renderer NEVER accesses Node APIs directly. Every persistent / OS
 * operation goes through these typed IPC channels.
 */

/** Envelope returned by the main process for every `sodium:*` call (see main/crypto/sodium/ops.ts). */
export type SodiumResult =
  | { ok: true; value: unknown }
  | { ok: false; errorName: 'TypeError' | 'Error'; message: string };

export interface SodiumBridge {
  /** Synchronous (ipcRenderer.sendSync): keys, ratchet frames, message bodies. */
  call(op: string, args: unknown[]): unknown;
  /** Asynchronous (invoke): whole attachments. */
  callAsync(op: string, args: unknown[]): Promise<unknown>;
}

export interface AegisIPC {
  /** F-1: native libsodium running in the main process. */
  sodium: SodiumBridge;
  secureStorage: {
    set(key: string, value: string): Promise<void>;
    get(key: string): Promise<string | null>;
    delete(key: string): Promise<void>;
    /** Panic-wipe: delete all prekey secrets (SPK/OPK/PQSPK) + secdiag counter. */
    wipePrekeys(): Promise<void>;
  };
  db: {
    /** C-2 Fase 2: whether the DB key is PIN-wrapped and whether it is open. */
    lockState(): Promise<{ pinWrapped: boolean; opened: boolean }>;
    /** Unlock a PIN-wrapped DB with the renderer-derived KEK; throws on wrong PIN. */
    unlock(kekB64: string): Promise<void>;
    /** Wrap the current DB key under the PIN-derived KEK (enable second factor). */
    enablePinWrap(kekB64: string): Promise<void>;
    /** Rewrap the DB key as DPAPI-only (disable the PIN second factor). */
    disablePinWrap(): Promise<void>;
    /**
     * Section 11: close the active profile's database and open `slot`'s.
     * One file per profile, each with its own key. Must be awaited before any
     * further db.* call: main refuses operations whose slot is not the open one.
     */
    switchSlot(slot: string): Promise<void>;
    /**
     * Delete a profile for good: its database file(s) and every `aegis.<slot>.*`
     * keystore entry (identity secrets, prefs, DB key). Refuses 'self' and the
     * open slot — switch away first.
     */
    deleteSlot(slot: string): Promise<void>;
    /** Public channels: persist a channel's projected feed, encrypted at rest. */
    saveChannelFeed(activeSlot: string, channelId: string, postsJson: string): Promise<void>;
    /** Returns the stored JSON, or "[]" when absent or undecryptable. */
    loadChannelFeed(activeSlot: string, channelId: string): Promise<string>;
    deleteChannelFeed(channelId: string): Promise<void>;
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
    searchMessages(activeSlot: string, query: string, limit?: number): Promise<any[]>;
    getMessage(activeSlot: string, id: string): Promise<any>;
    setMessagePinned(id: string, pinned: boolean): Promise<void>;
    getPinnedMessage(activeSlot: string, chatId: string): Promise<any>;
    setMessageStarred(id: string, starred: boolean): Promise<void>;
    setMessageDeleted(activeSlot: string, id: string): Promise<void>;
    setRemoteMessageDeleted(activeSlot: string, id: string, chatId: string): Promise<boolean>;
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
    show(title: string, body: string, opts?: { preview?: boolean; silent?: boolean; chatId?: string }): Promise<void>;
    setBadge(count: number): Promise<void>;
    isFocused(): Promise<boolean>;
    onOpenChat(cb: (chatId: string) => void): () => void;
  };
  window: {
    setContentProtection(enabled: boolean): Promise<boolean>;
  };
  tor: {
    status(): Promise<unknown>;
    onStatus(cb: (status: unknown) => void): () => void;
    sioConnect(id: string, url: string, authJson: string, eventsJson: string): Promise<boolean>;
    sioEmit(id: string, event: string, payloadJson: string, ackId: string | null): Promise<boolean>;
    sioDisconnect(id: string): Promise<boolean>;
    onSioEvent(cb: (msg: unknown) => void): () => void;
    /** Bridges (main/tor/bridges.ts): current mode, custom lines and live transport. */
    getConnection(): Promise<unknown>;
    /** Change mode; `customText` is the raw pasted bridge list (validated in main). */
    setConnection(mode: string, customText: string | null): Promise<unknown>;
  };
}

declare global {
  interface Window {
    aegis: AegisIPC;
  }
}

export {};
