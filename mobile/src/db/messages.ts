import { withDb, encryptBody, decryptBody } from './core';
import { toRelativeMediaPath, toAbsoluteMediaUri } from '../utils/mediaPaths';

/**
 * media_uri may hold a blob pointer (`blob:id:key:nonce`, remote, opaque --
 * passthrough) or a LOCAL staged file path. Local paths must never be
 * persisted absolute -- the iOS sandbox container UUID changes across
 * TestFlight builds/reinstalls, orphaning the reference (audit finding #6).
 */

export type MessageType = 'text' | 'image' | 'audio' | 'video' | 'file' | 'poll' | 'location' | 'view_once';

export interface MessageReactions {
  [emoji: string]: string[]; // emoji -> list of aegisIds who reacted
}

export interface Attachment {
  type: 'image' | 'video' | 'audio' | 'file';
  uri: string;          // blob:id:key:nonce or local path during send
  fileName?: string;    // for files
  mimeType?: string;
  width?: number;
  height?: number;
  duration?: number;    // for video/audio in seconds
  caption?: string;     // per-attachment caption (optional)
}

/**
 * Lifecycle of an OUTGOING message, as the local device knows it.
 *
 *   pending   — sitting in the outbox; the relay has not acked it yet
 *   sent      — the relay acked receipt (one tick)
 *   delivered — the recipient's device persisted it (two ticks)
 *   read      — the recipient opened it (two accented ticks)
 *   failed    — the outbox gave up after the retry window; user can retry
 *
 * `pending` and `failed` exist because the previous three-state model could not
 * represent a message that never left the device: a stuck job rendered exactly
 * like a delivered one. This is LOCAL state — it is never sent to the relay and
 * adds no metadata to the wire.
 */
export type DeliveryStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

/** Values the DB is allowed to hold, for validating what we read back. */
const DELIVERY_STATUSES: readonly string[] = ['pending', 'sent', 'delivered', 'read', 'failed'];

export interface StoredMessage {
  id: string;
  chatId: string;
  direction: 'in' | 'out';
  body: string;
  createdAt: number;
  type?: MessageType;
  mediaUri?: string | null;
  replyToId?: string | null;
  reactions?: MessageReactions;
  starred?: boolean;
  deleted?: boolean;
  pinned?: boolean;
  deliveryStatus?: DeliveryStatus;
  expiresAt?: number | null;
  attachments?: Attachment[] | null;
  /** Authenticated sender aegisId from the E2EE envelope (group messages). */
  senderId?: string | null;
}

interface MessageRow {
  id: string;
  chat_id: string;
  direction: string;
  body: string;
  created_at: number;
  type: string | null;
  media_uri: string | null;
  reply_to_id: string | null;
  reactions: string | null;
  starred: number;
  deleted: number;
  pinned: number;
  delivery_status: string | null;
  expires_at: number | null;
  attachments: string | null;
  sender_id: string | null;
}

async function rowToMessage(r: MessageRow, body: string): Promise<StoredMessage> {
  let reactions: MessageReactions | undefined;
  if (r.reactions) {
    try { reactions = JSON.parse(r.reactions); } catch { /* ignore */ }
  }
  let attachments: Attachment[] | null = null;
  if (r.attachments) {
    try { attachments = JSON.parse(r.attachments); } catch { /* ignore */ }
  }
  const decryptedMediaUri = r.media_uri ? await decryptBody(r.media_uri) : null;
  const mediaUri = decryptedMediaUri ? toAbsoluteMediaUri(decryptedMediaUri) : null;
  return {
    id: r.id,
    chatId: r.chat_id,
    direction: r.direction as 'in' | 'out',
    body,
    createdAt: r.created_at,
    type: (r.type as MessageType | null) ?? 'text',
    mediaUri,
    replyToId: r.reply_to_id ?? null,
    reactions,
    starred: r.starred === 1,
    deleted: r.deleted === 1,
    pinned: r.pinned === 1,
    // Validate rather than blind-cast: a row written by a newer build (or a
    // corrupted value) must not become an unrenderable status. Unknown → 'sent',
    // which is what every pre-v13 row means anyway.
    deliveryStatus: DELIVERY_STATUSES.includes(r.delivery_status ?? '')
      ? (r.delivery_status as DeliveryStatus)
      : 'sent',
    expiresAt: r.expires_at ?? null,
    attachments,
    senderId: r.sender_id ?? null,
  };
}

