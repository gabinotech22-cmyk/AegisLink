import { create } from 'zustand';
import { createIdentity, identityFromStored, type Identity } from '../crypto/identity';
import {
  loadIdentity,
  saveIdentity,
  setActiveDbSlot,
  closeActiveDatabase,
  deleteIdentitySlot,
} from '../db/local';
import { fetchPowChallenge, solvePoW, uploadIdentityAndPrekeys } from '../crypto/registration';
import { generatePreKeys } from '../crypto/signal/x3dh';
import { SERVER_URL } from '../config';
import '../crypto/ipc-types';

const secureStorage = () => window.aegis.secureStorage;
const DEV = Boolean(import.meta.env?.DEV);

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

  activeSlotId: string;
  slotsList: string[];

  hydrate: () => Promise<void>;
  generate: () => Promise<Identity>;
  reset: () => Promise<void>;
  updateProfile: (
    type: 'personal' | 'work',
    displayName: string,
    avatarColor: string,
    avatarImage: string | null,
  ) => Promise<void>;
  setActiveProfile: (type: 'personal' | 'work') => Promise<void>;
  updateStatus: (type: 'personal' | 'work', text: string) => Promise<void>;

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
 * Optional socket broadcast — the socket module may not be wired up yet in
 * desktop. We tolerate its absence so identity flows still work standalone.
 */
async function tryBroadcastProfileUpdate(identity: Identity): Promise<void> {
  try {
    const mod = (await import('../socket/client').catch(() => null)) as
      | { broadcastProfileUpdate?: (id: Identity) => Promise<void> }
      | null;
    if (mod?.broadcastProfileUpdate) await mod.broadcastProfileUpdate(identity);
  } catch (e) {
    if (DEV) console.warn('[identity] broadcast skipped:', (e as Error).message);
  }
}

