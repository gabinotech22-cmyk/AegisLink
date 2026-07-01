/**
 * AegisLink — Work (enterprise) repositories
 *
 * Extracted from db/client.ts (M4 god-file split). Orgs, channels, messages,
 * attachments, channel permissions and workspaces for AegisLink Work. Pure
 * relocation — no logic changes. Re-exported by db/client.ts.
 */

import { randomUUID } from 'node:crypto';
import { dbRun, dbAll, dbGet, USE_PG } from '../driver';
import {
  WorkOrgRow, WorkRole, WorkMemberRow, WorkChannelPermissionRow,
  WorkDeviceRow, WorkAuditRow, WorkInviteRow,
} from '../types';

// ── workRepo ──────────────────────────────────────────────────────────────────

export const workRepo = {
  async createOrg(row: Omit<WorkOrgRow, 'display_name' | 'invite_policy'> & { display_name?: string | null; invite_policy?: 'invite_only' | 'open' }): Promise<void> {
    await dbRun(
      `INSERT INTO work_orgs (org_id, name, admin_id, policy_key_rotation_days, created_at) VALUES (?, ?, ?, ?, ?)`,
      [row.org_id, row.name, row.admin_id, row.policy_key_rotation_days, row.created_at]
    );
  },
  async getOrg(orgId: string): Promise<WorkOrgRow | undefined> {
    return dbGet<WorkOrgRow>(`SELECT * FROM work_orgs WHERE org_id = ?`, [orgId]);
  },
  async addMember(row: WorkMemberRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO work_members (org_id, aegis_id, team, role, joined_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(org_id, aegis_id) DO NOTHING`,
        [row.org_id, row.aegis_id, row.team, row.role, row.joined_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO work_members (org_id, aegis_id, team, role, joined_at) VALUES (?, ?, ?, ?, ?)`,
        [row.org_id, row.aegis_id, row.team, row.role, row.joined_at]
      );
    }
  },
  async listMembers(orgId: string): Promise<WorkMemberRow[]> {
    return dbAll<WorkMemberRow>(`SELECT * FROM work_members WHERE org_id = ?`, [orgId]);
  },
  async getMember(orgId: string, aegisId: string): Promise<WorkMemberRow | undefined> {
    return dbGet<WorkMemberRow>(`SELECT * FROM work_members WHERE org_id = ? AND aegis_id = ?`, [orgId, aegisId]);
  },
  async removeMember(orgId: string, aegisId: string): Promise<void> {
    await dbRun(`DELETE FROM work_members WHERE org_id = ? AND aegis_id = ?`, [orgId, aegisId]);
  },
  async upsertDevice(row: WorkDeviceRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO work_devices (device_id, org_id, aegis_id, name, platform, status, last_seen, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET org_id = EXCLUDED.org_id, aegis_id = EXCLUDED.aegis_id, name = EXCLUDED.name, platform = EXCLUDED.platform, status = EXCLUDED.status, last_seen = EXCLUDED.last_seen, enrolled_at = EXCLUDED.enrolled_at`,
        [row.device_id, row.org_id, row.aegis_id, row.name, row.platform, row.status, row.last_seen, row.enrolled_at]
      );
    } else {
      await dbRun(
        `INSERT OR REPLACE INTO work_devices (device_id, org_id, aegis_id, name, platform, status, last_seen, enrolled_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [row.device_id, row.org_id, row.aegis_id, row.name, row.platform, row.status, row.last_seen, row.enrolled_at]
      );
    }
  },
  async listDevices(orgId: string): Promise<WorkDeviceRow[]> {
    return dbAll<WorkDeviceRow>(`SELECT * FROM work_devices WHERE org_id = ?`, [orgId]);
  },
  async setDeviceStatus(deviceId: string, orgId: string, status: WorkDeviceRow['status']): Promise<void> {
    await dbRun(`UPDATE work_devices SET status = ? WHERE device_id = ? AND org_id = ?`, [status, deviceId, orgId]);
  },
  async touchDevice(deviceId: string): Promise<void> {
    await dbRun(`UPDATE work_devices SET last_seen = ? WHERE device_id = ?`, [Date.now(), deviceId]);
  },
  async addAudit(row: Omit<WorkAuditRow, 'id'> & { id?: string }): Promise<void> {
    const id = row.id ?? randomUUID();
    await dbRun(
      `INSERT INTO work_audit_log (id, org_id, kind, message, actor_id, target_id, channel_id, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, row.org_id, row.kind, row.message, row.actor_id ?? null, row.target_id ?? null, row.channel_id ?? null, row.metadata ?? null, row.created_at]
    );
  },
  async listAudit(orgId: string, opts?: {
    limit?: number;
    before?: number;
    kind?: string;
    actorId?: string;
    channelId?: string;
  }): Promise<WorkAuditRow[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const conditions: string[] = ['org_id = ?'];
    const params: unknown[] = [orgId];
    if (opts?.before !== undefined) { conditions.push('created_at < ?'); params.push(opts.before); }
    if (opts?.kind !== undefined) { conditions.push('kind = ?'); params.push(opts.kind); }
    if (opts?.actorId !== undefined) { conditions.push('actor_id = ?'); params.push(opts.actorId); }
    if (opts?.channelId !== undefined) { conditions.push('channel_id = ?'); params.push(opts.channelId); }
    params.push(limit);
    return dbAll<WorkAuditRow>(
      `SELECT id, org_id, kind, message, actor_id, target_id, channel_id, metadata, created_at FROM work_audit_log WHERE ${conditions.join(' AND ')} ORDER BY created_at DESC LIMIT ?`,
      params
    );
  },
  async updateMemberRole(orgId: string, aegisId: string, role: WorkRole): Promise<boolean> {
    const result = await dbRun(
      `UPDATE work_members SET role = ? WHERE org_id = ? AND aegis_id = ?`,
      [role, orgId, aegisId]
    );
    return result.changes > 0;
  },
  async createInvite(row: WorkInviteRow): Promise<void> {
    await dbRun(
      `INSERT INTO work_invite_tokens (token, org_id, team, role, created_by, created_at, expires_at, used) VALUES (?, ?, ?, ?, ?, ?, ?, 0)`,
      [row.token, row.org_id, row.team, row.role, row.created_by, row.created_at, row.expires_at]
    );
  },
  async getInvite(token: string): Promise<WorkInviteRow | undefined> {
    return dbGet<WorkInviteRow>(`SELECT * FROM work_invite_tokens WHERE token = ?`, [token]);
  },
  async useInvite(token: string): Promise<void> {
    await dbRun(`UPDATE work_invite_tokens SET used = 1 WHERE token = ?`, [token]);
  },
  async updateOrgSettings(orgId: string, displayName: string | null, invitePolicy: 'invite_only' | 'open'): Promise<void> {
    await dbRun(
      `UPDATE work_orgs SET display_name = ?, invite_policy = ? WHERE org_id = ?`,
      [displayName, invitePolicy, orgId],
    );
  },
  async updateChannelRetention(channelId: string, retentionDays: number | null): Promise<void> {
    await dbRun(
      `UPDATE work_channels SET retention_days = ? WHERE channel_id = ?`,
      [retentionDays, channelId],
    );
  },
};

// ── workChannelRepo / workMessageRepo ─────────────────────────────────────────

export interface WorkChannelRow {
  channel_id: string;
  org_id: string;
  name: string;
  is_announcements: number; // 0 | 1
  created_at: number;
  retention_days: number | null;
}

export interface WorkMessageRow {
  id: string;
  channel_id: string;
  org_id: string;
  sender_id: string;
  body: string;
  type: string;
  created_at: number;
  is_pinned: number; // 0 | 1
  pinned_by: string | null;
  pinned_at: string | null;
  parent_id: string | null;
  reply_count: number;
  /** Soft-delete: 1 = deleted. Body and type are replaced with '' / 'deleted'. */
  is_deleted: number; // 0 | 1
}

export const workChannelRepo = {
  async create(row: Omit<WorkChannelRow, 'retention_days'>): Promise<void> {
    await dbRun(
      `INSERT INTO work_channels (channel_id, org_id, name, is_announcements, created_at) VALUES (?, ?, ?, ?, ?)`,
      [row.channel_id, row.org_id, row.name, row.is_announcements, row.created_at]
    );
  },
  async listByOrg(orgId: string): Promise<WorkChannelRow[]> {
    return dbAll<WorkChannelRow>(
      `SELECT channel_id, org_id, name, is_announcements, created_at, retention_days FROM work_channels WHERE org_id = ? ORDER BY created_at ASC`,
      [orgId]
    );
  },
  async get(channelId: string): Promise<WorkChannelRow | undefined> {
    return dbGet<WorkChannelRow>(
      `SELECT channel_id, org_id, name, is_announcements, created_at, retention_days FROM work_channels WHERE channel_id = ?`,
      [channelId]
    );
  },
};

export const workMessageRepo = {
  async insert(row: Omit<WorkMessageRow, 'is_pinned' | 'pinned_by' | 'pinned_at' | 'reply_count' | 'is_deleted'>): Promise<void> {
    const parentId = row.parent_id ?? null;
    await dbRun(
      `INSERT INTO work_messages (id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, 0)`,
      [row.id, row.channel_id, row.org_id, row.sender_id, row.body, row.type, row.created_at, parentId]
    );
    if (parentId !== null) {
      await dbRun(
        `UPDATE work_messages SET reply_count = reply_count + 1 WHERE id = ?`,
        [parentId]
      );
    }
  },
  async getByChannel(
    channelId: string,
    limit = 50,
    before?: number
  ): Promise<WorkMessageRow[]> {
    if (before !== undefined) {
      return dbAll<WorkMessageRow>(
        `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
         FROM work_messages WHERE channel_id = ? AND created_at < ?
         ORDER BY created_at DESC LIMIT ?`,
        [channelId, before, limit]
      );
    }
    return dbAll<WorkMessageRow>(
      `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
       FROM work_messages WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [channelId, limit]
    );
  },

  async getThreadReplies(parentId: string, channelId: string): Promise<WorkMessageRow[]> {
    return dbAll<WorkMessageRow>(
      `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
       FROM work_messages WHERE parent_id = ? AND channel_id = ?
       ORDER BY created_at ASC`,
      [parentId, channelId]
    );
  },

  async getById(messageId: string): Promise<WorkMessageRow | undefined> {
    return dbGet<WorkMessageRow>(
      `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
       FROM work_messages WHERE id = ?`,
      [messageId]
    );
  },
  
  async search(orgId: string, channelId: string | null, query: string, limit = 50): Promise<WorkMessageRow[]> {
    // Sanitize: escape double-quotes and wrap in phrase-search delimiters for FTS5
    const ftsQuery = `"${query.replace(/"/g, '""')}"`;
    try {
      return await dbAll<WorkMessageRow>(
        `SELECT m.id, m.channel_id, m.org_id, m.sender_id, m.body, m.type, m.created_at, m.is_pinned, m.pinned_by, m.pinned_at, m.parent_id, m.reply_count, COALESCE(m.is_deleted, 0) AS is_deleted
         FROM work_messages_fts f
         JOIN work_messages m ON m.id = f.id
         WHERE f.org_id = ? AND (? IS NULL OR f.channel_id = ?) AND work_messages_fts MATCH ? AND COALESCE(m.is_deleted, 0) = 0
         ORDER BY m.created_at DESC LIMIT ?`,
        [orgId, channelId, channelId, ftsQuery, limit]
      );
    } catch {
      // Fallback to LIKE for old DBs that may not have the FTS table yet
      const likeQuery = `%${query}%`;
      return dbAll<WorkMessageRow>(
        `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
         FROM work_messages
         WHERE org_id = ? AND (? IS NULL OR channel_id = ?) AND body LIKE ? AND COALESCE(is_deleted, 0) = 0
         ORDER BY created_at DESC LIMIT ?`,
        [orgId, channelId, channelId, likeQuery, limit]
      );
    }
  },
  async pinMessage(
    messageId: string,
    channelId: string,
    orgId: string,
    pinnedBy: string,
    pin: boolean,
  ): Promise<boolean> {
    const existing = await dbGet<Pick<WorkMessageRow, 'id' | 'is_deleted'>>(
      `SELECT id, COALESCE(is_deleted, 0) AS is_deleted FROM work_messages WHERE id = ? AND channel_id = ? AND org_id = ?`,
      [messageId, channelId, orgId],
    );
    if (!existing) return false;
    const isPinned = pin ? 1 : 0;
    const pinnedByVal = pin ? pinnedBy : null;
    const pinnedAtVal = pin ? new Date().toISOString() : null;
    await dbRun(
      `UPDATE work_messages SET is_pinned = ?, pinned_by = ?, pinned_at = ? WHERE id = ? AND channel_id = ?`,
      [isPinned, pinnedByVal, pinnedAtVal, messageId, channelId],
    );
    return true;
  },
  async getPinnedMessages(channelId: string): Promise<WorkMessageRow[]> {
    return dbAll<WorkMessageRow>(
      `SELECT id, channel_id, org_id, sender_id, body, type, created_at, is_pinned, pinned_by, pinned_at, parent_id, reply_count, COALESCE(is_deleted, 0) AS is_deleted
       FROM work_messages WHERE channel_id = ? AND is_pinned = 1
       ORDER BY pinned_at ASC`,
      [channelId],
    );
  },

  /**
   * Soft-delete a message: replaces body with '' and type with 'deleted'.
   * Returns `true` if the message existed, `false` if not found.
   */
  async softDelete(messageId: string): Promise<boolean> {
    const existing = await dbGet<Pick<WorkMessageRow, 'id'>>(
      `SELECT id FROM work_messages WHERE id = ?`,
      [messageId],
    );
    if (!existing) return false;
    await dbRun(
      `UPDATE work_messages SET body = '', type = 'deleted', is_deleted = 1 WHERE id = ?`,
      [messageId],
    );
    return true;
  },
};

