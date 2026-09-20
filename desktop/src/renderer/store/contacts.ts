import { logger } from '../utils/logger';
import { sameCaps } from '../net/caps';
import { canonicalRelay } from '../net/officialRelay';
import { getHomeRelay } from '../net/homeRelay';
import type { RelayRef } from '../net/relayRef';
import { create } from 'zustand';
import {
  loadContacts,
  saveContact,
  getContact,
  deleteContact,
  deleteContactMessages,
  deleteContactRatchetSession,
  effectiveContactName,
  type StoredContact,
} from '../db/local';
import { lookupIdentity, ApiError } from '../api';
import { setContactMailboxRoot } from '../crypto/mailboxStore';

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
    /** Relay named by a v2 link; null/undefined = official (federation F1). */
    relay?: RelayRef | null,
    /** Mailbox root carried by a v2 link (F3b): the queue a first message is written to. */
    mailboxRootB64?: string | null,
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
  /** Local nickname for a contact (null/empty clears it). Wins over the announced name; never sent. */
  setNickname: (aegisId: string, nickname: string | null) => Promise<void>;
  /** F5b: the contact announced a new home relay (`profile_update.mailboxRelay`); null = official. */
  updateContactRelay: (aegisId: string, relayOnion: string | null) => Promise<void>;
  /** Pin the caps a contact announced (net/caps.ts); no-op when unchanged. */
  updateContactCaps: (aegisId: string, caps: string[]) => Promise<void>;
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
      const contacts = await loadContacts('personal');
      set({ contacts, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  async addFromEnvelope(aegisId, publicKeyB64) {
    // Return existing contact if we already know them.
    const existing = await getContact(aegisId);
    if (existing) return existing;

    const contact: StoredContact = {
      aegisId,
      publicKeyB64,
      name: aegisId, // will be replaced by senderName once profile_update decrypts
      verified: false,
      addedAt: Date.now(),
      profile: 'personal',
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

    const contact: StoredContact = {
      aegisId: record.aegisId,
      publicKeyB64: record.publicKey,
      signingPublicKeyB64: record.signingPublicKey || undefined,
      // What the user typed in "nickname" is a local label, not the contact's
      // profile name — its own slot, so their first profile_update cannot
      // overwrite it (parity with mobile).
      name: displayName?.trim() || aegisId,
      profileName: aegisId,
      nickname: displayName?.trim() || null,
      verified: false,
      addedAt: Date.now(),
      profile: 'personal',
      // Resolved on OUR home relay → that is where they live (parity with mobile).
      relayOnion: canonicalRelay(getHomeRelay())?.onion ?? null,
    };
    await saveContact(contact);
    set({ contacts: [contact, ...get().contacts.filter((c) => c.aegisId !== aegisId)] });
    return contact;
  },

  async addFromQR(aegisId, publicKeyB64, displayName, relay, mailboxRootB64) {
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

    const contact: StoredContact = {
      aegisId,
      publicKeyB64,
      name: displayName?.trim() || aegisId,
      profileName: aegisId,
      nickname: displayName?.trim() || null,
      verified: true,
      addedAt: Date.now(),
      profile: 'personal',
      relayOnion: canonicalRelay(relay)?.onion ?? null,
    };
    await saveContact(contact);
    // F3b: a v2 link carries the owner's mailbox root — without it there is no
    // queue on their relay to write the very first message to.
    if (mailboxRootB64) await setContactMailboxRoot(aegisId, mailboxRootB64);
    set({ contacts: [contact, ...get().contacts] });

    void (async () => {
      try {
        const record = await lookupIdentity(aegisId);
        if (record.publicKey !== publicKeyB64) {
          if (DEV) logger.warn('[contacts] directory MITM warning: server publishes a different key than the one scanned');
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

  async updateContactRelay(aegisId, relayOnion) {
    const existing = get().contacts.find((c) => c.aegisId === aegisId);
    if (!existing || (existing.relayOnion ?? null) === relayOnion) return;
    const updated: StoredContact = { ...existing, relayOnion };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async updateContactCaps(aegisId, caps) {
    const existing = get().contacts.find((c) => c.aegisId === aegisId);
    if (!existing || sameCaps(existing.caps, caps)) return;
    const updated: StoredContact = { ...existing, caps };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async updateContactProfile(aegisId, name, color, avatarImage, status) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const profileName = name?.trim() || existing.profileName || existing.name;
    const updated: StoredContact = {
      ...existing,
      profileName,
      // The announced name never displaces a local nickname.
      name: effectiveContactName({ aegisId, nickname: existing.nickname, profileName }),
      color: color || existing.color,
      avatarImage: avatarImage !== undefined ? avatarImage : existing.avatarImage,
      status: status !== undefined ? status : existing.status,
    };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async setNickname(aegisId, nickname) {
    const existing = await getContact(aegisId);
    if (!existing) return;
    const trimmed = nickname?.trim() || null;
    const updated: StoredContact = {
      ...existing,
      nickname: trimmed,
      name: effectiveContactName({ aegisId, nickname: trimmed, profileName: existing.profileName ?? existing.name }),
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
