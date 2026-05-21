import { create } from 'zustand';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import {
  loadGroups,
  saveGroup,
  deleteGroup,
  deleteContactMessages,
  type StoredGroup,
} from '../db/local';

/**
 * Canonical group-metadata signing payload — MUST stay in sync with
 * canonicalGroupBytes in socket/client.ts. Any change here is a wire-format
 * break and old admin signatures will fail verification.
 */
function canonicalGroupBytes(args: {
  groupId: string;
  groupName: string;
  members: string[];
  createdAt: number;
}): Uint8Array {
  const sorted = [...args.members].sort();
  const canonical = JSON.stringify([
    'aegis.group.v1',
    args.groupId,
    args.groupName,
    sorted,
    args.createdAt,
  ]);
  return new TextEncoder().encode(canonical);
}

/**
 * Sign current group metadata with the active identity's Ed25519 signing key.
 * Returns null if no identity is loaded (caller should leave adminSig unset).
 */
function signAsAdmin(group: StoredGroup): { adminId: string; adminSig: string } | null {
  // Lazy import to avoid a circular dep with the identity store at module load.
  const { useIdentity } = require('./identity') as typeof import('./identity');
  const id = useIdentity.getState().identity;
  if (!id) return null;
  const sig = nacl.sign.detached(
    canonicalGroupBytes({
      groupId: group.id,
      groupName: group.name,
      members: group.members,
      createdAt: group.createdAt,
    }),
    id.signingSecretKey,
  );
  return { adminId: id.aegisId, adminSig: encodeBase64(sig) };
}

// Re-export decodeBase64 just to keep the import non-dead in case future
// migrations need to inspect signatures stored in the DB.
void decodeBase64;

interface GroupsState {
  groups: StoredGroup[];
  hydrate: () => Promise<void>;
  createGroup: (name: string, members: string[], avatarColor?: string, avatarImage?: string) => Promise<StoredGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  addMember: (id: string, aegisId: string) => Promise<void>;
  removeMember: (id: string, aegisId: string) => Promise<void>;
  updateGroupPermissions: (id: string, patch: Partial<Pick<StoredGroup, 'adminOnlyInvite' | 'moderateNewMembers'>>) => Promise<void>;
  leaveGroup: (id: string) => Promise<void>;
}

export const useGroups = create<GroupsState>((set, get) => ({
  groups: [],

  async hydrate() {
    const list = await loadGroups();
    set({ groups: list });
  },

  async createGroup(name, members, avatarColor, avatarImage) {
    const id = 'group_' + Math.random().toString(36).slice(2, 11);
    const base: StoredGroup = {
      id,
      name,
      members,
      createdAt: Date.now(),
      avatarColor,
      avatarImage,
    };
    // Sign our own metadata as admin. Receivers will reject unsigned groups
    // (see socket/client.ts group_msg handler), so this is mandatory.
    const sig = signAsAdmin(base);
    const newGroup: StoredGroup = sig ? { ...base, ...sig } : base;
    await saveGroup(newGroup);
    set({ groups: [newGroup, ...get().groups] });
    return newGroup;
  },

  async renameGroup(id, name) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    // Only the admin can produce a signature that peers will accept.
    const updated: StoredGroup = { ...group, name };
    const sig = signAsAdmin(updated);
    if (sig) {
      updated.adminId = sig.adminId;
      updated.adminSig = sig.adminSig;
    }
    await saveGroup(updated);
    set({ groups: get().groups.map((g) => (g.id === id ? updated : g)) });
  },

  async addMember(id, aegisId) {
    const group = get().groups.find((g) => g.id === id);
    if (!group || group.members.includes(aegisId)) return;
    const updated: StoredGroup = { ...group, members: [...group.members, aegisId] };
    const sig = signAsAdmin(updated);
    if (sig) {
      updated.adminId = sig.adminId;
      updated.adminSig = sig.adminSig;
    }
    await saveGroup(updated);
    set({ groups: get().groups.map((g) => (g.id === id ? updated : g)) });
  },

  async removeMember(id, aegisId) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    const updated: StoredGroup = { ...group, members: group.members.filter((m) => m !== aegisId) };
    const sig = signAsAdmin(updated);
    if (sig) {
      updated.adminId = sig.adminId;
      updated.adminSig = sig.adminSig;
    }
    await saveGroup(updated);
    set({ groups: get().groups.map((g) => (g.id === id ? updated : g)) });
  },

  async updateGroupPermissions(id, patch) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    const updated = { ...group, ...patch };
    await saveGroup(updated);
    set({ groups: get().groups.map((g) => (g.id === id ? updated : g)) });
  },

  async leaveGroup(id) {
    // Wipe all local messages for this group and delete the group record
    await deleteContactMessages(id);
    await deleteGroup(id);
    set({ groups: get().groups.filter((g) => g.id !== id) });
    // Clear in-memory chat state from the messages store
    const { useMessages } = require('./messages');
    useMessages.getState().clearChat(id);
  },
}));