// ── pruneExpiredWorkMessages ──────────────────────────────────────────────────

/**
 * Hard-delete work messages that are older than the channel's retention_days
 * policy. Runs server-side only; clients never see deleted content after
 * reconnect. Safe to call on any backend (SQLite or PG) via dbRun/dbAll.
 */
export async function pruneExpiredWorkMessages(): Promise<void> {
  // Find channels with a retention policy set
  const channels = await dbAll<{ channel_id: string; retention_days: number }>(
    `SELECT channel_id, retention_days FROM work_channels WHERE retention_days IS NOT NULL`,
  );
  for (const ch of channels) {
    const cutoffMs = Date.now() - ch.retention_days * 86400 * 1000;
    await dbRun(
      `DELETE FROM work_messages WHERE channel_id = ? AND created_at < ?`,
      [ch.channel_id, cutoffMs],
    );
  }
}

// ── workAttachmentRepo ────────────────────────────────────────────────────────

export interface WorkAttachmentRow {
  id: string;
  message_id: string;
  channel_id: string;
  org_id: string;
  /** References a blob stored in the /uploads/ directory by the PoW upload endpoint. */
  blob_id: string;
  filename: string;
  mime_type: string;
  size_bytes: number;
  uploaded_by: string;
  /** ISO-8601 timestamp string */
  created_at: string;
}