export async function saveMessage(m: StoredMessage): Promise<void> {
  return withDb(async (d) => {
    const encrypted = await encryptBody(m.body);
    const encryptedMediaUri = m.mediaUri ? await encryptBody(toRelativeMediaPath(m.mediaUri)) : null;
    await d.runAsync(
      `INSERT OR REPLACE INTO messages
       (id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at, attachments, sender_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      m.id,
      m.chatId,
      m.direction,
      encrypted,
      m.createdAt,
      m.type ?? 'text',
      encryptedMediaUri,
      m.replyToId ?? null,
      m.reactions ? JSON.stringify(m.reactions) : null,
      m.starred ? 1 : 0,
      m.deleted ? 1 : 0,
      m.pinned ? 1 : 0,
      m.deliveryStatus ?? 'sent',
      m.expiresAt ?? null,
      m.attachments ? JSON.stringify(m.attachments) : null,
      m.senderId ?? null
    );
  });
}

export async function updateMessageDelivery(id: string, status: DeliveryStatus): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET delivery_status = ? WHERE id = ?', status, id);
  });
}

/**
 * Advance a message's delivery state without ever moving it BACKWARDS.
 *
 * Delivery signals race: a `delivered` receipt from the recipient can land
 * before our own relay ack resolves, and the outbox drain can resolve a job
 * after the peer already read the message. Applying those out of order would
 * flip two ticks back to one. Rank order is pending < sent < delivered < read;
 * `failed` is terminal-until-retried and only settable from pending/sent.
 */
const DELIVERY_RANK: Record<DeliveryStatus, number> = {
  pending: 0, sent: 1, delivered: 2, read: 3, failed: 0,
};

/**
 * Resolve which status wins. Pure so the in-memory store and the DB can apply
 * the exact same rule and never disagree about what a bubble should show.
 */
export function nextDeliveryStatus(current: DeliveryStatus, incoming: DeliveryStatus): DeliveryStatus {
  if (current === incoming) return current;
  // `failed` is STICKY: only an explicit retry (which sets `pending`) lifts it.
  // This matters for groups, where a message is failed as soon as one member's
  // job expires while siblings may still be succeeding — a late sibling `sent`
  // must not silently tell the user it went through after we told them it did
  // not. For 1:1 the retry path sets `pending` first, so nothing changes.
  if (current === 'failed') return incoming === 'pending' ? 'pending' : 'failed';
  // Giving up is only meaningful while the message is still in flight.
  if (incoming === 'failed') return current === 'pending' || current === 'sent' ? 'failed' : current;
  return DELIVERY_RANK[incoming] > DELIVERY_RANK[current] ? incoming : current;
}

export async function advanceMessageDelivery(id: string, status: DeliveryStatus): Promise<void> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ delivery_status: string | null }>(
      'SELECT delivery_status FROM messages WHERE id = ?',
      id,
    );
    if (!row) return;
    const current: DeliveryStatus = DELIVERY_STATUSES.includes(row.delivery_status ?? '')
      ? (row.delivery_status as DeliveryStatus)
      : 'sent';
    const next = nextDeliveryStatus(current, status);
    if (next === current) return;
    await d.runAsync('UPDATE messages SET delivery_status = ? WHERE id = ?', next, id);
  });
}

/** Update a message's attachments array in place (JSON-serialized). */
export async function updateMessageAttachments(id: string, attachments: Attachment[]): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET attachments = ? WHERE id = ?', JSON.stringify(attachments), id);
  });
}

/** Update a message's media reference (stored encrypted, like saveMessage). */
export async function updateMessageMediaUri(id: string, mediaUri: string): Promise<void> {
  const encryptedMediaUri = await encryptBody(toRelativeMediaPath(mediaUri));
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET media_uri = ? WHERE id = ?', encryptedMediaUri, id);
  });
}

const MSG_SELECT = `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at, attachments, sender_id`;

export async function loadMessagesByChat(chatId: string): Promise<StoredMessage[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<MessageRow>(
      `${MSG_SELECT} FROM messages WHERE chat_id = ? ORDER BY created_at ASC`,
      chatId
    );
    return Promise.all(rows.map(async (r) => await rowToMessage(r, await decryptBody(r.body))));
  });
}

export async function getMessage(id: string): Promise<StoredMessage | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<MessageRow>(
      `${MSG_SELECT} FROM messages WHERE id = ?`,
      id
    );
    if (!row) return null;
    return await rowToMessage(row, await decryptBody(row.body));
  });
}

export async function setMessagePinned(id: string, pinned: boolean): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`UPDATE messages SET pinned = ? WHERE id = ?`, pinned ? 1 : 0, id);
  });
}

export async function getPinnedMessage(chatId: string): Promise<StoredMessage | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<MessageRow>(
      `${MSG_SELECT} FROM messages WHERE chat_id = ? AND pinned = 1 ORDER BY created_at DESC LIMIT 1`,
      chatId
    );
    if (!row) return null;
    return await rowToMessage(row, await decryptBody(row.body));
  });
}

export async function setMessageStarred(id: string, starred: boolean): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`UPDATE messages SET starred = ? WHERE id = ?`, starred ? 1 : 0, id);
  });
}

export async function setMessageDeleted(id: string): Promise<void> {
  return withDb(async (d) => {
    // Soft delete: keep row, clear body, mark deleted
    const empty = await encryptBody('');
    await d.runAsync(
      `UPDATE messages SET deleted = 1, body = ?, media_uri = NULL WHERE id = ?`,
      empty,
      id
    );
  });
}

/**
 * Delete-for-everyone applied on the RECEIVER from a peer's E2EE retraction.
 * Unlike {@link setMessageDeleted} (used by the local "delete for me" path,
 * which may target the user's OWN messages), this is authorization-scoped: a
 * peer may only retract a message that (a) lives in OUR chat with them
 * (`chat_id = peerAegisId`) and (b) was sent BY them (`direction = 'in'`).
 * Knowing a msgId is not the same as owning the right to delete it — a peer
 * must not be able to erase the user's own messages or messages from other
 * chats by supplying an arbitrary id. Returns true iff a row was deleted.
 */
export async function setRemoteMessageDeleted(id: string, chatId: string, senderId: string): Promise<boolean> {
  return withDb(async (d) => {
    const empty = await encryptBody('');
    const res = await d.runAsync(
      `UPDATE messages SET deleted = 1, body = ?, media_uri = NULL
         WHERE id = ? AND chat_id = ? AND sender_id = ? AND direction = 'in'`,
      empty,
      id,
      chatId,
      senderId
    );
    return res.changes > 0;
  });
}

export async function setMessageReactions(id: string, reactions: MessageReactions): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(`UPDATE messages SET reactions = ? WHERE id = ?`, JSON.stringify(reactions), id);
  });
}

export async function lastMessageByChat(chatId: string): Promise<StoredMessage | null> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{
      id: string;
      chat_id: string;
      direction: string;
      body: string;
      created_at: number;
    }>(
      `SELECT id, chat_id, direction, body, created_at FROM messages
       WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1`,
      chatId
    );
    if (!row) return null;
    return {
      id: row.id,
      chatId: row.chat_id,
      direction: row.direction as 'in' | 'out',
      body: await decryptBody(row.body),
      createdAt: row.created_at,
    };
  });
}
