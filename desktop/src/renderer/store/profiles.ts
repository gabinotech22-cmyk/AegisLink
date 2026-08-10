/**
 * ProfilesStore — Section 11: multiple isolated profiles (desktop).
 *
 * Port of mobile/src/store/profiles.ts. Same contract, same duress behaviour,
 * two deliberate differences forced by the Electron split:
 *
 *   1. Switching profile is a real async round-trip. On mobile setActiveDbSlot()
 *      just repoints a promise; here the main process has to close one encrypted
 *      SQLite file and open another, so switchDbSlot() is awaited.
 *   2. The renderer never mints the per-profile DB key. It lives in main's
 *      keystore, which mints it on first open and wraps it under the app-lock
 *      PIN if one is set. Handing that key to the renderer would put it on the
 *      IPC wire for no reason.
 *
 * SecureStore key: 'aegis.profiles.v1' -> JSON array of profile metadata. No
 * secrets: display name, colour, aegisId. Secrets stay in their per-slot keys.
 */

import { create } from 'zustand';
import { createIdentity, type Identity } from '../crypto/identity';
import { switchDbSlot, saveIdentity, deleteIdentitySlot } from '../db/local';

const secureStorage = () => window.aegis.secureStorage;

const PROFILES_STORE_KEY = 'aegis.profiles.v1';

export const AVATAR_PALETTE: string[] = [
  '#05b875', // Emerald (primary default)
  '#8b5cf6', // Purple
  '#3b82f6', // Blue
  '#ec4899', // Pink
  '#f97316', // Orange
  '#eab308', // Gold
  '#6366f1', // Indigo
  '#14b8a6', // Teal
];

export interface Profile {
  /** 'self' for the primary profile, the aegisId for every other. */
  slotId: string;
  aegisId: string;
  /** User-chosen label. Local only; never sent to the relay. */
  displayName: string;
  avatarColor: string;
  createdAt: number;
  isActive: boolean;
}

interface ProfilesState {
  profiles: Profile[];
  activeSlotId: string;
  hydrate: () => Promise<void>;
  createProfile: (
    displayName: string,
    avatarColor: string,
    presetIdentity?: Identity
  ) => Promise<Profile>;
  switchProfile: (slotId: string) => Promise<void>;
  removeProfile: (slotId: string) => Promise<void>;
  updateProfileMeta: (slotId: string, displayName: string, avatarColor: string) => Promise<void>;
}

async function persistProfiles(profiles: Profile[]): Promise<void> {
  // isActive is derived at runtime; persisting it would let the file disagree
  // with aegis.activeSlotId.
  const toStore = profiles.map(({ isActive: _ia, ...rest }) => rest);
  await secureStorage().set(PROFILES_STORE_KEY, JSON.stringify(toStore));
}

function attachActive(profiles: Profile[], activeSlotId: string): Profile[] {
  return profiles.map((p) => ({ ...p, isActive: p.slotId === activeSlotId }));
}

async function resetAllStores(): Promise<void> {
  // Dynamic import keeps this module free of import cycles.
  const { useContacts } = await import('./contacts');
  const { useGroups } = await import('./groups');
  const { useMessages } = await import('./messages');
  useContacts.setState({ contacts: [] });
  useGroups.setState({ groups: [] });
  useMessages.setState({ byChat: {}, previews: {}, unreadCounts: {} });
}