export const workAttachmentRepo = {
  async insert(row: WorkAttachmentRow): Promise<void> {
    await dbRun(
      `INSERT INTO work_attachments (id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [row.id, row.message_id, row.channel_id, row.org_id, row.blob_id, row.filename, row.mime_type, row.size_bytes, row.uploaded_by, row.created_at]
    );
  },

  /**
   * Paginated list of all attachments for a channel.
   * `before` is an ISO-8601 string cursor (exclusive upper bound on created_at).
   */
  async getByChannel(channelId: string, limit: number, before?: string): Promise<WorkAttachmentRow[]> {
    if (before !== undefined) {
      return dbAll<WorkAttachmentRow>(
        `SELECT id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at
         FROM work_attachments WHERE channel_id = ? AND created_at < ?
         ORDER BY created_at DESC LIMIT ?`,
        [channelId, before, limit]
      );
    }
    return dbAll<WorkAttachmentRow>(
      `SELECT id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM work_attachments WHERE channel_id = ?
       ORDER BY created_at DESC LIMIT ?`,
      [channelId, limit]
    );
  },

  async getByMessage(messageId: string): Promise<WorkAttachmentRow[]> {
    return dbAll<WorkAttachmentRow>(
      `SELECT id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM work_attachments WHERE message_id = ?
       ORDER BY created_at ASC`,
      [messageId]
    );
  },

  async getById(attachmentId: string): Promise<WorkAttachmentRow | undefined> {
    return dbGet<WorkAttachmentRow>(
      `SELECT id, message_id, channel_id, org_id, blob_id, filename, mime_type, size_bytes, uploaded_by, created_at
       FROM work_attachments WHERE id = ?`,
      [attachmentId]
    );
  },
};

// ── workChannelPermissionRepo ─────────────────────────────────────────────────

const ALL_ROLES: WorkRole[] = ['owner', 'admin', 'member'];

export const workChannelPermissionRepo = {
  /**
   * Seed default permissions for a newly created channel.
   * Announcements channels restrict members from sending.
   */
  async seedDefaults(channelId: string, orgId: string, isAnnouncements: boolean): Promise<void> {
    for (const role of ALL_ROLES) {
      const canSend = isAnnouncements && role === 'member' ? 0 : 1;
      if (USE_PG) {
        await dbRun(
          `INSERT INTO work_channel_permissions (channel_id, org_id, role, can_send, can_react, can_upload)
           VALUES (?, ?, ?, ?, 1, ?)
           ON CONFLICT(channel_id, role) DO NOTHING`,
          [channelId, orgId, role, canSend, canSend]
        );
      } else {
        await dbRun(
          `INSERT OR IGNORE INTO work_channel_permissions (channel_id, org_id, role, can_send, can_react, can_upload)
           VALUES (?, ?, ?, ?, 1, ?)`,
          [channelId, orgId, role, canSend, canSend]
        );
      }
    }
  },

  async getAll(channelId: string): Promise<WorkChannelPermissionRow[]> {
    return dbAll<WorkChannelPermissionRow>(
      `SELECT channel_id, org_id, role, can_send, can_react, can_upload
       FROM work_channel_permissions WHERE channel_id = ?`,
      [channelId]
    );
  },

  async getForRole(channelId: string, role: WorkRole): Promise<WorkChannelPermissionRow | undefined> {
    return dbGet<WorkChannelPermissionRow>(
      `SELECT channel_id, org_id, role, can_send, can_react, can_upload
       FROM work_channel_permissions WHERE channel_id = ? AND role = ?`,
      [channelId, role]
    );
  },

  async set(channelId: string, orgId: string, role: WorkRole, perms: { canSend: boolean; canReact: boolean; canUpload: boolean }): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO work_channel_permissions (channel_id, org_id, role, can_send, can_react, can_upload)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, role) DO UPDATE SET can_send = EXCLUDED.can_send, can_react = EXCLUDED.can_react, can_upload = EXCLUDED.can_upload`,
        [channelId, orgId, role, perms.canSend ? 1 : 0, perms.canReact ? 1 : 0, perms.canUpload ? 1 : 0]
      );
    } else {
      await dbRun(
        `INSERT INTO work_channel_permissions (channel_id, org_id, role, can_send, can_react, can_upload)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, role) DO UPDATE SET can_send = excluded.can_send, can_react = excluded.can_react, can_upload = excluded.can_upload`,
        [channelId, orgId, role, perms.canSend ? 1 : 0, perms.canReact ? 1 : 0, perms.canUpload ? 1 : 0]
      );
    }
  },
};

