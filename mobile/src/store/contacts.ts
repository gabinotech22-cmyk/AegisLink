import { create } from 'zustand';
import { logger } from '../utils/logger';
import { loadContacts, saveContact, getContact, deleteContact, deleteContactMessages, deleteContactRatchetSession, pinContact as dbPinContact, type StoredContact } from '../db/local';
import { lookupIdentity, ApiError } from '../api';
import { keyMatchesAegisId } from '../crypto/aegisId';

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
  addByAegisId: (aegisId: string, displayName?: string, opts?: { pending?: boolean }) => Promise<StoredContact>;
  /** Accept a pending message request — clears the pending flag. */
  acceptContact: (aegisId: string) => Promise<void>;
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

  async addByAegisId(aegisId, displayName, opts) {
    set({ error: null });
    const existing = await getContact(aegisId);
    if (existing) {
      // A user-initiated add (pending !== true) of a contact that is still a
      // pending message request implicitly accepts it — clear the flag.
      if (existing.pending && opts?.pending !== true) {
        const accepted = { ...existing, pending: false };
        await saveContact(accepted);
        set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? accepted : c)) });
        return accepted;
      }
      return existing;
    }

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

    // Trust boundary: the directory (relay) is untrusted. The Aegis ID is derived
    // from the X25519 public key, so the key the directory returns MUST derive
    // back to the ID we asked for. Reject otherwise — a malicious or buggy
    // directory must not be able to bind an arbitrary key to this ID. Strong
    // authentication still requires out-of-band fingerprint verification; the
    // contact stays verified:false until the 128-bit fingerprint is confirmed.
    if (!keyMatchesAegisId(record.publicKey, aegisId)) {
      throw new Error(
        `The directory returned a key that does not match ${aegisId}. Refusing to ` +
          `add this contact — ask them to share their QR code instead.`,
      );
    }

    const contact: StoredContact = {
      aegisId: record.aegisId,
      publicKeyB64: record.publicKey,
      signingPublicKeyB64: record.signingPublicKey || undefined,
      name: displayName?.trim() || aegisId,
      verified: false,
      addedAt: Date.now(),
      profile: 'personal',
      pending: opts?.pending === true,
    };
    await saveContact(contact);
    set({ contacts: [contact, ...get().contacts.filter((c) => c.aegisId !== aegisId)] });
    return contact;
  },

  async acceptContact(aegisId) {
    const existing = await getContact(aegisId);
    if (!existing || !existing.pending) return;
    const updated = { ...existing, pending: false };
    await saveContact(updated);
    set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? updated : c)) });
  },

  async addFromQR(aegisId, publicKeyB64, displayName) {
    set({ error: null });

    // Defense in depth: parseIdentityQR already binds ID↔key, but addFromQR is a
    // public store action that stores contacts as verified:true (the strong,
    // out-of-band path). Never persist a contact whose ID does not derive from
    // its key, even if a caller reaches this without going through the parser.
    if (!keyMatchesAegisId(publicKeyB64, aegisId)) {
      throw new Error('Invalid contact: the Aegis ID does not match its key.');
    }

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
    // access) is lying. Warn the user. Also backfill the Ed25519 signing key:
    // the QR/link carries only the box (X25519) key, but verifying admin-signed
    // group metadata (so a link-joined group actually materializes) needs the
    // signing key, which lives only in the directory.
    void (async () => {
      try {
        const record = await lookupIdentity(aegisId);
        if (record.publicKey !== publicKeyB64) {
          if (__DEV__) logger.warn('[contacts] directory MITM warning: server publishes a different key than the one scanned');
        }
        const fetchedSigning =
          typeof record.signingPublicKey === 'string' && record.signingPublicKey.length > 0
            ? record.signingPublicKey
            : null;
        if (fetchedSigning) {
          const cur = await getContact(aegisId);
          if (cur && !cur.signingPublicKeyB64) {
            const withSigning = { ...cur, signingPublicKeyB64: fetchedSigning };
            await saveContact(withSigning);
            set({ contacts: get().contacts.map((c) => (c.aegisId === aegisId ? withSigning : c)) });
          }
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
