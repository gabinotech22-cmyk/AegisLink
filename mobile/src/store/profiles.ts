/**
 * ProfilesStore — Section 11: Multiple Isolated Profiles
 *
 * This store is the single source of truth for the list of profiles and which
 * one is active.  Cryptographic operations (key generation, DB isolation, slot
 * switching) are delegated to `useIdentity` and `db/local`, which already
 * implement them correctly.  This layer adds only:
 *   - A human-readable profile list (displayName, avatarColor) stored as
 *     JSON in SecureStore (no secrets — strictly metadata).
 *   - Coordinated switchProfile / removeProfile that flush all Zustand stores.
 *
 * SecureStore key: 'aegis.profiles.v1'  →  JSON array of ProfileMeta
 * Secrets stay in their per-slot SecureStore slots (crypto/types.ts).
 */

import { create } from 'zustand';
import { ss } from '../utils/secureStore';
import { createIdentity, type Identity } from '../crypto/identity';
import {
  secretKeySlot,
  signSecretKeySlot,
  dbEncKeySlot,
} from '../crypto/types';
import {
  setActiveDbSlot,
  closeActiveDatabase,
  resetDbConnection,
  saveIdentity,
  deleteIdentitySlot,
} from '../db/local';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';

// ─── Constants ───────────────────────────────────────────────────────────────

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

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Profile {
  /** 'self' for primary, aegisId for extras. */
  slotId: string;
  /** Full AegisID string e.g. 'ABC-DEF1-GH23'. */
  aegisId: string;
  /** User-chosen label; stored locally only, never sent to the relay. */
  displayName: string;
  /** One of AVATAR_PALETTE. */
  avatarColor: string;
  createdAt: number;
  isActive: boolean;
}

interface ProfilesState {
  profiles: Profile[];
  activeSlotId: string;