// ── workspaceRepo ─────────────────────────────────────────────────────────────

export interface WorkspaceRow {
  id: string;
  name_enc: string;   // name is stored ciphertext — server never sees plaintext
  admin_id: string;
  created_at: number;
}

export interface WorkspaceMemberRow {
  workspace_id: string;
  aegis_id: string;
  role: string;
  joined_at: number;
}

export const workspaceRepo = {
  async create(row: WorkspaceRow): Promise<void> {
    await dbRun(
      `INSERT INTO workspaces (id, name_enc, admin_id, created_at) VALUES (?, ?, ?, ?)`,
      [row.id, row.name_enc, row.admin_id, row.created_at]
    );
  },

  async get(id: string): Promise<WorkspaceRow | undefined> {
    return dbGet<WorkspaceRow>(
      `SELECT id, name_enc, admin_id, created_at FROM workspaces WHERE id = ?`,
      [id]
    );
  },

  async addMember(row: WorkspaceMemberRow): Promise<void> {
    if (USE_PG) {
      await dbRun(
        `INSERT INTO workspace_members (workspace_id, aegis_id, role, joined_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (workspace_id, aegis_id) DO NOTHING`,
        [row.workspace_id, row.aegis_id, row.role, row.joined_at]
      );
    } else {
      await dbRun(
        `INSERT OR IGNORE INTO workspace_members (workspace_id, aegis_id, role, joined_at) VALUES (?, ?, ?, ?)`,
        [row.workspace_id, row.aegis_id, row.role, row.joined_at]
      );
    }
  },

  async removeMember(workspaceId: string, aegisId: string): Promise<boolean> {
    const result = await dbRun(
      `DELETE FROM workspace_members WHERE workspace_id = ? AND aegis_id = ?`,
      [workspaceId, aegisId]
    );
    return result.changes > 0;
  },

  async listMembers(workspaceId: string): Promise<WorkspaceMemberRow[]> {
    return dbAll<WorkspaceMemberRow>(
      `SELECT workspace_id, aegis_id, role, joined_at FROM workspace_members WHERE workspace_id = ?`,
      [workspaceId]
    );
  },

  async isMember(workspaceId: string, aegisId: string): Promise<boolean> {
    const row = await dbGet<{ aegis_id: string }>(
      `SELECT aegis_id FROM workspace_members WHERE workspace_id = ? AND aegis_id = ? LIMIT 1`,
      [workspaceId, aegisId]
    );
    return row !== undefined;
  },
};

