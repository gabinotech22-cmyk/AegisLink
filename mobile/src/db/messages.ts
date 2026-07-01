import { withDb, encryptBody, decryptBody } from './core';

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
  deliveryStatus?: 'sent' | 'delivered' | 'read';
  expiresAt?: number | null;
  attachments?: Attachment[] | null;
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
  const mediaUri = r.media_uri ? await decryptBody(r.media_uri) : null;
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
    deliveryStatus: (r.delivery_status as 'sent' | 'delivered' | 'read' | null) ?? 'sent',
    expiresAt: r.expires_at ?? null,
    attachments,
  };
}

export async function saveMessage(m: StoredMessage): Promise<void> {
  return withDb(async (d) => {
    const encrypted = await encryptBody(m.body);
    const encryptedMediaUri = m.mediaUri ? await encryptBody(m.mediaUri) : null;
    await d.runAsync(
      `INSERT OR REPLACE INTO messages
       (id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at, attachments)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      m.attachments ? JSON.stringify(m.attachments) : null
    );
  });
}

export async function updateMessageDelivery(id: string, status: 'sent' | 'delivered' | 'read'): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET delivery_status = ? WHERE id = ?', status, id);
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
  const encryptedMediaUri = await encryptBody(mediaUri);
  return withDb(async (d) => {
    await d.runAsync('UPDATE messages SET media_uri = ? WHERE id = ?', encryptedMediaUri, id);
  });
}

const MSG_SELECT = `SELECT id, chat_id, direction, body, created_at, type, media_uri, reply_to_id, reactions, starred, deleted, pinned, delivery_status, expires_at, attachments`;

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
