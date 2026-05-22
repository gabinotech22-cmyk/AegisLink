// ─── Work role-based permissions ─────────────────────────────────────────────

export type WorkRole = 'owner' | 'admin' | 'member';

export interface WorkPermissions {
  canManageMembers: boolean;
  canCreateChannels: boolean;
  canDeleteChannels: boolean;
  canPinMessages: boolean;
  canSendAnnouncements: boolean;
  canInvite: boolean;
  canKickMembers: boolean;
  canPromoteToAdmin: boolean;
  canDemoteAdmin: boolean;
  canDeleteOrg: boolean;
}

const OWNER_PERMISSIONS: WorkPermissions = {
  canManageMembers: true,
  canCreateChannels: true,
  canDeleteChannels: true,
  canPinMessages: true,
  canSendAnnouncements: true,
  canInvite: true,
  canKickMembers: true,
  canPromoteToAdmin: true,
  canDemoteAdmin: true,
  canDeleteOrg: true,
};

const ADMIN_PERMISSIONS: WorkPermissions = {
  canManageMembers: true,
  canCreateChannels: true,
  canDeleteChannels: false,
  canPinMessages: true,
  canSendAnnouncements: true,
  canInvite: true,
  canKickMembers: true,
  canPromoteToAdmin: false,
  canDemoteAdmin: false,
  canDeleteOrg: false,
};

const MEMBER_PERMISSIONS: WorkPermissions = {
  canManageMembers: false,
  canCreateChannels: false,
  canDeleteChannels: false,
  canPinMessages: false,
  canSendAnnouncements: false,
  canInvite: false,
  canKickMembers: false,
  canPromoteToAdmin: false,
  canDemoteAdmin: false,
  canDeleteOrg: false,
};

export function getPermissions(role: WorkRole): WorkPermissions {
  switch (role) {
    case 'owner': return OWNER_PERMISSIONS;
    case 'admin': return ADMIN_PERMISSIONS;
    case 'member': return MEMBER_PERMISSIONS;
  }
}
