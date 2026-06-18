/**
 * Group roles & permission resolution — PURE policy module.
 *
 * Decides "what role does this member have" and "may this member do X" from a
 * group's signed governance state. Depends only on types — no stores, no DB, no
 * crypto — so it is trivially testable and import-cycle-free.
 *
 * IMPORTANT (security honesty): these checks are CLIENT-SIDE UX/policy gates.
 * The relay is zero-metadata and knows nothing about roles, so it cannot enforce
 * them. A modified/malicious client could bypass can() and emit, e.g., a
 * call:invite anyway. The real cryptographic boundary remains group membership
 * (SenderKey / session). Treat can() as "hide/disable the button for honest
 * clients", never as a security guarantee.
 */
import type { GroupPermissions, PermissionScope } from './groupSig';

/** Four-level role hierarchy. owner > admin > mod > member. */
export type GroupRole = 'owner' | 'admin' | 'mod' | 'member';

/** Gated actions, one per configurable permission. */
export type GroupAction = 'invite' | 'send' | 'call' | 'editInfo';

/**
 * Default permissions for groups with no signed governance (legacy groups, and
 * the baseline a new group inherits). These match the prototype defaults and the
 * pre-governance behavior: only sending is open to everyone. Invites, calls and
 * info edits default to admins-only — invites/edits preserve the legacy
 * admin-only behavior. Calls default to 'everyone' because the Discord-style
 * channel model posts a join banner — it does NOT ring everyone — so any member
 * opening a channel is harmless. Admins can tighten this per group. Owners can
 * loosen any of these.
 */
export const DEFAULT_PERMISSIONS: GroupPermissions = {
  whoCanInvite: 'admins',
  whoCanSend: 'everyone',
  whoCanCall: 'everyone',
  whoCanEditInfo: 'admins',
};

/** Minimal shape needed to resolve roles — a subset of StoredGroup. */
export interface GovernanceState {
  /** aegisId of the creator/owner. Undefined on very old groups. */
  adminId?: string;
  /** Extra admins beyond the owner. */
  admins?: string[];
  /** Moderators. */
  moderators?: string[];
  /** Configured permissions; falls back to DEFAULT_PERMISSIONS when absent. */
  permissions?: GroupPermissions;
}

/**
 * Resolve a member's role within a group. The owner check wins over every other
 * set, so an owner accidentally also listed in admins/moderators still resolves
 * to 'owner'. Unknown members resolve to 'member' (the safe default).
 */
export function resolveRole(group: GovernanceState, aegisId: string): GroupRole {
  if (group.adminId && aegisId === group.adminId) return 'owner';
  if (group.admins?.includes(aegisId)) return 'admin';
  if (group.moderators?.includes(aegisId)) return 'mod';
  return 'member';
}

/** True when the role belongs to the privileged ('admins') audience. */
function isPrivileged(role: GroupRole): boolean {
  return role === 'owner' || role === 'admin' || role === 'mod';
}

/** Effective permissions, applying defaults for any unset governance. */
export function effectivePermissions(group: GovernanceState): GroupPermissions {
  return group.permissions ?? DEFAULT_PERMISSIONS;
}

const ACTION_TO_SCOPE: Record<GroupAction, keyof GroupPermissions> = {
  invite: 'whoCanInvite',
  send: 'whoCanSend',
  call: 'whoCanCall',
  editInfo: 'whoCanEditInfo',
};

/**
 * May `aegisId` perform `action` in `group`? Resolves the member's role, reads
 * the governing permission scope, and grants when the scope is 'everyone' or
 * the member is privileged. The owner can always do everything regardless of
 * configured scope (so an owner can never lock themselves out).
 */
export function can(group: GovernanceState, aegisId: string, action: GroupAction): boolean {
  const role = resolveRole(group, aegisId);
  if (role === 'owner') return true;
  const scope: PermissionScope = effectivePermissions(group)[ACTION_TO_SCOPE[action]];
  return scope === 'everyone' || isPrivileged(role);
}