  /** Loads profile list from SecureStore on cold-start. */
  hydrate: () => Promise<void>;
  /**
   * Add a profile to the list. Pass the identity already generated/previewed by
   * the wizard so the AegisID + identicon the user saw is the one persisted;
   * omit it to mint a fresh identity here.
   */
  createProfile: (displayName: string, avatarColor: string, presetIdentity?: Identity) => Promise<Profile>;
  /** Switch active profile: flushes all in-memory state, opens new DB. */
  switchProfile: (slotId: string) => Promise<void>;
  /** Wipe a profile's keys + SQLite DB. Cannot remove the last profile. */
  removeProfile: (slotId: string) => Promise<void>;
  /** Update metadata (displayName/avatarColor) for an existing profile. */
  updateProfileMeta: (slotId: string, displayName: string, avatarColor: string) => Promise<void>;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function persistProfiles(profiles: Profile[]): Promise<void> {
  // Strip isActive before persisting — it's derived at runtime.
  const toStore = profiles.map(({ isActive: _ia, ...rest }) => rest);
  await ss.set(PROFILES_STORE_KEY, JSON.stringify(toStore));
}

function attachActive(profiles: Profile[], activeSlotId: string): Profile[] {
  return profiles.map((p) => ({ ...p, isActive: p.slotId === activeSlotId }));
}

function resetAllStores(): void {
  // Lazy-require so this module can be imported without circular dependencies.
  const { useContacts } = require('./contacts') as typeof import('./contacts');
  const { useGroups } = require('./groups') as typeof import('./groups');
  const { useMessages } = require('./messages') as typeof import('./messages');
  useContacts.setState({ contacts: [], loading: false, error: null });
  useGroups.setState({ groups: [] });
  useMessages.setState({
    byChat: {},
    previews: {},
    pinnedMsg: {},
    unreadCounts: {},
    drafts: {},
    pendingMediaUri: null,
  });
}

// ─── Store ───────────────────────────────────────────────────────────────────

export const useProfiles = create<ProfilesState>((set, get) => ({
  profiles: [],
  activeSlotId: 'self',

  async hydrate() {
    // Duress containment: the REAL profiles list would reveal both that
    // multiple isolated identities exist AND their display names — the exact
    // "there is a hidden real account" signal duress mode must never emit.
    // Serve a single self profile mirroring the DECOY identity instead
    // (Profile.tsx already hides the switcher under duress; this covers every
    // other consumer of useProfiles too).
    {
      const { usePreferences } = require('./preferences') as typeof import('./preferences');
      if (usePreferences.getState().duressActive) {
        const { useIdentity } = require('./identity') as typeof import('./identity');
        const idState = useIdentity.getState();
        set({
          profiles: attachActive(
            [{
              slotId: 'self',
              aegisId: idState.identity?.aegisId ?? '',
              displayName: idState.displayName,
              avatarColor: idState.avatarColor,
              createdAt: idState.identity?.createdAt ?? Date.now(),
              isActive: true,
            }],
            'self',
          ),
          activeSlotId: 'self',
        });
        return;
      }
    }
    try {
      const raw = await ss.get(PROFILES_STORE_KEY);
      if (!raw) {
        // First boot: derive profile metadata from the primary identity if it
        // exists in the identity store, or initialise an empty placeholder.
        const { useIdentity } = require('./identity') as typeof import('./identity');
        const idState = useIdentity.getState();
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
      // Derive activeSlotId from the identity store (already hydrated by App.tsx).
      const { useIdentity } = require('./identity') as typeof import('./identity');
      const activeSlotId = useIdentity.getState().activeSlotId ?? 'self';
      set({
        profiles: attachActive(stored as Profile[], activeSlotId),
        activeSlotId,
      });
    } catch {
      // Non-fatal: profile list missing — app still functions with primary slot.
      set({ profiles: [], activeSlotId: 'self' });
    }
  },

  async createProfile(displayName, avatarColor, presetIdentity) {
    // 1. Use the wizard's already-previewed identity (so the AegisID/identicon
    //    shown during creation is the one that gets persisted); mint a fresh one
    //    only when no caller supplied it.
    const identity = presetIdentity ?? createIdentity();
    const slotId = identity.aegisId;
    const finalName = displayName || identity.aegisId.slice(0, 8).toLowerCase();

    // 2. Temporarily switch DB to the new slot to initialise the schema.
    const prevSlot = get().activeSlotId;
    setActiveDbSlot(slotId);

    // 3. Persist keys to SecureStore under per-slot names.
    await ss.set(secretKeySlot(slotId), identity.secretKeyB64);
    await ss.set(signSecretKeySlot(slotId), identity.signingSecretKeyB64);
    // Generate and store the per-profile DB encryption key.
    const dbKey = nacl.randomBytes(32);
    await ss.set(dbEncKeySlot(slotId), encodeBase64(dbKey));

    // 4. Persist the identity row in the new DB.
    await saveIdentity({
      aegisId: identity.aegisId,
      publicKeyB64: identity.publicKeyB64,
      secretKeyB64: identity.secretKeyB64,
      signingPublicKeyB64: identity.signingPublicKeyB64,
      signingSecretKeyB64: identity.signingSecretKeyB64,
      createdAt: identity.createdAt,
    });

    // 4b. Persist the chosen name/color under THIS slot's own preference keys
    //     (same scheme as useIdentity.getPrefKey: 'aegis.<slotId>.displayName').
    //     Without this, switchProfile → useIdentity.hydrate() finds no per-slot
    //     name/color and falls back to the aegisId-derived default, so the name
    //     the user typed never reached Profile/Ajustes (user-reported: "el
    //     nombre que coloco no sale en la configuración de perfil").
    await ss.set(`aegis.${slotId}.displayName`, finalName);
    await ss.set(`aegis.${slotId}.avatarColor`, avatarColor);

    // 4c. Register this slot in the global slotsList so a panic wipe / delete
    //     reaches its DB + secret keys — those are keyed by aegisId and are ONLY
    //     enumerable through slotsList (see wipeDatabase / deleteIdentitySlot).
    //     Missing here, a created profile's DB survived a factory-reset wipe
    //     (cero-metadatos leak) and the two multi-identity views drifted apart.
    try {
      const raw = await ss.get('aegis.slotsList');
      const slotsList: string[] = raw ? (JSON.parse(raw) as string[]) : ['self'];
      if (!slotsList.includes(slotId)) {
        slotsList.push(slotId);
        await ss.set('aegis.slotsList', JSON.stringify(slotsList));
      }
    } catch { /* non-fatal — slot is still usable; next hydrate re-syncs */ }

    // 5. Relay registration (PoW → prekey upload → verify) is intentionally NOT
    //    done inline here. It runs through the SINGLE authoritative path
    //    (ensureRegistered, via useIdentity.hydrate → runPublish) the moment the
    //    caller switches into this profile — with the correct PQXDH PQ prekey,
    //    the persisted `published` flag, the shared 429 cooldown, and a VISIBLE
    //    failure banner. The previous inline upload here was doubly broken: it
    //    (a) blocked the "Creando…" spinner on CPU-heavy PoW mining, and
    //    (b) omitted the PQXDH PQ prekey, so the relay bundle had no PQSPK —
    //    every inbound handshake hit the receiver's anti-downgrade gate and
    //    aborted, leaving the new identity unreachable from other devices
    //    ("se registra pero … como si no fuera un perfil real").

    // 6. Reset (not close) the new slot's connection before switching back.
    //    closeAsync here would block the WAL flush for no reason; a simple
    //    reset lets expo-sqlite reuse the shared connection next time.
    resetDbConnection();

    // 7. Restore the previous active slot.
    setActiveDbSlot(prevSlot);

    // 8. Persist profile metadata.
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

    // 1. Disconnect socket.
    try {
      const { getSocket } = require('../socket/client') as typeof import('../socket/client');
      getSocket()?.disconnect();
    } catch { /* socket not initialised */ }

    // 2. Switch slot FIRST so any store effects triggered by resetAllStores()
    //    open the new slot's DB rather than racing against the old one.
    setActiveDbSlot(slotId);

    // 3. Flush all in-memory Zustand stores (may trigger DB reads on new slot).
    resetAllStores();

    // 4. Persist the new active slot.
    // (closeActiveDatabase is intentionally NOT called here — resetting the
    //  dbPromise reference via setActiveDbSlot is sufficient; closing the
    //  native connection while in-flight store effects may hold a reference
    //  causes "Access to closed resource" crashes.)
    void closeActiveDatabase; // keep the import used (backup.ts still needs it)
    await ss.set('aegis.activeSlotId', slotId);

    // 5. Delegate full identity hydration to useIdentity (loads keys, preferences, etc.).
    set({ activeSlotId: slotId, profiles: attachActive(get().profiles, slotId) });
    const { useIdentity } = require('./identity') as typeof import('./identity');
    useIdentity.setState({ activeSlotId: slotId });
    await useIdentity.getState().hydrate();

    // 6. Reconnect socket under new identity.
    const identity = useIdentity.getState().identity;
    if (identity) {
      try {
        const { connect } = require('../socket/client') as typeof import('../socket/client');
        connect(identity);
      } catch { /* network unavailable */ }
    }

    // 7. Hydrate contacts and groups from the new DB.
    try {
      const { useContacts } = require('./contacts') as typeof import('./contacts');
      const { useGroups } = require('./groups') as typeof import('./groups');
      await useContacts.getState().hydrate();
      await useGroups.getState().hydrate();
    } catch { /* non-fatal */ }
  },

  async removeProfile(slotId) {
    const { profiles } = get();
    if (profiles.length <= 1) {
      throw new Error('Cannot remove the last profile.');
    }
    if (slotId === 'self') {
      throw new Error('Cannot remove the primary profile.');
    }

    // Switch away before deleting.
    if (slotId === get().activeSlotId) {
      await get().switchProfile('self');
    }

    // Wipe SecureStore slots and SQLite DB.
    await deleteIdentitySlot(slotId);

    // Drop the slot from the global slotsList too (createProfile added it there
    // so panic-wipe can reach its DB). Leaving a stale entry would make a later
    // wipe try to re-delete an already-gone slot and keep the two multi-identity
    // views out of sync.
    try {
      const raw = await ss.get('aegis.slotsList');
      if (raw) {
        const slotsList = (JSON.parse(raw) as string[]).filter((s) => s !== slotId);
        await ss.set('aegis.slotsList', JSON.stringify(slotsList));
      }
    } catch { /* non-fatal — deleteIdentitySlot already removed the key material */ }

    // Remove from profile list.
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

    // Sync display name to identity store if this is the active slot.
    if (slotId === get().activeSlotId) {
      const { useIdentity } = require('./identity') as typeof import('./identity');
      await useIdentity.getState().updateProfile(displayName, avatarColor, null);
    }
  },
}));