async function publishToServer(identity: Identity): Promise<void> {
  try {
    const { challenge, difficulty } = await fetchPowChallenge(SERVER_URL);
    const nonce = await solvePoW(challenge, difficulty);

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
    if (!result.ok && DEV) {
      console.warn('[identity] publish failed:', result.error);
    }
  } catch (e) {
    if (DEV) console.warn('[identity] publish failed (network?):', (e as Error).message);
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
    // Safety net: if IPC is unavailable or hangs, resolve after 8 s so the
    // splash can dismiss and onboarding can render instead of a black screen.
    const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T | null> =>
      Promise.race([p, new Promise<null>((res) => setTimeout(() => res(null), ms))]);
    try {
      const { usePreferences } = await import('./preferences');
      if (usePreferences.getState().duressActive) {
        const decoyIdentity: Identity = {
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

      const activeSlotId = (await withTimeout(secureStorage().get('aegis.activeSlotId'), 8000)) || 'self';
      const slotsListRaw = await withTimeout(secureStorage().get('aegis.slotsList'), 8000);
      const slotsList = slotsListRaw ? (JSON.parse(slotsListRaw) as string[]) : ['self'];

      setActiveDbSlot(activeSlotId);

      const stored = await loadIdentity();
      if (!stored) {
        set({ identity: null, activeSlotId, slotsList, status: 'idle', hydrated: true });
        return;
      }
      const identity = identityFromStored(stored);

      const activeProfile = ((await secureStorage().get(getPrefKey('aegis.activeProfile', activeSlotId))) as 'personal' | 'work' | null) || 'personal';
      const displayName = (await secureStorage().get(getPrefKey('aegis.displayName', activeSlotId))) || identity.aegisId.toLowerCase().replace(/-/g, '');
      const avatarColor = (await secureStorage().get(getPrefKey('aegis.avatarColor', activeSlotId))) || '#05b875';
      const avatarImage = (await secureStorage().get(getPrefKey('aegis.avatarImage', activeSlotId))) || null;
      const profileStatus = (await secureStorage().get(getPrefKey('aegis.profileStatus', activeSlotId))) || '';
      const workDisplayName = (await secureStorage().get(getPrefKey('aegis.workDisplayName', activeSlotId))) || 'cirrus.work';
      const workAvatarColor = (await secureStorage().get(getPrefKey('aegis.workAvatarColor', activeSlotId))) || '#8b5cf6';
      const workAvatarImage = (await secureStorage().get(getPrefKey('aegis.workAvatarImage', activeSlotId))) || null;
      const workProfileStatus = (await secureStorage().get(getPrefKey('aegis.workProfileStatus', activeSlotId))) || '';

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
        hydrated: true,
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
    await secureStorage().set(getPrefKey('aegis.activeProfile', activeSlotId), 'personal');
    await secureStorage().set(getPrefKey('aegis.displayName', activeSlotId), defaultName);
    await secureStorage().set(getPrefKey('aegis.avatarColor', activeSlotId), defaultColor);
    await secureStorage().delete(getPrefKey('aegis.avatarImage', activeSlotId));
    await secureStorage().set(getPrefKey('aegis.workDisplayName', activeSlotId), 'cirrus.work');
    await secureStorage().set(getPrefKey('aegis.workAvatarColor', activeSlotId), '#8b5cf6');
    await secureStorage().delete(getPrefKey('aegis.workAvatarImage', activeSlotId));

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
      status: 'ready',
    });
    return identity;
  },

  async reset() {
    const slotsList = get().slotsList || ['self'];
    for (const slot of slotsList) {
      await deleteIdentitySlot(slot).catch(() => {});
    }
    await secureStorage().delete('aegis.activeSlotId').catch(() => {});
    await secureStorage().delete('aegis.slotsList').catch(() => {});

    const { useContacts } = await import('./contacts');
    const { useGroups } = await import('./groups');
    const { useMessages } = await import('./messages');
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
      status: 'idle',
    });
  },

  async updateProfile(type, displayName, avatarColor, avatarImage) {
    const slotId = get().activeSlotId || 'self';
    if (type === 'personal') {
      await secureStorage().set(getPrefKey('aegis.displayName', slotId), displayName);
      await secureStorage().set(getPrefKey('aegis.avatarColor', slotId), avatarColor);
      if (avatarImage) await secureStorage().set(getPrefKey('aegis.avatarImage', slotId), avatarImage);
      else await secureStorage().delete(getPrefKey('aegis.avatarImage', slotId));
      set({ displayName, avatarColor, avatarImage });
    } else {
      await secureStorage().set(getPrefKey('aegis.workDisplayName', slotId), displayName);
      await secureStorage().set(getPrefKey('aegis.workAvatarColor', slotId), avatarColor);
      if (avatarImage) await secureStorage().set(getPrefKey('aegis.workAvatarImage', slotId), avatarImage);
      else await secureStorage().delete(getPrefKey('aegis.workAvatarImage', slotId));
      set({ workDisplayName: displayName, workAvatarColor: avatarColor, workAvatarImage: avatarImage });
    }

    if (type === get().activeProfile) {
      const identity = get().identity;
      if (identity) await tryBroadcastProfileUpdate(identity);
    }
  },

  async setActiveProfile(type) {
    const slotId = get().activeSlotId || 'self';
    await secureStorage().set(getPrefKey('aegis.activeProfile', slotId), type);
    set({ activeProfile: type });

    const identity = get().identity;
    if (identity) await tryBroadcastProfileUpdate(identity);
  },

  async updateStatus(type, text) {
    const slotId = get().activeSlotId || 'self';
    const key = type === 'personal' ? 'aegis.profileStatus' : 'aegis.workProfileStatus';
    await secureStorage().set(getPrefKey(key, slotId), text);
    if (type === 'personal') set({ profileStatus: text });
    else set({ workProfileStatus: text });

    if (type === get().activeProfile) {
      const identity = get().identity;
      if (identity) await tryBroadcastProfileUpdate(identity);
    }
  },

  async createSlot() {
    set({ status: 'generating', error: null });
    try {
      const slotsList = get().slotsList || ['self'];
      let nextSlotNum = 1;
      while (slotsList.includes(`slot_${nextSlotNum}`)) nextSlotNum++;
      const newSlotId = `slot_${nextSlotNum}`;

      const identity = createIdentity();
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

      const defaultName = identity.aegisId.toLowerCase().replace(/-/g, '');
      const defaultColor = '#05b875';
      await secureStorage().set(getPrefKey('aegis.activeProfile', newSlotId), 'personal');
      await secureStorage().set(getPrefKey('aegis.displayName', newSlotId), defaultName);
      await secureStorage().set(getPrefKey('aegis.avatarColor', newSlotId), defaultColor);
      await secureStorage().set(getPrefKey('aegis.workDisplayName', newSlotId), 'cirrus.work');
      await secureStorage().set(getPrefKey('aegis.workAvatarColor', newSlotId), '#8b5cf6');

      await publishToServer(identity);
      setActiveDbSlot(prevSlot);

      const newSlotsList = [...slotsList, newSlotId];
      await secureStorage().set('aegis.slotsList', JSON.stringify(newSlotsList));

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
      const identity = createIdentity();
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

      await secureStorage().set(getPrefKey('aegis.activeProfile', newSlotId), 'work');
      await secureStorage().set(getPrefKey('aegis.displayName', newSlotId), 'cirrus.work');
      await secureStorage().set(getPrefKey('aegis.avatarColor', newSlotId), '#8b5cf6');
      await secureStorage().set(getPrefKey('aegis.workDisplayName', newSlotId), 'cirrus.work');
      await secureStorage().set(getPrefKey('aegis.workAvatarColor', newSlotId), '#8b5cf6');

      await publishToServer(identity);
      setActiveDbSlot(prevSlot);

      const newSlotsList = slotsList.includes(newSlotId) ? slotsList : [...slotsList, newSlotId];
      await secureStorage().set('aegis.slotsList', JSON.stringify(newSlotsList));

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
      // Disconnect socket if available
      try {
        const mod = (await import('../socket/client').catch(() => null)) as
          | { getSocket?: () => { disconnect: () => void } | null }
          | null;
        const sock = mod?.getSocket?.();
        if (sock) sock.disconnect();
      } catch { /* ignore */ }

      await closeActiveDatabase();

      const { useContacts } = await import('./contacts');
      const { useGroups } = await import('./groups');
      const { useMessages } = await import('./messages');
      useContacts.setState({ contacts: [], loading: false, error: null });
      useGroups.setState({ groups: [] });
      useMessages.setState({ byChat: {}, previews: {}, pinnedMsg: {}, unreadCounts: {}, drafts: {}, pendingMediaUri: null });

      setActiveDbSlot(slotId);
      await secureStorage().set('aegis.activeSlotId', slotId);

      set({ activeSlotId: slotId });
      await get().hydrate();

      const identity = get().identity;
      if (identity) {
        try {
          const mod = (await import('../socket/client').catch(() => null)) as
            | { connect?: (id: Identity) => void }
            | null;
          mod?.connect?.(identity);
        } catch { /* ignore */ }
      }

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

      if (slotId === activeSlotId) {
        await get().switchSlot('self');
      }

      await deleteIdentitySlot(slotId);

      const newSlotsList = slotsList.filter((s) => s !== slotId);
      await secureStorage().set('aegis.slotsList', JSON.stringify(newSlotsList));

      set({ slotsList: newSlotsList });
    } catch (e) {
      set({ error: (e as Error).message });
      throw e;
    }
  },
}));
