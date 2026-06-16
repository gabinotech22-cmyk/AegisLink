import { create } from 'zustand';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import {
  loadGroups,
  saveGroup,
  deleteGroup,
  deleteContactMessages,
  type StoredGroup,
} from '../db/local';

/**
 * Groups with more than LARGE_GROUP_THRESHOLD members use the v2
 * roster-by-reference wire format: per-message payloads carry only a
 * `rosterHash` + `rosterVersion` instead of the full member list, dropping
 * fan-out bandwidth from O(N²) to O(N) per broadcast. Groups at or below the
 * threshold stay on the v1 path UNCHANGED — zero regression for small groups,
 * where embedding the roster every message costs little and avoids the extra
 * carrier round-trip.
 */
export const LARGE_GROUP_THRESHOLD = 64;

/** Hard cap on group size. Enforced in createGroup / addMember. */
export const MAX_GROUP_MEMBERS = 1024;

/**
 * Stable hash of a member set: sha256(utf8(JSON.stringify(sorted members))).
 * Members are sorted so the same set always hashes identically regardless of
 * insertion order. This MUST match computeRosterHash in socket/client.ts byte
 * for byte — both feed the same canonical v2 signing bytes.
 */
export function computeRosterHash(members: string[]): string {
  const sorted = [...members].sort();
  const bytes = new TextEncoder().encode(JSON.stringify(sorted));
  return bytesToHex(sha256(bytes));
}

/**
 * Canonical v2 group-metadata signing payload — roster BY REFERENCE.
 * MUST stay in sync with canonicalGroupBytesV2 in socket/client.ts. The full
 * member list is replaced by its hash so the admin signature is constant-size
 * and can be re-verified against any payload that carries the matching
 * rosterHash + rosterVersion (whether or not the members are inlined).
 */
function canonicalGroupBytesV2(args: {
  groupId: string;
  groupName: string;
  rosterHash: string;
  rosterVersion: number;
  createdAt: number;
}): Uint8Array {
  const canonical = JSON.stringify([
    'aegis.group.v2',
    args.groupId,
    args.groupName,
    args.rosterHash,
    args.rosterVersion,
    args.createdAt,
  ]);
  return new TextEncoder().encode(canonical);
}

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
 *
 * Large groups (> LARGE_GROUP_THRESHOLD members) are signed with the v2
 * roster-by-reference bytes; small groups keep the v1 bytes (roster inlined).
 * The single `adminSig` stored on the group is whichever matches the group's
 * current size — receivers pick the matching verifier from the wire format.
 */
