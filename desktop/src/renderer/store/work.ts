import { create } from 'zustand';
import { SERVER_URL } from '../config';

export interface WorkMember {
  org_id: string;
  aegis_id: string;
  team: string;
  role: 'admin' | 'member';
  joined_at: number;
  verified?: boolean;
}

export interface WorkDevice {
  device_id: string;
  org_id: string;
  aegis_id: string;
  name: string;
  /** Alias for `name` — legacy field used by some screens */
  device_name?: string;
  platform: string;
  status: 'pending' | 'verified' | 'revoked';
  last_seen: number;
  enrolled_at: number;
}

export interface WorkAuditEntry {
  id: string;
  org_id: string;
  kind: 'info' | 'warn' | 'ok';
  message: string;
  created_at: number;
  /** Alias for `created_at` — legacy field used by some screens */
  ts?: number;
  /** Alias for `message` — legacy field used by some screens */
  action?: string;
}

export interface WorkOrg {
  orgId: string;
  name: string;
  adminId: string;
  policyKeyRotationDays: number;
  createdAt: number;
  stats: {
    memberCount: number;
    deviceCount: number;
    verifiedDevices: number;
    pendingDevices: number;
  };
}

interface WorkState {
  org: WorkOrg | null;
  members: WorkMember[];
  devices: WorkDevice[];
  auditLog: WorkAuditEntry[];
  loading: boolean;
  error: string | null;

  fetchOrg: (orgId: string, requesterId: string) => Promise<void>;
  createOrg: (name: string, adminId: string) => Promise<string>;
  createInvite: (orgId: string, requesterId: string, team: string, role: 'admin' | 'member') => Promise<string>;
  joinOrg: (
    token: string,
    aegisId: string,
    deviceId: string,
    deviceName: string,
    platform: string,
  ) => Promise<{ orgId: string; team: string }>;
  revokeDevice: (orgId: string, deviceId: string, requesterId: string) => Promise<void>;
  verifyDevice: (orgId: string, deviceId: string, requesterId: string) => Promise<void>;
  removeMember: (orgId: string, aegisId: string, requesterId: string) => Promise<void>;
  clear: () => void;
}

export const useWork = create<WorkState>((set, get) => ({
  org: null,
  members: [],
  devices: [],
  auditLog: [],
  loading: false,
  error: null,

  async fetchOrg(orgId, requesterId) {
    set({ loading: true, error: null });
    try {
      const [orgRes, membersRes, devicesRes, auditRes] = await Promise.all([
        fetch(`${SERVER_URL}/work/org/${orgId}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/members?requesterId=${encodeURIComponent(requesterId)}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/devices?requesterId=${encodeURIComponent(requesterId)}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/audit?requesterId=${encodeURIComponent(requesterId)}&limit=50`),
      ]);
      if (!orgRes.ok) throw new Error('Org not found');
      const org: WorkOrg = await orgRes.json();
      const { members } = membersRes.ok ? await membersRes.json() : { members: [] };
      const { devices } = devicesRes.ok ? await devicesRes.json() : { devices: [] };
      const { log } = auditRes.ok ? await auditRes.json() : { log: [] };
      set({ org, members, devices, auditLog: log, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  async createOrg(name, adminId) {
    set({ loading: true, error: null });
    const res = await fetch(`${SERVER_URL}/work/org`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, adminId }),
    });
    if (!res.ok) {
      set({ loading: false, error: 'Failed to create org' });
      throw new Error('Failed to create org');
    }
    const { orgId } = await res.json();
    set({ loading: false });
    await get().fetchOrg(orgId, adminId);
    return orgId as string;
  },

  async createInvite(orgId, requesterId, team, role) {
    const res = await fetch(`${SERVER_URL}/work/org/${orgId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ createdBy: requesterId, team, role }),
    });
    if (!res.ok) throw new Error('Failed to create invite');
    const { token } = await res.json();
    return token as string;
  },

  async joinOrg(token, aegisId, deviceId, deviceName, platform) {
    const res = await fetch(`${SERVER_URL}/work/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, aegisId, deviceId, deviceName, platform }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'unknown' }));
      throw new Error((err as { error: string }).error ?? 'Failed to join org');
    }
    const data = await res.json();
    return { orgId: data.orgId as string, team: data.team as string };
  },

  async revokeDevice(orgId, deviceId, requesterId) {
    const res = await fetch(`${SERVER_URL}/work/org/${orgId}/device/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'revoked', requesterId }),
    });
    if (!res.ok) throw new Error('Failed to revoke device');
    set((s) => ({
      devices: s.devices.map((d) => (d.device_id === deviceId ? { ...d, status: 'revoked' as const } : d)),
    }));
  },

  async verifyDevice(orgId, deviceId, requesterId) {
    const res = await fetch(`${SERVER_URL}/work/org/${orgId}/device/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'verified', requesterId }),
    });
    if (!res.ok) throw new Error('Failed to verify device');
    set((s) => ({
      devices: s.devices.map((d) => (d.device_id === deviceId ? { ...d, status: 'verified' as const } : d)),
    }));
  },

  async removeMember(orgId, aegisId, requesterId) {
    const res = await fetch(
      `${SERVER_URL}/work/org/${orgId}/members/${aegisId}?requesterId=${encodeURIComponent(requesterId)}`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error('Failed to remove member');
    set((s) => ({ members: s.members.filter((m) => m.aegis_id !== aegisId) }));
  },

  clear() {
    set({ org: null, members: [], devices: [], auditLog: [], loading: false, error: null });
  },
}));
