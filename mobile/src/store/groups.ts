import { create } from 'zustand';
import nacl from 'tweetnacl';
import { decodeBase64, encodeBase64 } from 'tweetnacl-util';
import {
  computeRosterHash,
  canonicalGroupBytes,
  canonicalGroupBytesV2,
  signGroupGovernance,
  type GroupPermissions,
} from '../crypto/groupSig';
import { effectivePermissions } from '../crypto/groupRoles';
import {
  loadGroups,
  saveGroup,
  deleteGroup,
  deleteContactMessages,
  type StoredGroup,
} from '../db/local';

// Re-export the canonical roster hash so existing importers (e.g. tests in
// store/__tests__/groups.largeRoster.test.ts) keep resolving it from here.
export { computeRosterHash } from '../crypto/groupSig';

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

/**
 * Sign the group's governance state (roles + permissions) with the active
 * identity's Ed25519 signing key, bumping govVersion. ONLY the owner (adminId)
 * may produce a governance signature peers will accept; returns null for anyone
 * else (or if no identity is loaded), leaving govSig untouched.
 *
 * Independent of signAsAdmin: this signs canonicalGroupGovBytes, never the
 * roster bytes, so it can be re-issued on a permission/role change without
 * touching the roster signature (and vice-versa).
 */
function signGovernance(
  group: StoredGroup,
): { govSig: string; govVersion: number; permissions: GroupPermissions } | null {
  const { useIdentity } = require('./identity') as typeof import('./identity');
  const id = useIdentity.getState().identity;
  if (!id || !group.adminId || id.aegisId !== group.adminId) return null;
  const permissions = effectivePermissions(group);
  const govVersion = (group.govVersion ?? 0) + 1;
  const govSig = signGroupGovernance(
    {
      groupId: group.id,
      ownerId: group.adminId,
      admins: group.admins ?? [],
      moderators: group.moderators ?? [],
      permissions,
      govVersion,
    },
    id.signingSecretKey,
  );
  return { govSig, govVersion, permissions };
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
  /**
   * Owner-only: change one or more permission gates. Re-signs the governance
   * state (bumps govVersion) so the change is tamper-evident. No-op for
   * non-owners (the UI hides the controls anyway).
   */
  setGroupPermission: (id: string, patch: Partial<GroupPermissions>) => Promise<void>;
  /**
   * Owner-only: promote/demote a member to admin, moderator or plain member.
   * Updates the admins/moderators sets, re-signs governance (bumps govVersion)
   * and broadcasts so peers' rosters reflect the new role. The owner cannot be
   * targeted (the creator's role is immutable). No-op for non-owners.
   */
  setMemberRole: (id: string, aegisId: string, role: 'admin' | 'mod' | 'member') => Promise<void>;
  /** Accept a pending group invitation — clears the pending flag so the group
   *  joins the active list and starts rendering messages. */
  acceptGroupInvite: (id: string) => Promise<void>;
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
    const signed: StoredGroup = sig ? { ...base, ...sig } : base;
    // Sign initial governance (default permissions, govVersion 1) so the owner's
    // group carries a verifiable roles/permissions state from creation. Requires
    // adminId, which signAsAdmin just set.
    const gov = signGovernance(signed);
    const newGroup: StoredGroup = gov
      ? { ...signed, permissions: gov.permissions, govSig: gov.govSig, govVersion: gov.govVersion }
      : signed;
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

    // Welcome the new member: push the full-roster metadata carrier so THEIR
    // client materializes the group locally (the `createGroup` decision in
    // socket/client.ts only fires on a carrier that ships the member list).
    // Without this the admin lists the member but the group never appears for
    // them — content messages alone are dropped ("await the carrier") in v2 and
    // there is no guarantee the next message is a roster-bearing one. This is
    // the missing counterpart to removeMember's re-key.
    //
    // Offline-safe: broadcastGroupMetadata -> sendGroupMessage enqueues per-member
    // outbox jobs, so the welcome is retried on the next reconnect if we are
    // offline right now.
    const { useIdentity } = require('./identity') as typeof import('./identity');
    const identity = useIdentity.getState().identity;
    if (identity) {
      try {
        const { broadcastGroupMetadata } =
          require('../socket/client') as typeof import('../socket/client');
        await broadcastGroupMetadata(identity, id);
      } catch {
        // Best-effort: the carrier re-sends from the outbox on the next reconnect.
      }
    }
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
        // Swallow — removal already persisted locally; re-key retries later.
      }
      // Propagate the new roster to the REMAINING members so their member list
      // drops the removed person immediately. Without this the admin saw the
      // removal but everyone else kept showing the old roster until some future
      // carrier happened to arrive (and v2 content messages omit the member
      // list entirely). Symmetric to addMember's welcome carrier. The removed
      // member is no longer in updated.members, so the broadcast never reaches
      // them. Offline-safe via the outbox.
      try {
        const { broadcastGroupMetadata } =
          require('../socket/client') as typeof import('../socket/client');
        await broadcastGroupMetadata(identity, id);
      } catch {
        // Best-effort: the carrier re-sends from the outbox on the next reconnect.
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

  async setGroupPermission(id, patch) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    const permissions: GroupPermissions = { ...effectivePermissions(group), ...patch };
    const withPerms: StoredGroup = { ...group, permissions };
    // Re-sign governance (owner only). signGovernance reads the updated
    // permissions off withPerms and returns the bumped version + signature.
    const gov = signGovernance(withPerms);
    const updated: StoredGroup = gov
      ? { ...withPerms, govSig: gov.govSig, govVersion: gov.govVersion }
      : withPerms;
    await saveGroup(updated);
    set({ groups: get().groups.map((g) => (g.id === id ? updated : g)) });
  },

  async setMemberRole(id, aegisId, role) {
    const group = get().groups.find((g) => g.id === id);
    if (!group) return;
    const { useIdentity } = require('./identity') as typeof import('./identity');
    const me = useIdentity.getState().identity;
    // Owner-only, and the owner's own role is immutable.
    if (!me || me.aegisId !== group.adminId || aegisId === group.adminId) return;

    const admins = new Set(group.admins ?? []);
    const moderators = new Set(group.moderators ?? []);
    // A member holds at most one of admin/mod — clear both, then set the target.
    admins.delete(aegisId);
    moderators.delete(aegisId);
    if (role === 'admin') admins.add(aegisId);
    else if (role === 'mod') moderators.add(aegisId);

    const withRoles: StoredGroup = {
      ...group,
      admins: admins.size ? [...admins] : undefined,
      moderators: moderators.size ? [...moderators] : undefined,
    };
    const gov = signGovernance(withRoles);
    const updated: StoredGroup = gov
      ? { ...withRoles, permissions: gov.permissions, govSig: gov.govSig, govVersion: gov.govVersion }
      : withRoles;
    await saveGroup(updated);
    set({ groups: get().groups.map((g) => (g.id === id ? updated : g)) });

    // Propagate the new governance to members via the metadata carrier (which
    // now ships govSig/govVersion). Offline-safe: re-sends from the outbox.
    try {
      const client = require('../socket/client') as typeof import('../socket/client');
      await client.broadcastGroupMetadata(me, id);
    } catch { /* non-fatal — change still rides the admin's next group message */ }
  },

  async acceptGroupInvite(id) {
    const group = get().groups.find((g) => g.id === id);
    if (!group || !group.pending) return;
    const updated: StoredGroup = { ...group, pending: undefined };
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
