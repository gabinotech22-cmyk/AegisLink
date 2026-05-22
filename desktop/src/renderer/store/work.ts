import { create } from 'zustand';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { SERVER_URL } from '../config';

// ─── Admin signature helpers ──────────────────────────────────────────────────

function getSigningSecretKeyB64(): string | null {
  const { useIdentity } = require('./identity') as { useIdentity: { getState: () => { identity: { signingSecretKeyB64: string } | null } } };
  return useIdentity.getState().identity?.signingSecretKeyB64 ?? null;
}

/**
 * Sign an admin action so the relay can verify it.
 * Message: `${orgId}:${action}:${Math.floor(ts / 30_000)}`
 */
function signAdminAction(orgId: string, action: string): { sig: string; ts: number } | null {
  const skB64 = getSigningSecretKeyB64();
  if (!skB64) return null;
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const message = new TextEncoder().encode(`${orgId}:${action}:${timeBucket}`);
  const sigBytes = nacl.sign.detached(message, decodeBase64(skB64));
  return { sig: encodeBase64(sigBytes), ts };
}

function adminQueryString(orgId: string, action: string, requesterId: string): string {
  const s = signAdminAction(orgId, action);
  if (!s) return `aegisId=${encodeURIComponent(requesterId)}`;
  return `aegisId=${encodeURIComponent(requesterId)}&sig=${encodeURIComponent(s.sig)}&ts=${s.ts}`;
}

export interface WorkMember {
  org_id: string;
  aegis_id: string;
  team: string;
  role: 'owner' | 'admin' | 'member';
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
  orgId: string;
  kind: string;
  message: string;
  actorId: string | null;
  targetId: string | null;
  channelId: string | null;
  metadata: Record<string, unknown> | null;
  createdAt: number;
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

export interface WorkChannel {
  channelId: string;
  orgId: string;
  name: string;
  isAnnouncements: boolean;
  createdAt: number;
}

export interface ChannelPermission {
  role: 'owner' | 'admin' | 'member';
  canSend: boolean;
  canReact: boolean;
  canUpload: boolean;
}

interface WorkState {
  org: WorkOrg | null;
  members: WorkMember[];
  devices: WorkDevice[];
  auditLog: WorkAuditEntry[];
  auditHasMore: boolean;
  auditLoading: boolean;
  auditFilters: { kind: string | null; actorId: string | null };
  channels: WorkChannel[];
  loading: boolean;
  error: string | null;

  knownOrgIds: string[];
  activeOrgId: string | null;

  fetchOrg: (orgId: string, requesterId: string) => Promise<void>;
  fetchAuditPage: (orgId: string, opts?: { before?: number; kind?: string; actorId?: string }) => Promise<void>;
  setAuditFilters: (filters: { kind: string | null; actorId: string | null }) => void;
  createOrg: (name: string, adminId: string) => Promise<string>;
  fetchChannels: (orgId: string) => Promise<void>;
  createChannel: (orgId: string, name: string, adminId: string, isAnnouncements?: boolean) => Promise<string>;
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
  patchMember: (orgId: string, aegisId: string, role: 'admin' | 'member', requesterId: string) => Promise<void>;
  clear: () => void;

  channelPermissions: Record<string, ChannelPermission[]>;
  fetchChannelPermissions: (orgId: string, channelId: string) => Promise<void>;
  setChannelPermissionsOptimistic: (channelId: string, perms: ChannelPermission[]) => void;

