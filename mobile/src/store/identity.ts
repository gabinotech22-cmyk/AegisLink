import { create } from 'zustand';
import * as SecureStore from 'expo-secure-store';
import { createIdentity, identityFromStored, type Identity } from '../crypto/identity';
import { loadIdentity, saveIdentity, clearIdentity } from '../db/local';
import { ApiError } from '../api';
import { fetchPowChallenge, solvePoW, uploadIdentityAndPrekeys } from '../crypto/registration';
import { generatePreKeys } from '../crypto/signal/x3dh';
import { SERVER_URL } from '../config';

interface IdentityState {
  identity: Identity | null;
  status: 'idle' | 'loading' | 'generating' | 'ready';
  hydrated: boolean;
  error: string | null;
  activeProfile: 'personal' | 'work';
  displayName: string;
  avatarColor: string;
  avatarImage: string | null;
  profileStatus: string;
  workDisplayName: string;
  workAvatarColor: string;
  workAvatarImage: string | null;
  workProfileStatus: string;

  // Multi-E2EE Slots State
  activeSlotId: string;
  slotsList: string[];

  hydrate: () => Promise<void>;
  generate: () => Promise<Identity>;
  reset: () => Promise<void>;
  updateProfile: (type: 'personal' | 'work', displayName: string, avatarColor: string, avatarImage: string | null) => Promise<void>;
  setActiveProfile: (type: 'personal' | 'work') => Promise<void>;
  updateStatus: (type: 'personal' | 'work', text: string) => Promise<void>;

  // Multi-E2EE Slots Actions
  createSlot: () => Promise<string>;
  createWorkSlot: () => Promise<Identity>;
  switchSlot: (slotId: string) => Promise<void>;
  deleteSlot: (slotId: string) => Promise<void>;
}

function getPrefKey(key: string, slot: string): string {
  if (slot === 'self') return key;
  const suffix = key.replace(/^aegis\./, '');
  return `aegis.${slot}.${suffix}`;
}

/**
 * Registers identity on the relay using PoW-gated endpoint.
 * Fails silently so a temporary network outage doesn't block onboarding;
 * the socket reconnect path will re-register via the unknown_identity handler.
 */
async function publishToServer(identity: Identity): Promise<void> {
  try {
    const { challenge, difficulty } = await fetchPowChallenge(SERVER_URL);
    const nonce = await solvePoW(challenge, difficulty);

    // Generate fresh prekeys to upload alongside the identity.
    const preKeys = generatePreKeys(identity);
    const result = await uploadIdentityAndPrekeys(
      identity,
      {
        signedPreKey: { keyId: preKeys.signedPreKey.keyId, secretKey: preKeys.signedPreKey.secretKey },
        opkSecrets: preKeys.opkSecrets,
      },
      SERVER_URL,
      challenge,
      nonce,
      preKeys.oneTimePreKeys,
      {
        keyId: preKeys.signedPreKey.keyId,
        publicKeyB64: preKeys.signedPreKey.publicKeyB64,
        signatureB64: preKeys.signedPreKey.signatureB64,
      },
    );
    if (!result.ok && __DEV__) {
      console.warn('[identity] publish failed:', result.error);
    }
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      if (__DEV__) console.warn('[identity] aegis_id taken on server — local identity kept');
    } else {
      if (__DEV__) console.warn('[identity] publish failed (network?):', (e as Error).message);
    }
  }
}

