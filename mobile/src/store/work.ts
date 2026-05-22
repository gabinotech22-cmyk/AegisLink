import { create } from 'zustand';
import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { SERVER_URL } from '../config';

// ---------------------------------------------------------------------------
// Workspace name encryption helpers
//
// The org name is encrypted client-side before being sent to the relay, so
// the server never sees plaintext workspace names. The key is derived from
// the user's X25519 secretKey + a fixed domain tag — no extra key material
// is needed, and decryption is fully deterministic from the identity.
//
// Cipher: XSalsa20-Poly1305 (NaCl secretbox), 32-byte key, 24-byte nonce.
// Format sent to server: base64(nonce || ciphertext)
// ---------------------------------------------------------------------------

const DOMAIN_TAG = new TextEncoder().encode('aegis.work.orgname.v1');

function deriveOrgNameKey(secretKeyB64: string): Uint8Array {
  const sk = decodeBase64(secretKeyB64);
  // SHA-256(domain_tag || secretKey) → 32-byte symmetric key
  const material = new Uint8Array(DOMAIN_TAG.length + sk.length);
  material.set(DOMAIN_TAG, 0);
  material.set(sk, DOMAIN_TAG.length);
  return sha256(material);
}

/** Encrypt a plaintext org name → base64(nonce || ciphertext). */
function encryptOrgName(name: string, secretKeyB64: string): string {
  const key = deriveOrgNameKey(secretKeyB64);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const ct = nacl.secretbox(new TextEncoder().encode(name), nonce, key);
  const out = new Uint8Array(nonce.length + ct.length);
  out.set(nonce, 0);
  out.set(ct, nonce.length);
  return encodeBase64(out);
}

