import { withDb } from './core';

export interface StoredScheduledMessage {
  id: string;
  /** 1:1: the contact's aegisId. Group posts: the groupId (mirrors group_id). */
  recipientAegisId: string;
  /**
   * 1:1: SealedEnvelope JSON — already E2EE ciphertext, plaintext NEVER stored.
   * Group: encryptBody(plaintext) — at-rest encrypted, ratcheted at fire time
   * via sendGroupMessage so membership and admin signature are always fresh.
   */
  encryptedPayload: string;
  sendAt: number;
  createdAt: number;
  /** 'draft' is group-posts only: kept locally, never fired by processDue. */
  status: 'pending' | 'sent' | 'failed' | 'draft';
  retryCount: number;
  /** Set only for scheduled group posts. */
  groupId?: string;
  /** encryptBody(JSON GroupPostOptions) — group posts only. */
  postMeta?: string;
  /** Set only for scheduled channel posts. */
  channelId?: string;
}

type ScheduledRow = {
  id: string;
  recipient_aegis_id: string;
  encrypted_payload: string;
  send_at: number;
  created_at: number;
  status: string;
  retry_count: number;
  group_id: string | null;
  post_meta: string | null;
  channel_id: string | null;
};

function rowToScheduled(r: ScheduledRow): StoredScheduledMessage {
  return {
    id: r.id,
    recipientAegisId: r.recipient_aegis_id,
    encryptedPayload: r.encrypted_payload,
    sendAt: r.send_at,
    createdAt: r.created_at,
    status: r.status as 'pending' | 'sent' | 'failed' | 'draft',
    retryCount: r.retry_count,
    groupId: r.group_id ?? undefined,
    postMeta: r.post_meta ?? undefined,
    channelId: r.channel_id ?? undefined,
  };
}

const SCHED_SELECT = `SELECT id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count, group_id, post_meta, channel_id`;

export async function saveScheduled(msg: StoredScheduledMessage): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT OR REPLACE INTO scheduled_messages
       (id, recipient_aegis_id, encrypted_payload, send_at, created_at, status, retry_count, group_id, post_meta, channel_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      msg.id,
      msg.recipientAegisId,
      msg.encryptedPayload,
      msg.sendAt,
      msg.createdAt,
      msg.status,
      msg.retryCount,
      msg.groupId ?? null,
      msg.postMeta ?? null,
      msg.channelId ?? null,
    );
  });
}

export async function loadPendingScheduled(): Promise<StoredScheduledMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<ScheduledRow>(
      `${SCHED_SELECT} FROM scheduled_messages WHERE status = 'pending' ORDER BY send_at ASC`,
    );
    return rows.map(rowToScheduled);
  });
}

export async function loadAllScheduled(): Promise<StoredScheduledMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<ScheduledRow>(
      `${SCHED_SELECT} FROM scheduled_messages ORDER BY send_at ASC`,
    );
    return rows.map(rowToScheduled);
  });
}

export async function markScheduledSent(id: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`UPDATE scheduled_messages SET status = 'sent' WHERE id = ?`, id);
  });
}

export async function markScheduledFailed(id: string, retryCount: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `UPDATE scheduled_messages SET status = 'failed', retry_count = ? WHERE id = ?`,
      retryCount,
      id,
    );
  });
}

export async function incrementScheduledRetry(id: string, retryCount: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `UPDATE scheduled_messages SET retry_count = ? WHERE id = ?`,
      retryCount,
      id,
    );
  });
}

export async function deleteScheduled(id: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`DELETE FROM scheduled_messages WHERE id = ?`, id);
  });
}
