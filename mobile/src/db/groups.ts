import { withDb } from './core';
import type { GroupPermissions } from '../crypto/groupSig';

export interface StoredGroup {
  id: string;
  name: string;
  members: string[]; // array of aegisIds
  createdAt: number;
  avatarColor?: string;
  avatarImage?: string;
  adminOnlyInvite?: boolean;
  moderateNewMembers?: boolean;
  /** aegisId of the group creator — only this peer may rename / change members. */
  adminId?: string;
  /** Detached Ed25519 signature over {groupId, groupName, members, createdAt} by adminId. */
  adminSig?: string;
  /** aegisIds with moderator role (subset of members). */
  moderators?: string[];
  /** additional admin aegisIds beyond the creator. */
  admins?: string[];
  /**
   * Monotonic roster counter for the by-reference roster of large groups
   * (aegis.group.v2). Bumped on every membership change. Used by receivers to
   * decide whether a v2-content message carries a fresher or staler roster than
   * the locally-trusted one. Undefined on legacy rows → treated as 1.
   */
  rosterVersion?: number;
  /**
   * Configurable per-group permission gates (who can invite/send/call/edit).
   * Undefined → treat as DEFAULT_PERMISSIONS (see crypto/groupRoles.ts). Covered
   * by govSig so a member cannot forge them.
   */
  permissions?: GroupPermissions;
  /**
   * Detached Ed25519 signature by adminId over the governance state
   * (roles + permissions + govVersion) — see canonicalGroupGovBytes. Additive
   * and independent of adminSig; absent on legacy/pre-governance groups.
   */
  govSig?: string;
  /**
   * Monotonic governance counter, bumped on every role/permission change.
   * Defeats rollback of a signed governance state. Undefined → treated as 1.
   */
  govVersion?: number;
  /**
   * True while this group is an unaccepted invitation (the local user was added
   * but their privacy setting requires approval — see requireGroupApproval).
   * Pending groups are hidden from the active list and render no messages until
   * accepted. Undefined/false = a normal, joined group.
   */
  pending?: boolean;
}

type GroupRow = {
  id: string;
  name: string;
  members: string;
  created_at: number;
  avatar_color: string | null;
  avatar_image: string | null;
  admin_only_invite: number;
  moderate_new_members: number;
  admin_id: string | null;
  admin_sig: string | null;
  moderators: string | null;
  roster_version: number | null;
  permissions: string | null;
  gov_sig: string | null;
  gov_version: number | null;
  pending: number | null;
};

function rowToGroup(r: GroupRow): StoredGroup {
  return {
    id: r.id,
    name: r.name,
    members: JSON.parse(r.members),
    createdAt: r.created_at,
    avatarColor: r.avatar_color || undefined,
    avatarImage: r.avatar_image || undefined,
    adminOnlyInvite: r.admin_only_invite === 1,
    moderateNewMembers: r.moderate_new_members === 1,
    adminId: r.admin_id ?? undefined,
    adminSig: r.admin_sig ?? undefined,
    moderators: r.moderators ? (JSON.parse(r.moderators) as string[]) : undefined,
    rosterVersion: r.roster_version ?? undefined,
    permissions: r.permissions ? (JSON.parse(r.permissions) as GroupPermissions) : undefined,
    govSig: r.gov_sig ?? undefined,
    govVersion: r.gov_version ?? undefined,
    pending: r.pending === 1 ? true : undefined,
  };
}

const GROUP_SELECT = `SELECT id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig, moderators, roster_version, permissions, gov_sig, gov_version, pending`;

export async function saveGroup(g: StoredGroup): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO groups (id, name, members, created_at, avatar_color, avatar_image, admin_only_invite, moderate_new_members, admin_id, admin_sig, moderators, roster_version, permissions, gov_sig, gov_version, pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      g.id,
      g.name,
      JSON.stringify(g.members),
      g.createdAt,
      g.avatarColor || null,
      g.avatarImage || null,
      g.adminOnlyInvite !== false ? 1 : 0,
      g.moderateNewMembers ? 1 : 0,
      g.adminId ?? null,
      g.adminSig ?? null,
      g.moderators && g.moderators.length > 0 ? JSON.stringify(g.moderators) : null,
      g.rosterVersion ?? null,
      g.permissions ? JSON.stringify(g.permissions) : null,
      g.govSig ?? null,
      g.govVersion ?? null,
      g.pending ? 1 : null
    );
  });
}

export async function loadGroups(): Promise<StoredGroup[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<GroupRow>(
      `${GROUP_SELECT} FROM groups ORDER BY created_at DESC`
    );
    return rows.map(rowToGroup);
  });
}

export async function deleteGroup(id: string): Promise<void> {
  await withDb(async (d) => {
    await d.runAsync('DELETE FROM groups WHERE id = ?', id);
  });
  // Clean up the persistent avatar file copied on group creation (all possible extensions).
  const FS = require('expo-file-system/legacy') as typeof import('expo-file-system/legacy');
  for (const ext of ['jpg', 'jpeg', 'png', 'webp']) {
    await FS.deleteAsync(
      `${FS.documentDirectory}avatars/group_${id}_avatar.${ext}`,
      { idempotent: true },
    ).catch(() => {});
  }
}

export async function getGroup(id: string): Promise<StoredGroup | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<GroupRow>(
      `${GROUP_SELECT} FROM groups WHERE id = ?`,
      id
    );
    if (!row) return null;
    return rowToGroup(row);
  });
}
