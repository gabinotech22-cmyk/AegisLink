import { create } from 'zustand';
import {
  loadContacts,
  saveContact,
  getContact,
  deleteContact,
  deleteContactMessages,
  deleteContactRatchetSession,
  type StoredContact,
} from '../db/local';
import { lookupIdentity, ApiError } from '../api';

const DEV = Boolean(import.meta.env?.DEV);

export type AddResult =
  | { kind: 'added'; contact: StoredContact }
  | { kind: 'already_exists'; contact: StoredContact }
  | { kind: 'mitm_detected'; oldKey: string; newKey: string; contact: StoredContact };

interface ContactsState {
  contacts: StoredContact[];
  loading: boolean;
  error: string | null;
  hydrate: () => Promise<void>;
  addByAegisId: (aegisId: string, displayName?: string) => Promise<StoredContact>;
  addFromQR: (
    aegisId: string,
    publicKeyB64: string,
    displayName?: string,
  ) => Promise<AddResult>;
  /**
   * Save a contact directly from data embedded in an incoming envelope.
   * Used as fallback when the identity-directory API is unreachable.
   * Sets verified=false; the contact's profile will be updated when their
   * first profile_update envelope is decrypted.
   */
  addFromEnvelope: (aegisId: string, publicKeyB64: string) => Promise<StoredContact>;
  markVerified: (aegisId: string, verified: boolean) => Promise<void>;
  confirmKeyChange: (aegisId: string, newPublicKeyB64: string) => Promise<StoredContact | null>;
  get: (aegisId: string) => StoredContact | undefined;
  updateContactProfile: (
    aegisId: string,
    name: string,
    color?: string,
    avatarImage?: string | null,
    status?: string,
  ) => Promise<void>;
  muteContact: (aegisId: string, muted: boolean, mutedUntil?: number | null) => Promise<void>;
  setZeroTrust: (aegisId: string, enabled: boolean) => Promise<void>;
  setBlocked: (aegisId: string, blocked: boolean) => Promise<void>;
  archiveContact: (aegisId: string, archived: boolean) => Promise<void>;
  removeContact: (aegisId: string) => Promise<void>;
}

export const useContacts = create<ContactsState>((set, get) => ({
  contacts: [],
  loading: false,
  error: null,

  async hydrate() {
    set({ loading: true, error: null });
    try {
      const { usePreferences } = await import('./preferences');
      if (usePreferences.getState().duressActive) {
        set({ contacts: [], loading: false });
        return;
      }
      const { useIdentity } = await import('./identity');
      const activeProfile = useIdentity.getState().activeProfile as 'personal' | 'work';
      const contacts = await loadContacts(activeProfile);
      set({ contacts, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  async addFromEnvelope(aegisId, publicKeyB64) {
    // Return existing contact if we already know them.
    const existing = await getContact(aegisId);
    if (existing) return existing;

    const { useIdentity } = await import('./identity');
    const profile = useIdentity.getState().activeProfile as 'personal' | 'work';
    const contact: StoredContact = {
      aegisId,
      publicKeyB64,
      name: aegisId, // will be replaced by senderName once profile_update decrypts
      verified: false,
      addedAt: Date.now(),
      profile,
    };
    await saveContact(contact);
    set({ contacts: [contact, ...get().contacts] });

    // Best-effort: enrich with signing key and proper display name from the
    // directory in the background (non-blocking).
    void lookupIdentity(aegisId)
      .then((record) => {
        if (!record.signingPublicKey) return;
        const enriched: StoredContact = {
          ...contact,
          signingPublicKeyB64: record.signingPublicKey,
        };
        void saveContact(enriched);
        set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? enriched : c)) });
      })
      .catch(() => { /* server unreachable — leave as-is, profile_update will enrich */ });

    return contact;
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
      throw e;
    }

    const { useIdentity } = await import('./identity');
    const profile = useIdentity.getState().activeProfile as 'personal' | 'work';
    const contact: StoredContact = {
      aegisId: record.aegisId,
      publicKeyB64: record.publicKey,
      signingPublicKeyB64: record.signingPublicKey || undefined,
      name: displayName?.trim() || aegisId,
      verified: false,
      addedAt: Date.now(),
      profile,
    };
    await saveContact(contact);
    set({ contacts: [contact, ...get().contacts.filter((c) => c.aegisId !== aegisId)] });
    return contact;
  },

  async addFromQR(aegisId, publicKeyB64, displayName) {
    set({ error: null });
    const existing = await getContact(aegisId);

    if (existing && existing.publicKeyB64 !== publicKeyB64) {
      return { kind: 'mitm_detected', oldKey: existing.publicKeyB64, newKey: publicKeyB64, contact: existing };
    }

    if (existing) {
      if (!existing.verified) {
        const updated = { ...existing, verified: true };
        await saveContact(updated);
        set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
        return { kind: 'already_exists', contact: updated };
      }
      return { kind: 'already_exists', contact: existing };
    }

    const { useIdentity } = await import('./identity');
    const profile = useIdentity.getState().activeProfile as 'personal' | 'work';
    const contact: StoredContact = {
      aegisId,
      publicKeyB64,
      name: displayName?.trim() || aegisId,
      verified: true,
      addedAt: Date.now(),
      profile,
    };
    await saveContact(contact);
    set({ contacts: [contact, ...get().contacts] });

    void (async () => {
      try {
        const record = await lookupIdentity(aegisId);
        if (record.publicKey !== publicKeyB64) {
          if (DEV) console.warn('[contacts] directory MITM warning: server publishes a different key than the one scanned');
        }
      } catch { /* server unreachable is fine here */ }
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

  async removeContact(aegisId) {
    await deleteContactMessages(aegisId);
    await deleteContactRatchetSession(aegisId);
    await deleteContact(aegisId);
    set({ contacts: get().contacts.filter((c) => c.aegisId !== aegisId) });
    const { useMessages } = await import('./messages');
    await useMessages.getState().clearChat(aegisId);
  },
}));