export const useProfiles = create<ProfilesState>((set, get) => ({
  profiles: [],
  activeSlotId: 'self',

  async hydrate() {
    // Duress containment. The real roster would reveal BOTH that several
    // isolated identities exist AND what they are called — precisely the
    // "there is a hidden real account" signal duress mode exists to suppress.
    // Serve a single profile mirroring the decoy identity instead, so every
    // consumer of this store is covered and not just the screens that remember
    // to check.
    {
      const { usePreferences } = await import('./preferences');
      if (usePreferences.getState().duressActive) {
        const { useIdentity } = await import('./identity');
        const idState = useIdentity.getState();
        set({
          profiles: attachActive(
            [
              {
                slotId: 'self',
                aegisId: idState.identity?.aegisId ?? '',
                displayName: idState.displayName,
                avatarColor: idState.avatarColor,
                createdAt: idState.identity?.createdAt ?? Date.now(),
                isActive: true,
              },
            ],
            'self'
          ),
          activeSlotId: 'self',
        });
        return;
      }
    }

    try {
      const raw = await secureStorage().get(PROFILES_STORE_KEY);
      const { useIdentity } = await import('./identity');
      const idState = useIdentity.getState();

      if (!raw) {
        // First boot after this feature ships: synthesise the primary profile
        // from the identity already on disk, so an existing install sees itself
        // in the list instead of an empty switcher.
        const primaryAegisId = idState.identity?.aegisId ?? '';
        const primaryProfile: Profile = {
          slotId: 'self',
          aegisId: primaryAegisId,
          displayName: idState.displayName || primaryAegisId.slice(0, 8).toLowerCase(),
          avatarColor: idState.avatarColor || AVATAR_PALETTE[0],
          createdAt: idState.identity?.createdAt ?? Date.now(),
          isActive: true,
        };
        const profiles = primaryAegisId ? [primaryProfile] : [];
        if (profiles.length > 0) await persistProfiles(profiles);
        set({ profiles: attachActive(profiles, 'self'), activeSlotId: 'self' });
        return;
      }

      const stored = JSON.parse(raw) as Omit<Profile, 'isActive'>[];
      const activeSlotId = idState.activeSlotId ?? 'self';
      set({ profiles: attachActive(stored as Profile[], activeSlotId), activeSlotId });
    } catch {
      // Non-fatal: without a roster the app still works on the primary slot.
      set({ profiles: [], activeSlotId: 'self' });
    }
  },

  async createProfile(displayName, avatarColor, presetIdentity) {
    // Use the identity the wizard already previewed, so the AegisID and
    // identicon the user just looked at are the ones that get persisted.
    const identity = presetIdentity ?? createIdentity();
    const slotId = identity.aegisId;
    const finalName = displayName || identity.aegisId.slice(0, 8).toLowerCase();
    const prevSlot = get().activeSlotId;

    // Per-slot secrets first: switching into a slot whose keys are missing would
    // leave the app on an identity it cannot sign with.
    await secureStorage().set(`aegis.${slotId}.secretKey.b64`, identity.secretKeyB64);
    await secureStorage().set(`aegis.${slotId}.signSecretKey.b64`, identity.signingSecretKeyB64);
    await secureStorage().set(`aegis.${slotId}.displayName`, finalName);
    await secureStorage().set(`aegis.${slotId}.avatarColor`, avatarColor);

    // Register the slot before its DB exists: this list is the ONLY way a panic
    // wipe or a factory reset can enumerate the profile's key material.
    try {
      const raw = await secureStorage().get('aegis.slotsList');
      const slotsList: string[] = raw ? (JSON.parse(raw) as string[]) : ['self'];
      if (!slotsList.includes(slotId)) {
        slotsList.push(slotId);
        await secureStorage().set('aegis.slotsList', JSON.stringify(slotsList));
      }
    } catch {
      /* non-fatal: the slot still works, and the next hydrate re-syncs */
    }

    // Open the new profile's database (main mints its key and schema), write the
    // identity row, then come back. Unlike mobile this is a real file open, so
    // failing here must not leave us pointed at the new slot.
    try {
      await switchDbSlot(slotId);
      await saveIdentity({
        aegisId: identity.aegisId,
        publicKeyB64: identity.publicKeyB64,
        secretKeyB64: identity.secretKeyB64,
        signingPublicKeyB64: identity.signingPublicKeyB64,
        signingSecretKeyB64: identity.signingSecretKeyB64,
        createdAt: identity.createdAt,
      });
    } finally {
      await switchDbSlot(prevSlot);
    }

    // Relay registration is deliberately NOT done here. It runs through the one
    // authoritative path (useIdentity.hydrate) when the caller switches into the
    // profile, which is what carries the PQXDH prekey, the persisted published
    // flag and the visible failure banner.
    const newProfile: Profile = {
      slotId,
      aegisId: identity.aegisId,
      displayName: finalName,
      avatarColor,
      createdAt: identity.createdAt,
      isActive: false,
    };
    const updated = [...get().profiles, newProfile];
    await persistProfiles(updated);
    set({ profiles: attachActive(updated, get().activeSlotId) });
    return newProfile;
  },

  async switchProfile(slotId) {
    if (slotId === get().activeSlotId) return;

    // Drop the socket before the identity underneath it changes.
    try {
      const { getSocket } = await import('../socket/client');
      getSocket()?.disconnect();
    } catch {
      /* socket not initialised */
    }

    // Move the database FIRST and await it. Main refuses any db call whose slot
    // is not the open one, so a store effect that races this fails loudly
    // instead of reading the profile the user just left.
    await switchDbSlot(slotId);
    await resetAllStores();
    await secureStorage().set('aegis.activeSlotId', slotId);

    set({ activeSlotId: slotId, profiles: attachActive(get().profiles, slotId) });

    const { useIdentity } = await import('./identity');
    useIdentity.setState({ activeSlotId: slotId });
    await useIdentity.getState().hydrate();

    const identity = useIdentity.getState().identity;
    if (identity) {
      try {
        const { connect } = await import('../socket/client');
        connect(identity);
      } catch {
        /* network unavailable */
      }
    }

    try {
      const { useContacts } = await import('./contacts');
      const { useGroups } = await import('./groups');
      await useContacts.getState().hydrate();
      await useGroups.getState().hydrate();
    } catch {
      /* non-fatal */
    }
  },

  async removeProfile(slotId) {
    const { profiles } = get();
    if (profiles.length <= 1) throw new Error('Cannot remove the last profile.');
    if (slotId === 'self') throw new Error('Cannot remove the primary profile.');

    if (slotId === get().activeSlotId) {
      await get().switchProfile('self');
    }

    await deleteIdentitySlot(slotId);

    // Drop it from slotsList too. A stale entry would make a later panic wipe
    // hunt for a profile that is already gone, and leaves the two views of
    // "which profiles exist" disagreeing.
    try {
      const raw = await secureStorage().get('aegis.slotsList');
      if (raw) {
        const slotsList = (JSON.parse(raw) as string[]).filter((s) => s !== slotId);
        await secureStorage().set('aegis.slotsList', JSON.stringify(slotsList));
      }
    } catch {
      /* non-fatal: the key material is already deleted */
    }

    const updated = profiles.filter((p) => p.slotId !== slotId);
    await persistProfiles(updated);
    set({ profiles: attachActive(updated, get().activeSlotId) });
  },

  async updateProfileMeta(slotId, displayName, avatarColor) {
    const updated = get().profiles.map((p) =>
      p.slotId === slotId ? { ...p, displayName, avatarColor } : p
    );
    await persistProfiles(updated);
    set({ profiles: attachActive(updated, get().activeSlotId) });

    if (slotId === get().activeSlotId) {
      const { useIdentity } = await import('./identity');
      await useIdentity.getState().updateProfile(displayName, avatarColor, null);
    }
  },
}));
