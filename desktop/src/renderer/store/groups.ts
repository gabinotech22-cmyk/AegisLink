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
 * Canonical group-metadata signing payload. MUST stay in sync with the relay
 * verifier — any change is a wire-format break.
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

async function signAsAdmin(group: StoredGroup): Promise<{ adminId: string; adminSig: string } | null> {
  const { useIdentity } = await import('./identity');
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

void decodeBase64;

interface GroupsState {
  groups: StoredGroup[];
  hydrate: () => Promise<void>;
  createGroup: (name: string, members: string[], avatarColor?: string, avatarImage?: string) => Promise<StoredGroup>;
  renameGroup: (id: string, name: string) => Promise<void>;
  addMember: (id: string, aegisId: string) => Promise<void>;
  removeMember: (id: string, aegisId: string) => Promise<void>;
  updateGroupPermissions: (
    id: string,
    patch: Partial<Pick<StoredGroup, 'adminOnlyInvite' | 'moderateNewMembers' | 'permissions'>>,
  ) => Promise<void>;
  leaveGroup: (id: string) => Promise<void>;
  /**
   * Admin-only: dissolve the group for EVERY member. Broadcasts a signed
   * dissolution marker (canonicalGroupDissolveBytes, see socket/client.ts
   * signGroupDissolve) to the roster first (offline-safe via the group
   * offline queue), then wipes the group locally exactly like leaveGroup.
   * No-op for non-admins — use leaveGroup instead. Parity with mobile's
   * store/groups.ts dissolveGroup.
   */
  dissolveGroup: (id: string) => Promise<void>;
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
    const sig = await signAsAdmin(base);
    const newGroup: StoredGroup = sig ? { ...base, ...sig } : base;
    await saveGroup(newGroup);
    set({ groups: [newGroup, ...get().groups] });
    return newGroup;
  },

  async renameGroup(id, name) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    const updated: StoredGroup = { ...group, name };
    const sig = await signAsAdmin(updated);
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
    const sig = await signAsAdmin(updated);
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
    const sig = await signAsAdmin(updated);
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
    await deleteContactMessages(id);
    await deleteGroup(id);
    set({ groups: get().groups.filter((g) => g.id !== id) });
    const { useMessages } = await import('./messages');
    useMessages.getState().clearChat(id);
  },

  async dissolveGroup(id) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    const { useIdentity } = await import('./identity');
    const me = useIdentity.getState().identity;
    // Admin-only. Non-admins must use leaveGroup instead — the UI (GroupAdmin.tsx)
    // already branches on this, but the store itself must not trust the caller.
    if (!me || !group.adminId || me.aegisId !== group.adminId) return;

    // Broadcast FIRST so the signed dissolution rides the offline queue even if
    // we are offline right now.
    try {
      const { broadcastGroupDissolve } = await import('../socket/client');
      await broadcastGroupDissolve(me, id);
    } catch {
      // Best-effort — the offline queue (if reached) retries on reconnect
      // regardless of this catch.
    }

    // Local wipe — identical to leaveGroup.
    await deleteContactMessages(id);
    await deleteGroup(id);
    set({ groups: get().groups.filter((g) => g.id !== id) });
    const { useMessages } = await import('./messages');
    useMessages.getState().clearChat(id);
  },
}));
