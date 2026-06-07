import { create } from 'zustand';
import { loadContacts, saveContact, getContact, deleteContact, deleteContactMessages, deleteContactRatchetSession, pinContact as dbPinContact, type StoredContact } from '../db/local';
import { lookupIdentity, ApiError } from '../api';

export type AddResult =
  | { kind: 'added'; contact: StoredContact }
  | { kind: 'already_exists'; contact: StoredContact }
  | { kind: 'mitm_detected'; oldKey: string; newKey: string; contact: StoredContact };

interface ContactsState {
  contacts: StoredContact[];
  loading: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  /** Resolve an Aegis ID against the directory server, then save locally. */
  addByAegisId: (aegisId: string, displayName?: string) => Promise<StoredContact>;
  /**
   * Add from a QR scan. The pubkey came in via the QR itself (out-of-band) so
   * we mark as verified by default. Server lookup is done in parallel to flag
   * mismatches (someone tampered with the directory).
   */
  addFromQR: (
    aegisId: string,
    publicKeyB64: string,
    displayName?: string
  ) => Promise<AddResult>;
  markVerified: (aegisId: string, verified: boolean) => Promise<void>;
  confirmKeyChange: (aegisId: string, newPublicKeyB64: string) => Promise<StoredContact | null>;
  get: (aegisId: string) => StoredContact | undefined;
  updateContactProfile: (aegisId: string, name: string, color?: string, avatarImage?: string | null, status?: string) => Promise<void>;
  muteContact: (aegisId: string, muted: boolean, mutedUntil?: number | null) => Promise<void>;
  setZeroTrust: (aegisId: string, enabled: boolean) => Promise<void>;
  setBlocked: (aegisId: string, blocked: boolean) => Promise<void>;
  archiveContact: (aegisId: string, archived: boolean) => Promise<void>;
  setChatHidden: (aegisId: string, hidden: boolean) => Promise<void>;
  pinContact: (aegisId: string, pinned: boolean) => Promise<void>;
  removeContact: (aegisId: string) => Promise<void>;
}

export const useContacts = create<ContactsState>((set, get) => ({
  contacts: [],
  loading: false,
  error: null,
  async hydrate() {
    set({ loading: true, error: null });
    try {
      const { usePreferences } = require('./preferences');
      if (usePreferences.getState().duressActive) {
        set({ contacts: [], loading: false });
        return;
      }
      const contacts = await loadContacts();
      set({ contacts, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  async addByAegisId(aegisId, displayName) {
    set({ error: null });
    const existing = await getContact(aegisId);
    if (existing) return existing;

    let record;
    try {
      record = await lookupIdentity(aegisId);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        throw new Error(`No identity found for ${aegisId}. Has your peer opened the app yet?`);
      }
      const raw = (e as Error).message ?? '';
      if (
        raw.toLowerCase().includes('network') ||
        raw.toLowerCase().includes('failed to fetch') ||
        raw.toLowerCase().includes('network request failed')
      ) {
        throw new Error('Could not connect to the server. Check your internet connection and try again.');
      }
      throw e;
    }

    const contact: StoredContact = {
      aegisId: record.aegisId,
      publicKeyB64: record.publicKey,
      signingPublicKeyB64: record.signingPublicKey || undefined,
      name: displayName?.trim() || aegisId,
      verified: false,
      addedAt: Date.now(),
      profile: 'personal',
    };
    await saveContact(contact);
    set({ contacts: [contact, ...get().contacts.filter((c) => c.aegisId !== aegisId)] });
    return contact;
  },

  async addFromQR(aegisId, publicKeyB64, displayName) {
    set({ error: null });
    const existing = await getContact(aegisId);

    // MITM check: if we already had this contact with a different key, surface
    // the mismatch WITHOUT saving — the caller must show a blocking confirm
    // dialog and call confirmKeyChange() if the user accepts.
    if (existing && existing.publicKeyB64 !== publicKeyB64) {
      return { kind: 'mitm_detected', oldKey: existing.publicKeyB64, newKey: publicKeyB64, contact: existing };
    }

    if (existing) {
      // Already known with same key — just upgrade to verified.
      if (!existing.verified) {
        const updated = { ...existing, verified: true };
        await saveContact(updated);
        set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
        return { kind: 'already_exists', contact: updated };
      }
      return { kind: 'already_exists', contact: existing };
    }

    // Brand-new contact from QR — verified by virtue of in-person scan.
    const contact: StoredContact = {
      aegisId,
      publicKeyB64,
      name: displayName?.trim() || aegisId,
      verified: true,
      addedAt: Date.now(),
      profile: 'personal',
    };
    await saveContact(contact);
    set({ contacts: [contact, ...get().contacts] });

    // Parallel MITM check against the directory: if the server publishes a
    // different key than what we scanned, the server (or someone with relay
    // access) is lying. Warn the user.
    void (async () => {
      try {
        const record = await lookupIdentity(aegisId);
        if (record.publicKey !== publicKeyB64) {
          if (__DEV__) console.warn('[contacts] directory MITM warning: server publishes a different key than the one scanned');
        }
      } catch {
        /* server unreachable is fine here */
      }
    })();

    return { kind: 'added', contact };
  },

  async confirmKeyChange(aegisId, newPublicKeyB64) {
    const existing = await getContact(aegisId);
    if (!existing) return null;
    const updated: StoredContact = { ...existing, publicKeyB64: newPublicKeyB64, verified: true, addedAt: Date.now() };
    await saveContact(updated);
    set({ contacts: [updated, ...get().contacts.filter((c) => c.aegisId !== aegisId)] });
    return updated;
  },

  async markVerified(aegisId, verified) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const updated = { ...existing, verified };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },
  get(aegisId) {
    const { usePreferences } = require('./preferences');
    if (usePreferences.getState().duressActive) return undefined;
    return get().contacts.find((c) => c.aegisId === aegisId);
  },

  async updateContactProfile(aegisId, name, color, avatarImage, status) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const updated = {
      ...existing,
      name: name?.trim() || existing.name,
      color: color || existing.color,
      avatarImage: avatarImage !== undefined ? avatarImage : existing.avatarImage,
      status: status !== undefined ? status : existing.status,
    };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async muteContact(aegisId, muted, mutedUntil) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const updated = { ...existing, muted, mutedUntil: muted ? (mutedUntil ?? null) : null };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async setBlocked(aegisId, blocked) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const updated = { ...existing, blocked };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async setZeroTrust(aegisId, enabled) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const updated = { ...existing, zeroTrust: enabled };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async archiveContact(aegisId, archived) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const updated = { ...existing, archived };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  // Hide/show a chat in the list WITHOUT deleting the contact. "Delete chat"
  // sets hidden=true (and clears messages); any new message un-hides it again
  // (see store/messages appendMsg).
  async setChatHidden(aegisId, hidden) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const updated = { ...existing, hidden };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async pinContact(aegisId, pinned) {
    await dbPinContact(aegisId, pinned);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? { ...c, pinned } : c)) });
  },

  async removeContact(aegisId) {
    await deleteContactMessages(aegisId);
    await deleteContactRatchetSession(aegisId);
    await deleteContact(aegisId);
    set({ contacts: get().contacts.filter((c) => c.aegisId !== aegisId) });
    // Clear in-memory chat state (byChat, previews, unreadCounts, drafts, pinnedMsg)
    // and the chat_state DB row (draft + unread count)
    const { useMessages } = require('./messages');
    await useMessages.getState().clearChat(aegisId);
  },
}));
