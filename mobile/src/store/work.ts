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
  role: 'admin' | 'member';
  joined_at: number;
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
  org_id: string;
  kind: 'info' | 'warn' | 'ok';
  message: string;
  created_at: number;
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

  // Actions
  fetchOrg: (orgId: string, requesterId: string) => Promise<void>;
  createOrg: (name: string, adminId: string) => Promise<string>;
  createInvite: (orgId: string, requesterId: string, team: string, role: 'admin' | 'member') => Promise<string>;
  joinOrg: (token: string, aegisId: string, deviceId: string, deviceName: string, platform: string) => Promise<{ orgId: string; team: string }>;
  revokeDevice: (orgId: string, deviceId: string, requesterId: string) => Promise<void>;
  verifyDevice: (orgId: string, deviceId: string, requesterId: string) => Promise<void>;
  removeMember: (orgId: string, aegisId: string, requesterId: string) => Promise<void>;
  /** Remove self from the org and wipe local org state + SecureStore entry. */
  leaveWorkspace: (orgId: string, aegisId: string) => Promise<void>;
  clear: () => void;
}

// ─── Store ────────────────────────────────────────────────────────────────────

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
      const rawOrg: WorkOrg = await orgRes.json();
      // Decrypt the org name — the server stores it encrypted.
      const org: WorkOrg = { ...rawOrg, name: maybeDecryptOrgName(rawOrg.name) };
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
      devices: s.devices.map((d) => d.device_id === deviceId ? { ...d, status: 'revoked' as const } : d),
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
      devices: s.devices.map((d) => d.device_id === deviceId ? { ...d, status: 'verified' as const } : d),
    }));
  },

  async removeMember(orgId, aegisId, requesterId) {
    const res = await fetch(
      `${SERVER_URL}/work/org/${orgId}/members/${aegisId}?requesterId=${encodeURIComponent(requesterId)}`,
      { method: 'DELETE' }
    );
    if (!res.ok) throw new Error('Failed to remove member');
    set((s) => ({ members: s.members.filter((m) => m.aegis_id !== aegisId) }));
  },

  async leaveWorkspace(orgId, aegisId) {
    await get().removeMember(orgId, aegisId, aegisId);
    // Remove the stored orgId from SecureStore so the dashboard shows the empty state.
    const SecureStore = await import('expo-secure-store');
    await SecureStore.deleteItemAsync('aegis.work.orgId').catch(() => {});
    set({ org: null, members: [], devices: [], auditLog: [], error: null });
  },

  clear() {
    set({ org: null, members: [], devices: [], auditLog: [], loading: false, error: null });
  },
}));