function signAsAdmin(group: StoredGroup): { adminId: string; adminSig: string } | null {
  // Lazy import to avoid a circular dep with the identity store at module load.
  const { useIdentity } = require('./identity') as typeof import('./identity');
  const id = useIdentity.getState().identity;
  if (!id) return null;
  const isLarge = group.members.length > LARGE_GROUP_THRESHOLD;
  const bytes = isLarge
    ? canonicalGroupBytesV2({
        groupId: group.id,
        groupName: group.name,
        rosterHash: computeRosterHash(group.members),
        rosterVersion: group.rosterVersion ?? 1,
        createdAt: group.createdAt,
      })
    : canonicalGroupBytes({
        groupId: group.id,
        groupName: group.name,
        members: group.members,
        createdAt: group.createdAt,
      });
  const sig = nacl.sign.detached(bytes, id.signingSecretKey);
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
  updateGroupAvatar: (id: string, avatarImage: string) => Promise<void>;
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
    // Hard cap: reject oversized groups before doing any work. Callers in the
    // UI must catch 'group_member_limit' (see CreateGroup / member-picker).
    if (members.length > MAX_GROUP_MEMBERS) throw new Error('group_member_limit');
    const id = 'group_' + Math.random().toString(36).slice(2, 11);

    // If the URI comes from the image picker (file:// or content://), copy it to
    // DocumentDirectory so it survives cache eviction and app restarts.
    // The picker writes to a temporary cache dir that Android can clear at any time.
    let persistentAvatarUri = avatarImage ?? undefined;
    if (
      avatarImage &&
      (avatarImage.startsWith('file://') || avatarImage.startsWith('content://'))
    ) {
      try {
        const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
        const dir = `${FS.documentDirectory}avatars/`;
        await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const rawExt = avatarImage.includes('.')
          ? avatarImage.split('.').pop()?.toLowerCase()
          : undefined;
        const ext = rawExt && rawExt.length <= 4 ? rawExt : 'jpg';
        const destPath = `${dir}group_${id}_avatar.${ext}`;
        await FS.copyAsync({ from: avatarImage, to: destPath });
        persistentAvatarUri = destPath;
      } catch {
        // Non-fatal: fall back to the original URI
      }
    }

    const base: StoredGroup = {
      id,
      name,
      members,
      createdAt: Date.now(),
      avatarColor,
      avatarImage: persistentAvatarUri,
      // Roster starts at version 1; bumped on every add/removeMember. The v2
      // signature (large groups) covers this value, so it must be set BEFORE
      // signAsAdmin runs below.
      rosterVersion: 1,
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
    // Push the new name to members now instead of on the admin's next message.
    try {
      const client = require('../socket/client') as typeof import('../socket/client');
      const { useIdentity } = require('./identity') as typeof import('./identity');
      const identity = useIdentity.getState().identity;
      if (identity) await client.broadcastGroupMetadata(identity, id);
    } catch { /* non-fatal — change still propagates on the next group message */ }
  },

  async updateGroupAvatar(id, avatarImage) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    // Persist picker URIs (file://, content://) into documentDirectory so the
    // avatar survives cache eviction — same as createGroup.
    let persistentAvatarUri = avatarImage;
    if (avatarImage && (avatarImage.startsWith('file://') || avatarImage.startsWith('content://'))) {
      try {
        const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
        const dir = `${FS.documentDirectory}avatars/`;
        await FS.makeDirectoryAsync(dir, { intermediates: true }).catch(() => {});
        const rawExt = avatarImage.includes('.') ? avatarImage.split('.').pop()?.toLowerCase() : undefined;
        const ext = rawExt && rawExt.length <= 4 ? rawExt : 'jpg';
        const destPath = `${dir}group_${id}_avatar_${Date.now()}.${ext}`;
        await FS.copyAsync({ from: avatarImage, to: destPath });
        persistentAvatarUri = destPath;
      } catch { /* fall back to original URI */ }
    }
    const updated: StoredGroup = { ...group, avatarImage: persistentAvatarUri };
    // Re-sign as admin so peers accept the updated metadata.
    const sig = signAsAdmin(updated);
    if (sig) {
      updated.adminId = sig.adminId;
      updated.adminSig = sig.adminSig;
    }
    await saveGroup(updated);
    set({ groups: get().groups.map((g) => (g.id === id ? updated : g)) });
    // Re-arm the avatar so the sync below re-includes the (updated) image data
    // URI, then push the change to all members immediately — otherwise the new
    // avatar only reaches them on the admin's next group message.
    try {
      const client = require('../socket/client') as typeof import('../socket/client');
      client.forgetGroupAvatarSent?.(id);
      const { useIdentity } = require('./identity') as typeof import('./identity');
      const identity = useIdentity.getState().identity;
      if (identity) await client.broadcastGroupMetadata(identity, id);
    } catch { /* non-fatal — change still propagates on the next group message */ }
  },

  async addMember(id, aegisId) {
    const group = get().groups.find((g) => g.id === id);
    if (!group || group.members.includes(aegisId)) return;
    // Enforce the cap on the resulting size. UI callers must catch
    // 'group_member_limit' (see member-picker / GroupInfo add flow).
    if (group.members.length + 1 > MAX_GROUP_MEMBERS) throw new Error('group_member_limit');
    // Bump rosterVersion BEFORE signing so the v2 signature (large groups)
    // covers the new monotonic value; receivers use it to order roster updates.
    const updated: StoredGroup = {
      ...group,
      members: [...group.members, aegisId],
      rosterVersion: (group.rosterVersion ?? 1) + 1,
    };
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
    // Bump rosterVersion BEFORE signing (same rationale as addMember).
    const updated: StoredGroup = {
      ...group,
      members: group.members.filter((m) => m !== aegisId),
      rosterVersion: (group.rosterVersion ?? 1) + 1,
    };
    const sig = signAsAdmin(updated);
    if (sig) {
      updated.adminId = sig.adminId;
      updated.adminSig = sig.adminSig;
    }
    await saveGroup(updated);
    set({ groups: get().groups.map((g) => (g.id === id ? updated : g)) });

    // Forward secrecy: rotate the group SenderKey so the removed member, who
    // still holds the previous chain key, cannot decrypt any future message.
    // The new key is sealed individually for each REMAINING member only — the
    // removed `aegisId` is excluded from `updated.members`, so it is never in
    // the distribution list. Best-effort if offline: the rotation re-attempts
    // on the next removal/admin action, and the removed member receives no
    // further messages until then because senders use the new local key.
    const { useIdentity } = require('./identity') as typeof import('./identity');
    const identity = useIdentity.getState().identity;
    if (identity) {
      try {
        const { rekeyGroupAfterRemoval } =
          require('../socket/client') as typeof import('../socket/client');
        await rekeyGroupAfterRemoval(identity, id, updated.members);
      } catch {
        // Swallow — removal already persisted locally and signed metadata
        // propagates via the normal group_msg path; re-key will retry later.
      }
    }
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