/** Decrypt base64(nonce || ciphertext) → plaintext org name. Returns null on failure. */
function decryptOrgName(encrypted: string, secretKeyB64: string): string | null {
  try {
    const key = deriveOrgNameKey(secretKeyB64);
    const data = decodeBase64(encrypted);
    const nonce = data.slice(0, nacl.secretbox.nonceLength);
    const ct = data.slice(nacl.secretbox.nonceLength);
    const pt = nacl.secretbox.open(ct, nonce, key);
    if (!pt) return null;
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

/** Get the own identity's secretKeyB64 from the identity store (sync, no import cycle). */
function getOwnSecretKeyB64(): string | null {
  // Lazy require to avoid circular imports at module load time
  const { useIdentity } = require('./identity') as { useIdentity: { getState: () => { identity: { secretKeyB64: string } | null } } };
  return useIdentity.getState().identity?.secretKeyB64 ?? null;
}

/** Get the own identity's signingSecretKeyB64 from the identity store (sync). */
function getSigningSecretKeyB64(): string | null {
  const { useIdentity } = require('./identity') as { useIdentity: { getState: () => { identity: { signingSecretKeyB64: string } | null } } };
  return useIdentity.getState().identity?.signingSecretKeyB64 ?? null;
}

/**
 * Sign an admin action so the server can verify it.
 * Message format mirrors server: `${orgId}:${action}:${timeBucket}`
 * Returns { sig, ts } ready to spread into the request body.
 */
export function signAdminAction(orgId: string, action: string): { sig: string; ts: number } | null {
  const skB64 = getSigningSecretKeyB64();
  if (!skB64) return null;
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const message = new TextEncoder().encode(`${orgId}:${action}:${timeBucket}`);
  const sigBytes = nacl.sign.detached(message, decodeBase64(skB64));
  return { sig: encodeBase64(sigBytes), ts };
}

/** Try to decrypt an org name from the server; falls back to the raw value if decryption fails
 *  (supports plaintext org names from orgs created before encryption was added). */
function maybeDecryptOrgName(nameFromServer: string): string {
  const sk = getOwnSecretKeyB64();
  if (!sk) return nameFromServer;
  return decryptOrgName(nameFromServer, sk) ?? nameFromServer;
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WorkMember {
  org_id: string;
  aegis_id: string;
  team: string;
  role: 'owner' | 'admin' | 'member';
  joined_at: number;
}

export interface ChannelPermission {
  channelId: string;
  role: import('../utils/workPermissions').WorkRole;
  canSend: boolean;
  canReact: boolean;
  canUpload: boolean;
}

export interface WorkDevice {
  device_id: string;
  org_id: string;
  aegis_id: string;
  name: string;
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

interface WorkState {
  org: WorkOrg | null;
  members: WorkMember[];
  devices: WorkDevice[];
  auditLog: WorkAuditEntry[];
  channels: WorkChannel[];
  /** Channel permissions keyed by channelId. Each array has one entry per role. */
  channelPermissions: Record<string, ChannelPermission[]>;
  loading: boolean;
  error: string | null;
  auditHasMore: boolean;
  auditLoading: boolean;
  auditFilters: { kind: string | null; actorId: string | null };

  /** All org IDs the user belongs to (persisted in SecureStore). */
  knownOrgIds: string[];
  /** The org ID currently loaded/active. */
  activeOrgId: string | null;

  // Actions
  fetchAuditPage: (orgId: string, opts?: { before?: number; kind?: string; actorId?: string }) => Promise<void>;
  setAuditFilters: (filters: { kind: string | null; actorId: string | null }) => Promise<void>;
  fetchChannelPermissions: (orgId: string, channelId: string) => Promise<void>;
  fetchOrg: (orgId: string, requesterId: string) => Promise<void>;
  createOrg: (name: string, adminId: string) => Promise<string>;
  fetchChannels: (orgId: string) => Promise<void>;
  createChannel: (orgId: string, name: string, adminId: string, isAnnouncements?: boolean) => Promise<string>;
  createInvite: (orgId: string, requesterId: string, team: string, role: 'admin' | 'member') => Promise<string>;
  joinOrg: (token: string, aegisId: string, deviceId: string, deviceName: string, platform: string) => Promise<{ orgId: string; team: string }>;
  revokeDevice: (orgId: string, deviceId: string, requesterId: string) => Promise<void>;
  verifyDevice: (orgId: string, deviceId: string, requesterId: string) => Promise<void>;
  removeMember: (orgId: string, aegisId: string, requesterId: string) => Promise<void>;
  /** Remove self from the org and wipe local org state + SecureStore entries. */
  leaveWorkspace: (orgId: string, aegisId: string) => Promise<void>;
  /** Read SecureStore and populate knownOrgIds + activeOrgId. Migrates the legacy single-key. */
  loadKnownOrgs: () => Promise<void>;
  /** Append an orgId to the persisted list and mark it active. */
  addKnownOrg: (orgId: string) => Promise<void>;
  /** Remove an orgId from the persisted list; resets activeOrgId if it was the active one. */
  removeKnownOrg: (orgId: string) => Promise<void>;
  /** Load a different workspace: persist active, fetch org data. */
  switchWorkspace: (orgId: string, requesterId: string) => Promise<void>;
  clear: () => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

export const useWork = create<WorkState>((set, get) => ({
  org: null,
  members: [],
  devices: [],
  auditLog: [],
  channels: [],
  channelPermissions: {},
  loading: false,
  error: null,
  auditHasMore: false,
  auditLoading: false,
  auditFilters: { kind: null, actorId: null },
  knownOrgIds: [],
  activeOrgId: null,

  async fetchAuditPage(orgId, opts = {}) {
    set({ auditLoading: true });
    try {
      const adminSig = signAdminAction(orgId, 'list_audit');
      const { useIdentity } = require('./identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
      const aegisId = useIdentity.getState().identity?.aegisId;
      if (!aegisId || !adminSig) { set({ auditLoading: false }); return; }

      const params = new URLSearchParams({
        aegisId,
        sig: adminSig.sig,
        ts: String(adminSig.ts),
        limit: '50',
      });
      if (opts.before !== undefined) params.set('before', String(opts.before));
      if (opts.kind) params.set('kind', opts.kind);
      if (opts.actorId) params.set('actorId', opts.actorId);

      const res = await fetch(`${SERVER_URL}/work/org/${orgId}/audit?${params.toString()}`);
      if (!res.ok) { set({ auditLoading: false }); return; }
      const body = await res.json() as { log: WorkAuditEntry[]; hasMore?: boolean };
      const incoming: WorkAuditEntry[] = (body.log ?? []).map((e) => ({
        id: e.id,
        orgId: (e as unknown as Record<string, unknown>)['org_id'] as string ?? e.orgId,
        kind: e.kind,
        message: e.message,
        actorId: (e as unknown as Record<string, unknown>)['actor_id'] as string | null ?? e.actorId ?? null,
        targetId: (e as unknown as Record<string, unknown>)['target_id'] as string | null ?? e.targetId ?? null,
        channelId: (e as unknown as Record<string, unknown>)['channel_id'] as string | null ?? e.channelId ?? null,
        metadata: e.metadata ?? null,
        createdAt: (e as unknown as Record<string, unknown>)['created_at'] as number ?? e.createdAt,
      }));
      const isPage = opts.before !== undefined;
      set((s) => ({
        auditLog: isPage ? [...s.auditLog, ...incoming] : incoming,
        auditHasMore: body.hasMore ?? false,
        auditLoading: false,
      }));
    } catch {
      set({ auditLoading: false });
    }
  },

  async setAuditFilters(filters) {
    set({ auditFilters: filters, auditLog: [], auditHasMore: false });
    const orgId = get().org?.orgId;
    if (!orgId) return;
    const opts: { kind?: string; actorId?: string } = {};
    if (filters.kind) opts.kind = filters.kind;
    if (filters.actorId) opts.actorId = filters.actorId;
    await get().fetchAuditPage(orgId, opts);
  },

  async fetchChannelPermissions(orgId, channelId) {
    try {
      const adminSig = signAdminAction(orgId, 'get_channel_permissions');
      const { useIdentity } = require('./identity') as { useIdentity: { getState: () => { identity: { aegisId: string } | null } } };
      const aegisId = useIdentity.getState().identity?.aegisId;
      if (!aegisId || !adminSig) return;
      const query = `aegisId=${encodeURIComponent(aegisId)}&sig=${encodeURIComponent(adminSig.sig)}&ts=${adminSig.ts}`;
      const res = await fetch(`${SERVER_URL}/work/org/${orgId}/channels/${channelId}/permissions?${query}`);
      if (!res.ok) return;
      const { permissions } = await res.json() as { permissions: ChannelPermission[] };
      set((s) => ({
        channelPermissions: { ...s.channelPermissions, [channelId]: permissions },
      }));
    } catch {
      // Non-fatal — default permissions apply
    }
  },

  async fetchOrg(orgId, requesterId) {
    set({ loading: true, error: null });
    try {
      const membersSig = signAdminAction(orgId, 'list_members');
      const devicesSig = signAdminAction(orgId, 'list_devices');
      const auditSig   = signAdminAction(orgId, 'list_audit');

      function adminQuery(sig: { sig: string; ts: number } | null) {
        if (!sig) return `aegisId=${encodeURIComponent(requesterId)}`;
        return `aegisId=${encodeURIComponent(requesterId)}&sig=${encodeURIComponent(sig.sig)}&ts=${sig.ts}`;
      }

      const [orgRes, membersRes, devicesRes, auditRes] = await Promise.all([
        fetch(`${SERVER_URL}/work/org/${orgId}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/members?${adminQuery(membersSig)}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/devices?${adminQuery(devicesSig)}`),
        fetch(`${SERVER_URL}/work/org/${orgId}/audit?${adminQuery(auditSig)}&limit=50`),
      ]);
      if (!orgRes.ok) throw new Error('Org not found');
      const rawOrg: WorkOrg = await orgRes.json();
      // Decrypt the org name — the server stores it encrypted.
      const org: WorkOrg = { ...rawOrg, name: maybeDecryptOrgName(rawOrg.name) };
      const { members } = membersRes.ok ? await membersRes.json() : { members: [] };
      const { devices } = devicesRes.ok ? await devicesRes.json() : { devices: [] };
      const rawLog: WorkAuditEntry[] = auditRes.ok
        ? ((await auditRes.json() as { log: unknown[] }).log ?? []).map((e) => {
            const r = e as Record<string, unknown>;
            return {
              id: r['id'] as string,
              orgId: r['org_id'] as string ?? r['orgId'] as string ?? orgId,
              kind: r['kind'] as string,
              message: r['message'] as string,
              actorId: r['actor_id'] as string | null ?? r['actorId'] as string | null ?? null,
              targetId: r['target_id'] as string | null ?? r['targetId'] as string | null ?? null,
              channelId: r['channel_id'] as string | null ?? r['channelId'] as string | null ?? null,
              metadata: r['metadata'] as Record<string, unknown> | null ?? null,
              createdAt: r['created_at'] as number ?? r['createdAt'] as number ?? 0,
            } satisfies WorkAuditEntry;
          })
        : [];
      set({ org, members, devices, auditLog: rawLog, loading: false });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  async createOrg(name, adminId) {
    set({ loading: true, error: null });
    // Encrypt the workspace name before sending it to the relay.
    const sk = getOwnSecretKeyB64();
    const encryptedName = sk ? encryptOrgName(name, sk) : name;
    const res = await fetch(`${SERVER_URL}/work/org`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: encryptedName, adminId }),
    });
    if (!res.ok) {
      set({ loading: false, error: 'Failed to create org' });
      throw new Error('Failed to create org');
    }
    const { orgId } = await res.json();
    set({ loading: false });
    await get().fetchOrg(orgId, adminId);
    // Auto-create default channels — non-fatal if server doesn't support it yet
    await Promise.allSettled([
      get().createChannel(orgId as string, 'general', adminId, false),
      get().createChannel(orgId as string, 'comunicados', adminId, true),
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
      devices: s.devices.map((d) => d.device_id === deviceId ? { ...d, status: 'revoked' as const } : d),
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
      devices: s.devices.map((d) => d.device_id === deviceId ? { ...d, status: 'verified' as const } : d),
    }));
  },

  async removeMember(orgId, aegisId, requesterId) {
    const adminSig = signAdminAction(orgId, 'remove_member');
    if (!adminSig) throw new Error('Identity not loaded');
    const query = `aegisId=${encodeURIComponent(requesterId)}&sig=${encodeURIComponent(adminSig.sig)}&ts=${adminSig.ts}`;
    const res = await fetch(
      `${SERVER_URL}/work/org/${orgId}/members/${aegisId}?${query}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error('Failed to remove member');
    set((s) => ({ members: s.members.filter((m) => m.aegis_id !== aegisId) }));
  },

  async leaveWorkspace(orgId, aegisId) {
    await get().removeMember(orgId, aegisId, aegisId);
    await get().removeKnownOrg(orgId);
    set({ org: null, members: [], devices: [], auditLog: [], channels: [], error: null, auditHasMore: false, auditLoading: false, auditFilters: { kind: null, actorId: null } });
  },

  async loadKnownOrgs() {
    const SecureStore = await import('expo-secure-store');
    const raw = await SecureStore.getItemAsync('aegis.work.orgIds').catch(() => null);
    const ids: string[] = raw ? (JSON.parse(raw) as string[]) : [];

    // Migrate legacy single-org key if present
    const oldSingle = await SecureStore.getItemAsync('aegis.work.orgId').catch(() => null);
    if (oldSingle && !ids.includes(oldSingle)) {
      ids.push(oldSingle);
      await SecureStore.setItemAsync('aegis.work.orgIds', JSON.stringify(ids));
      await SecureStore.deleteItemAsync('aegis.work.orgId').catch(() => {});
    }

    const activeId = await SecureStore.getItemAsync('aegis.work.activeOrgId').catch(() => null);
    set({ knownOrgIds: ids, activeOrgId: activeId ?? ids[0] ?? null });
  },

  async addKnownOrg(orgId) {
    const SecureStore = await import('expo-secure-store');
    const raw = await SecureStore.getItemAsync('aegis.work.orgIds').catch(() => null);
    const existing: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    if (!existing.includes(orgId)) {
      const updated = [...existing, orgId];
      await SecureStore.setItemAsync('aegis.work.orgIds', JSON.stringify(updated));
    }
    await SecureStore.setItemAsync('aegis.work.activeOrgId', orgId);
    set((s) => ({ knownOrgIds: [...new Set([...s.knownOrgIds, orgId])], activeOrgId: orgId }));
  },

  async removeKnownOrg(orgId) {
    const SecureStore = await import('expo-secure-store');
    const raw = await SecureStore.getItemAsync('aegis.work.orgIds').catch(() => null);
    const existing: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const updated = existing.filter((id) => id !== orgId);
    await SecureStore.setItemAsync('aegis.work.orgIds', JSON.stringify(updated));

    const currentActive = get().activeOrgId;
    const newActive = currentActive === orgId ? (updated[0] ?? null) : currentActive;
    if (newActive) {
      await SecureStore.setItemAsync('aegis.work.activeOrgId', newActive);
    } else {
      await SecureStore.deleteItemAsync('aegis.work.activeOrgId').catch(() => {});
    }
    set({ knownOrgIds: updated, activeOrgId: newActive });
  },

  async switchWorkspace(orgId, requesterId) {
    const SecureStore = await import('expo-secure-store');
    await SecureStore.setItemAsync('aegis.work.activeOrgId', orgId);
    set({ activeOrgId: orgId });
    await get().fetchOrg(orgId, requesterId);
    await get().fetchChannels(orgId);
  },

  clear() {
    set({ org: null, members: [], devices: [], auditLog: [], channels: [], channelPermissions: {}, loading: false, error: null, auditHasMore: false, auditLoading: false, auditFilters: { kind: null, actorId: null }, knownOrgIds: [], activeOrgId: null });
  },
}));