  loadKnownOrgs: () => void;
  addKnownOrg: (orgId: string) => void;
  removeKnownOrg: (orgId: string) => void;
  switchWorkspace: (orgId: string, requesterId: string) => Promise<void>;
}

function mapAuditEntry(raw: Record<string, unknown>): WorkAuditEntry {
  return {
    id: String(raw['id'] ?? raw['_id'] ?? ''),
    orgId: String(raw['org_id'] ?? raw['orgId'] ?? ''),
    kind: String(raw['kind'] ?? 'info'),
    message: String(raw['message'] ?? raw['action'] ?? ''),
    actorId: (raw['actor_id'] ?? raw['actorId'] ?? null) as string | null,
    targetId: (raw['target_id'] ?? raw['targetId'] ?? null) as string | null,
    channelId: (raw['channel_id'] ?? raw['channelId'] ?? null) as string | null,
    metadata: (raw['metadata'] as Record<string, unknown> | null) ?? null,
    createdAt: Number(raw['created_at'] ?? raw['createdAt'] ?? raw['ts'] ?? 0),
  };
}

export const useWork = create<WorkState>((set, get) => ({
  org: null,
  members: [],
  devices: [],
  auditLog: [],
  auditHasMore: false,
  auditLoading: false,
  auditFilters: { kind: null, actorId: null },
  channels: [],
  loading: false,
  error: null,
  knownOrgIds: [],
  activeOrgId: null,
  channelPermissions: {},

  async fetchOrg(orgId, requesterId) {
    set({ loading: true, error: null });
    try {
      const [orgRes, membersRes, devicesRes, auditRes] = await Promise.all([
        fetch(`${SERVER_URL}/work/org/${orgId}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/members?${adminQueryString(orgId, 'list_members', requesterId)}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/devices?${adminQueryString(orgId, 'list_devices', requesterId)}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/audit?${adminQueryString(orgId, 'list_audit', requesterId)}&limit=50`),
      ]);
      if (!orgRes.ok) throw new Error('Org not found');
      const org: WorkOrg = await orgRes.json();
      const { members } = membersRes.ok ? await membersRes.json() : { members: [] };
      const { devices } = devicesRes.ok ? await devicesRes.json() : { devices: [] };
      const auditData = auditRes.ok ? await auditRes.json() : { log: [] };
      const rawLog: Record<string, unknown>[] = Array.isArray(auditData.log) ? auditData.log as Record<string, unknown>[] : [];
      const auditLog = rawLog.map(mapAuditEntry);
      set({ org, members, devices, auditLog, auditHasMore: rawLog.length >= 50, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  async fetchAuditPage(orgId, opts = {}) {
    const requesterId = (() => {
      const { useIdentity } = require('./identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
      return useIdentity.getState().identity?.aegisId ?? '';
    })();
    set({ auditLoading: true });
    try {
      const params = new URLSearchParams(adminQueryString(orgId, 'list_audit', requesterId));
      params.set('limit', '50');
      if (opts.before !== undefined) params.set('before', String(opts.before));
      if (opts.kind) params.set('kind', opts.kind);
      if (opts.actorId) params.set('actorId', opts.actorId);
      const res = await fetch(`${SERVER_URL}/work/org/${orgId}/audit?${params.toString()}`);
      if (!res.ok) throw new Error('Failed to fetch audit');
      const data = (await res.json()) as { log?: Record<string, unknown>[] };
      const rawLog: Record<string, unknown>[] = Array.isArray(data.log) ? data.log : [];
      const newEntries = rawLog.map(mapAuditEntry);
      const isFirstPage = opts.before === undefined;
      set((s) => ({
        auditLog: isFirstPage ? newEntries : [...s.auditLog, ...newEntries],
        auditHasMore: rawLog.length >= 50,
        auditLoading: false,
      }));
    } catch {
      set({ auditLoading: false });
    }
  },

  setAuditFilters(filters) {
    set({ auditFilters: filters });
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
    get().addKnownOrg(orgId as string);
    await get().fetchOrg(orgId, adminId);
    // Auto-create default channels — non-fatal if server doesn't support it yet
    await Promise.allSettled([
      get().createChannel(orgId, 'general', adminId, false),
      get().createChannel(orgId, 'comunicados', adminId, true),
    ]);
    return orgId as string;
  },

  async fetchChannels(orgId) {
    try {
      const res = await fetch(`${SERVER_URL}/work/org/${orgId}/channels`);
      if (!res.ok) throw new Error('not found');
      const { channels } = await res.json();
      set({ channels: channels as WorkChannel[] });
    } catch {
      // Fallback: show a local #general channel so UI is never empty
      set({
        channels: [
          { channelId: `${orgId}-general`, orgId, name: 'general', isAnnouncements: false, createdAt: Date.now() },
          { channelId: `${orgId}-comunicados`, orgId, name: 'comunicados', isAnnouncements: true, createdAt: Date.now() },
        ],
      });
    }
  },

  async createChannel(orgId, name, adminId, isAnnouncements = false) {
    try {
      const res = await fetch(`${SERVER_URL}/work/org/${orgId}/channels`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, adminId, isAnnouncements }),
      });
      if (!res.ok) throw new Error('Failed to create channel');
      const { channelId } = await res.json();
      const newChannel: WorkChannel = { channelId: channelId as string, orgId, name, isAnnouncements, createdAt: Date.now() };
      set((s) => ({ channels: [...s.channels, newChannel] }));
      return channelId as string;
    } catch {
      // Store locally if server doesn't support endpoint yet
      const channelId = `${orgId}-${name}-${Date.now()}`;
      const newChannel: WorkChannel = { channelId, orgId, name, isAnnouncements, createdAt: Date.now() };
      set((s) => ({ channels: [...s.channels.filter((c) => c.name !== name), newChannel] }));
      return channelId;
    }
  },

  async createInvite(orgId, requesterId, team, role) {
    const adminSig = signAdminAction(orgId, 'create_invite');
    if (!adminSig) throw new Error('Identity not loaded — cannot sign invite');
    const res = await fetch(`${SERVER_URL}/work/org/${orgId}/invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aegisId: requesterId, sig: adminSig.sig, ts: adminSig.ts, team, role }),
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
    get().addKnownOrg(data.orgId as string);
    return { orgId: data.orgId as string, team: data.team as string };
  },

  async revokeDevice(orgId, deviceId, requesterId) {
    const adminSig = signAdminAction(orgId, 'set_device_status');
    if (!adminSig) throw new Error('Identity not loaded');
    const res = await fetch(`${SERVER_URL}/work/org/${orgId}/device/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aegisId: requesterId, sig: adminSig.sig, ts: adminSig.ts, status: 'revoked' }),
    });
    if (!res.ok) throw new Error('Failed to revoke device');
    set((s) => ({
      devices: s.devices.map((d) => (d.device_id === deviceId ? { ...d, status: 'revoked' as const } : d)),
    }));
  },

  async verifyDevice(orgId, deviceId, requesterId) {
    const adminSig = signAdminAction(orgId, 'set_device_status');
    if (!adminSig) throw new Error('Identity not loaded');
    const res = await fetch(`${SERVER_URL}/work/org/${orgId}/device/${deviceId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aegisId: requesterId, sig: adminSig.sig, ts: adminSig.ts, status: 'verified' }),
    });
    if (!res.ok) throw new Error('Failed to verify device');
    set((s) => ({
      devices: s.devices.map((d) => (d.device_id === deviceId ? { ...d, status: 'verified' as const } : d)),
    }));
  },

  async patchMember(orgId, aegisId, role, requesterId) {
    const adminSig = signAdminAction(orgId, 'patch_member');
    if (!adminSig) throw new Error('Identity not loaded');
    const res = await fetch(`${SERVER_URL}/work/org/${orgId}/members/${aegisId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aegisId: requesterId, sig: adminSig.sig, ts: adminSig.ts, role }),
    });
    if (!res.ok) throw new Error('Failed to update member role');
    set((s) => ({
      members: s.members.map((m) => (m.aegis_id === aegisId ? { ...m, role } : m)),
    }));
  },

