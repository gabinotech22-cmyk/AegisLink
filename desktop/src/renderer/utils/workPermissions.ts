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

export function getPermissions(role: WorkRole): WorkPermissions {
  switch (role) {
    case 'owner':
      return {
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
    case 'admin':
      return {
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
    case 'member':
      return {
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
  }
}