export const useIdentity = create<IdentityState>((set, get) => ({
  identity: null,
  status: 'idle',
  hydrated: false,
  error: null,
  activeProfile: 'personal',
  displayName: 'you',
  avatarColor: '#05b875',
  avatarImage: null,
  profileStatus: '',
  workDisplayName: 'cirrus.work',
  workAvatarColor: '#8b5cf6',
  workAvatarImage: null,
  workProfileStatus: '',

  activeSlotId: 'self',
  slotsList: ['self'],

  async hydrate() {
    set({ status: 'loading', error: null });
    try {
      const { usePreferences } = require('./preferences');
      if (usePreferences.getState().duressActive) {
        const decoyIdentity = {
          aegisId: 'AEGIS-MOCK',
          publicKey: new Uint8Array(32),
          secretKey: new Uint8Array(32),
          publicKeyB64: 'mockPublicKeyB64String',
          secretKeyB64: 'mockSecretKeyB64String',
          signingPublicKey: new Uint8Array(32),
          signingSecretKey: new Uint8Array(64),
          signingPublicKeyB64: 'mockSigningPublicKeyB64String',
          signingSecretKeyB64: 'mockSigningSecretKeyB64String',
          createdAt: Date.now(),
        };
        set({
          identity: decoyIdentity,
          activeSlotId: 'self',
          slotsList: ['self'],
          activeProfile: 'personal',
          displayName: 'anon.aegis',
          avatarColor: '#5bf2b9',
          avatarImage: null,
          profileStatus: 'Safe & Protected',
          status: 'ready',
          hydrated: true,
        });
        return;
      }

      // Load activeSlotId and slotsList first
      const activeSlotId = (await SecureStore.getItemAsync('aegis.activeSlotId')) || 'self';
      const slotsListRaw = await SecureStore.getItemAsync('aegis.slotsList');
      const slotsList = slotsListRaw ? JSON.parse(slotsListRaw) : ['self'];

      // Set the active slot in the database manager
      const { setActiveDbSlot } = require('../db/local');
      setActiveDbSlot(activeSlotId);

      const stored = await loadIdentity();
      if (!stored) {
        set({ identity: null, activeSlotId, slotsList, status: 'idle', hydrated: true });
        return;
      }
      const identity = identityFromStored(stored);
      
      const activeProfile = (await SecureStore.getItemAsync(getPrefKey('aegis.activeProfile', activeSlotId)) as 'personal' | 'work') || 'personal';
      const displayName = await SecureStore.getItemAsync(getPrefKey('aegis.displayName', activeSlotId)) || identity.aegisId.toLowerCase().replace(/-/g, '');
      const avatarColor = await SecureStore.getItemAsync(getPrefKey('aegis.avatarColor', activeSlotId)) || '#05b875';
      const avatarImage = await SecureStore.getItemAsync(getPrefKey('aegis.avatarImage', activeSlotId)) || null;

      const profileStatus = await SecureStore.getItemAsync(getPrefKey('aegis.profileStatus', activeSlotId)) || '';

      const workDisplayName = await SecureStore.getItemAsync(getPrefKey('aegis.workDisplayName', activeSlotId)) || 'cirrus.work';
      const workAvatarColor = await SecureStore.getItemAsync(getPrefKey('aegis.workAvatarColor', activeSlotId)) || '#8b5cf6';
      const workAvatarImage = await SecureStore.getItemAsync(getPrefKey('aegis.workAvatarImage', activeSlotId)) || null;
      const workProfileStatus = await SecureStore.getItemAsync(getPrefKey('aegis.workProfileStatus', activeSlotId)) || '';

      // Register identity on server BEFORE marking ready — prevents the race
      // condition where the socket authenticates before the identity is in the
      // relay's DB (causing `unknown_identity` and immediate disconnect).
      await publishToServer(identity);
      set({
        identity,
        activeSlotId,
        slotsList,
        activeProfile,
        displayName,
        avatarColor,
        avatarImage,
        profileStatus,
        workDisplayName,
        workAvatarColor,
        workAvatarImage,
        workProfileStatus,
        status: 'ready',
        hydrated: true
      });
    } catch (e) {
      set({ status: 'idle', hydrated: true, error: (e as Error).message });
    }
  },

  async generate() {
    set({ status: 'generating', error: null });
    const identity = createIdentity();
    await saveIdentity({
      aegisId: identity.aegisId,
      publicKeyB64: identity.publicKeyB64,
      secretKeyB64: identity.secretKeyB64,
      signingPublicKeyB64: identity.signingPublicKeyB64,
      signingSecretKeyB64: identity.signingSecretKeyB64,
      createdAt: identity.createdAt,
    });

    const activeSlotId = get().activeSlotId || 'self';
    const defaultName = identity.aegisId.toLowerCase().replace(/-/g, '');
    const defaultColor = '#05b875';
    await SecureStore.setItemAsync(getPrefKey('aegis.activeProfile', activeSlotId), 'personal');
    await SecureStore.setItemAsync(getPrefKey('aegis.displayName', activeSlotId), defaultName);
    await SecureStore.setItemAsync(getPrefKey('aegis.avatarColor', activeSlotId), defaultColor);
    await SecureStore.deleteItemAsync(getPrefKey('aegis.avatarImage', activeSlotId));

    await SecureStore.setItemAsync(getPrefKey('aegis.workDisplayName', activeSlotId), 'cirrus.work');
    await SecureStore.setItemAsync(getPrefKey('aegis.workAvatarColor', activeSlotId), '#8b5cf6');
    await SecureStore.deleteItemAsync(getPrefKey('aegis.workAvatarImage', activeSlotId));

    await publishToServer(identity);
    set({
      identity,
      activeProfile: 'personal',
      displayName: defaultName,
      avatarColor: defaultColor,
      avatarImage: null,
      profileStatus: '',
      workDisplayName: 'cirrus.work',
      workAvatarColor: '#8b5cf6',
      workAvatarImage: null,
      workProfileStatus: '',
      status: 'ready'
    });
    return identity;
  },

  async reset() {
    const slotsList = get().slotsList || ['self'];
    const { deleteIdentitySlot } = require('../db/local');
    for (const slot of slotsList) {
      await deleteIdentitySlot(slot).catch(() => {});
    }
    // Also delete global activeSlotId and slotsList keys
    await SecureStore.deleteItemAsync('aegis.activeSlotId').catch(() => {});
    await SecureStore.deleteItemAsync('aegis.slotsList').catch(() => {});

    // Purge any plaintext-decrypted media from the filesystem cache
    const { purgeCachedDecryptedMedia } = require('../crypto/media');
    await (purgeCachedDecryptedMedia as () => Promise<void>)().catch(() => {});

    // Reset all other Zustand stores — DB is already empty, bring memory in sync
    const { useContacts } = require('./contacts');
    const { useGroups } = require('./groups');
    const { useMessages } = require('./messages');
    useContacts.setState({ contacts: [], loading: false, error: null });
    useGroups.setState({ groups: [] });
    useMessages.setState({ byChat: {}, previews: {}, pinnedMsg: {}, unreadCounts: {}, drafts: {}, pendingMediaUri: null });
    set({
      identity: null,
      activeSlotId: 'self',
      slotsList: ['self'],
      activeProfile: 'personal',
      displayName: 'you',
      avatarColor: '#05b875',
      avatarImage: null,
      profileStatus: '',
      workDisplayName: 'cirrus.work',
      workAvatarColor: '#8b5cf6',
      workAvatarImage: null,
      workProfileStatus: '',
      status: 'idle'
    });
  },

  async updateProfile(type, displayName, avatarColor, avatarImage) {
    const slotId = get().activeSlotId || 'self';
    if (type === 'personal') {
      await SecureStore.setItemAsync(getPrefKey('aegis.displayName', slotId), displayName);
      await SecureStore.setItemAsync(getPrefKey('aegis.avatarColor', slotId), avatarColor);
      if (avatarImage) {
        await SecureStore.setItemAsync(getPrefKey('aegis.avatarImage', slotId), avatarImage);
      } else {
        await SecureStore.deleteItemAsync(getPrefKey('aegis.avatarImage', slotId));
      }
      set({ displayName, avatarColor, avatarImage });
    } else {
      await SecureStore.setItemAsync(getPrefKey('aegis.workDisplayName', slotId), displayName);
      await SecureStore.setItemAsync(getPrefKey('aegis.workAvatarColor', slotId), avatarColor);
      if (avatarImage) {
        await SecureStore.setItemAsync(getPrefKey('aegis.workAvatarImage', slotId), avatarImage);
      } else {
        await SecureStore.deleteItemAsync(getPrefKey('aegis.workAvatarImage', slotId));
      }
      set({ workDisplayName: displayName, workAvatarColor: avatarColor, workAvatarImage: avatarImage });
    }

    // Propagate the new profile to all contacts so they don't keep seeing our
    // raw Aegis ID. Only fires if the edited profile is currently active.
    if (type === get().activeProfile) {
      const identity = get().identity;
      if (identity) {
        const { broadcastProfileUpdate } = require('../socket/client');
        broadcastProfileUpdate(identity).catch((e: Error) => { if (__DEV__) console.warn('[identity] profile broadcast failed:', e); });
      }
    }
  },

  async setActiveProfile(type) {
    const slotId = get().activeSlotId || 'self';
    await SecureStore.setItemAsync(getPrefKey('aegis.activeProfile', slotId), type);
    set({ activeProfile: type });

    // GAP 4 FIX: Propagate the newly active profile to all contacts so they
    // immediately see Personal↔Work switch instead of stale data
    const identity = get().identity;
    if (identity) {
      try {
        const { broadcastProfileUpdate } = require('../socket/client');
        await broadcastProfileUpdate(identity);
      } catch (e) {
        if (__DEV__) console.warn('[identity] profile switch broadcast failed:', e);
      }
    }
  },

  async updateStatus(type, text) {
    const slotId = get().activeSlotId || 'self';
    const key = type === 'personal' ? 'aegis.profileStatus' : 'aegis.workProfileStatus';
    await SecureStore.setItemAsync(getPrefKey(key, slotId), text);
    if (type === 'personal') set({ profileStatus: text });
    else set({ workProfileStatus: text });

    if (type === get().activeProfile) {
      const identity = get().identity;
      if (identity) {
        try {
          const { broadcastProfileUpdate } = require('../socket/client');
          await broadcastProfileUpdate(identity);
        } catch (e) {
          if (__DEV__) console.warn('[identity] status broadcast failed:', e);
        }
      }
    }
  },

  // Multi-E2EE Slots Actions
  async createSlot() {
    set({ status: 'generating', error: null });
    try {
      const slotsList = get().slotsList || ['self'];
      
      // Determine next slot ID, e.g. slot_1, slot_2...
      let nextSlotNum = 1;
      while (slotsList.includes(`slot_${nextSlotNum}`)) {
        nextSlotNum++;
      }
      const newSlotId = `slot_${nextSlotNum}`;

      // Create identity for the new slot
      const identity = createIdentity();

      // Temporarily set active slot in db to the new slot to save the identity in the new DB file!
      const { setActiveDbSlot } = require('../db/local');
      const prevSlot = get().activeSlotId;
      setActiveDbSlot(newSlotId);

      await saveIdentity({
        aegisId: identity.aegisId,
        publicKeyB64: identity.publicKeyB64,
        secretKeyB64: identity.secretKeyB64,
        signingPublicKeyB64: identity.signingPublicKeyB64,
        signingSecretKeyB64: identity.signingSecretKeyB64,
        createdAt: identity.createdAt,
      });

      // Save default preferences for the new slot
      const defaultName = identity.aegisId.toLowerCase().replace(/-/g, '');
      const defaultColor = '#05b875';
      await SecureStore.setItemAsync(getPrefKey('aegis.activeProfile', newSlotId), 'personal');
      await SecureStore.setItemAsync(getPrefKey('aegis.displayName', newSlotId), defaultName);
      await SecureStore.setItemAsync(getPrefKey('aegis.avatarColor', newSlotId), defaultColor);
      await SecureStore.setItemAsync(getPrefKey('aegis.workDisplayName', newSlotId), 'cirrus.work');
      await SecureStore.setItemAsync(getPrefKey('aegis.workAvatarColor', newSlotId), '#8b5cf6');

      // Publish to server
      await publishToServer(identity);

      // Restore active slot
      setActiveDbSlot(prevSlot);

      // Update slotsList
      const newSlotsList = [...slotsList, newSlotId];
      await SecureStore.setItemAsync('aegis.slotsList', JSON.stringify(newSlotsList));

      set({ slotsList: newSlotsList, status: 'ready' });
      return newSlotId;
    } catch (e) {
      set({ status: 'ready', error: (e as Error).message });
      throw e;
    }
  },

  async createWorkSlot() {
    set({ status: 'generating', error: null });
    try {
      const slotsList = get().slotsList || ['self'];
      const newSlotId = 'work';

      // Create identity for the new slot
      const identity = createIdentity();

      // Temporarily set active slot in db to the new slot to save the identity in the new DB file!
      const { setActiveDbSlot } = require('../db/local');
      const prevSlot = get().activeSlotId;
      setActiveDbSlot(newSlotId);

      await saveIdentity({
        aegisId: identity.aegisId,
        publicKeyB64: identity.publicKeyB64,
        secretKeyB64: identity.secretKeyB64,
        signingPublicKeyB64: identity.signingPublicKeyB64,
        signingSecretKeyB64: identity.signingSecretKeyB64,
        createdAt: identity.createdAt,
      });

      // Save default preferences for the new slot
      await SecureStore.setItemAsync(getPrefKey('aegis.activeProfile', newSlotId), 'work');
      await SecureStore.setItemAsync(getPrefKey('aegis.displayName', newSlotId), 'cirrus.work');
      await SecureStore.setItemAsync(getPrefKey('aegis.avatarColor', newSlotId), '#8b5cf6');

      await SecureStore.setItemAsync(getPrefKey('aegis.workDisplayName', newSlotId), 'cirrus.work');
      await SecureStore.setItemAsync(getPrefKey('aegis.workAvatarColor', newSlotId), '#8b5cf6');

      // Publish to server
      await publishToServer(identity);

      // Restore active slot
      setActiveDbSlot(prevSlot);

      // Update slotsList
      const newSlotsList = slotsList.includes(newSlotId) ? slotsList : [...slotsList, newSlotId];
      await SecureStore.setItemAsync('aegis.slotsList', JSON.stringify(newSlotsList));

      set({ slotsList: newSlotsList, status: 'ready' });
      return identity;
    } catch (e) {
      set({ status: 'ready', error: (e as Error).message });
      throw e;
    }
  },

  async switchSlot(slotId: string) {
    set({ status: 'loading', error: null });
    try {
      // 1. Disconnect socket
      const { getSocket } = require('../socket/client');
      const sock = getSocket();
      if (sock) {
        sock.disconnect();
      }

      // 2. Safely close database
      const { closeActiveDatabase, setActiveDbSlot } = require('../db/local');
      await closeActiveDatabase();

      // 3. Reset Zustand stores in memory
      const { useContacts } = require('./contacts');
      const { useGroups } = require('./groups');
      const { useMessages } = require('./messages');
      useContacts.setState({ contacts: [], loading: false, error: null });
      useGroups.setState({ groups: [] });
      useMessages.setState({ byChat: {}, previews: {}, pinnedMsg: {}, unreadCounts: {}, drafts: {}, pendingMediaUri: null });

      // 4. Update slot settings and activeDbSlot
      setActiveDbSlot(slotId);
      await SecureStore.setItemAsync('aegis.activeSlotId', slotId);

      // 5. Hydrate from the new DB
      set({ activeSlotId: slotId });
      await get().hydrate();

      // 6. Connect socket under new identity
      const identity = get().identity;
      if (identity) {
        const { connect } = require('../socket/client');
        connect(identity);
      }
      
      // 7. Hydrate groups and contacts from the new database file
      await useContacts.getState().hydrate().catch(() => {});
      await useGroups.getState().hydrate().catch(() => {});
    } catch (e) {
      set({ status: 'idle', error: (e as Error).message });
      throw e;
    }
  },

  async deleteSlot(slotId: string) {
    try {
      const slotsList = get().slotsList || ['self'];
      const activeSlotId = get().activeSlotId || 'self';
      
      if (slotId === 'self') {
        throw new Error('Cannot delete primary slot');
      }

      // If the slot to delete is currently active, we switch to 'self' first!
      if (slotId === activeSlotId) {
        await get().switchSlot('self');
      }

      // Securely delete from DB and secure preferences
      const { deleteIdentitySlot } = require('../db/local');
      await deleteIdentitySlot(slotId);

      // Remove from list
      const newSlotsList = slotsList.filter((s) => s !== slotId);
      await SecureStore.setItemAsync('aegis.slotsList', JSON.stringify(newSlotsList));
      
      set({ slotsList: newSlotsList });
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    }
  },
}));