  async removeMember(orgId, aegisId, requesterId) {
    const adminSig = signAdminAction(orgId, 'remove_member');
    if (!adminSig) throw new Error('Identity not loaded');
    const query = `aegisId=${encodeURIComponent(requesterId)}&sig=${encodeURIComponent(adminSig.sig)}&ts=${adminSig.ts}`;
    const res = await fetch(
      `${SERVER_URL}/work/org/${orgId}/members/${aegisId}?${query}`,
      { method: 'DELETE' },
    );
    if (!res.ok) throw new Error('Failed to remove member');
    set((s) => ({ members: s.members.filter((m) => m.aegis_id !== aegisId) }));
  },

  async fetchChannelPermissions(orgId, channelId) {
    try {
      const res = await fetch(`${SERVER_URL}/work/org/${orgId}/channels/${channelId}/permissions`);
      if (!res.ok) return;
      const data = (await res.json()) as { permissions?: ChannelPermission[] };
      const perms = Array.isArray(data.permissions) ? data.permissions : [];
      set((s) => ({ channelPermissions: { ...s.channelPermissions, [channelId]: perms } }));
    } catch {
      // offline — keep existing
    }
  },

  setChannelPermissionsOptimistic(channelId, perms) {
    set((s) => ({ channelPermissions: { ...s.channelPermissions, [channelId]: perms } }));
  },

  clear() {
    set({ org: null, members: [], devices: [], auditLog: [], auditHasMore: false, auditLoading: false, auditFilters: { kind: null, actorId: null }, channels: [], loading: false, error: null, channelPermissions: {} });
  },

  loadKnownOrgs() {
    const old = localStorage.getItem('aegis.work.orgId');
    const raw = localStorage.getItem('aegis.work.orgIds');
    let ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (old && !ids.includes(old)) {
      ids = [...ids, old];
      localStorage.setItem('aegis.work.orgIds', JSON.stringify(ids));
      localStorage.removeItem('aegis.work.orgId');
    }
    const activeId = localStorage.getItem('aegis.work.activeOrgId') ?? ids[0] ?? null;
    set({ knownOrgIds: ids, activeOrgId: activeId });
  },

  addKnownOrg(orgId) {
    const raw = localStorage.getItem('aegis.work.orgIds');
    const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!ids.includes(orgId)) {
      const updated = [...ids, orgId];
      localStorage.setItem('aegis.work.orgIds', JSON.stringify(updated));
    }
    localStorage.setItem('aegis.work.activeOrgId', orgId);
    set((s) => ({ knownOrgIds: [...new Set([...s.knownOrgIds, orgId])], activeOrgId: orgId }));
  },

  removeKnownOrg(orgId) {
    const raw = localStorage.getItem('aegis.work.orgIds');
    const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const updated = ids.filter((id) => id !== orgId);
    localStorage.setItem('aegis.work.orgIds', JSON.stringify(updated));
    const newActive = updated[0] ?? null;
    if (newActive) localStorage.setItem('aegis.work.activeOrgId', newActive);
    else localStorage.removeItem('aegis.work.activeOrgId');
    set((s) => ({ knownOrgIds: updated, activeOrgId: s.activeOrgId === orgId ? newActive : s.activeOrgId }));
  },

  async switchWorkspace(orgId, requesterId) {
    localStorage.setItem('aegis.work.activeOrgId', orgId);
    set({ activeOrgId: orgId });
    await get().fetchOrg(orgId, requesterId);
    await get().fetchChannels(orgId);
  },
}));
