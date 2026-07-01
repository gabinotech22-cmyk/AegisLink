import { withDb, encryptBody, decryptBody } from './core';

export async function getChatState(chatId: string): Promise<{ draft: string | null; unreadCount: number }> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ draft: string | null; unread_count: number }>(
      'SELECT draft, unread_count FROM chat_state WHERE chat_id = ?', chatId
    );
    if (!row) return { draft: null, unreadCount: 0 };
    const decryptedDraft = row.draft ? await decryptBody(row.draft) : null;
    return { draft: decryptedDraft, unreadCount: row.unread_count };
  });
}

export async function setChatDraft(chatId: string, draft: string | null): Promise<void> {
  return withDb(async (d) => {
    const encrypted = draft ? await encryptBody(draft) : null;
    await d.runAsync(
      'INSERT OR REPLACE INTO chat_state (chat_id, draft, unread_count) VALUES (?, ?, COALESCE((SELECT unread_count FROM chat_state WHERE chat_id = ?), 0))',
      chatId, encrypted, chatId
    );
  });
}

export async function incrementUnread(chatId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 1) ON CONFLICT(chat_id) DO UPDATE SET unread_count = unread_count + 1',
      chatId
    );
  });
}

export async function resetUnread(chatId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      'INSERT INTO chat_state (chat_id, unread_count) VALUES (?, 0) ON CONFLICT(chat_id) DO UPDATE SET unread_count = 0',
      chatId
    );
  });
}

export async function deleteChatState(chatId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM chat_state WHERE chat_id = ?', chatId);
  });
}

export async function getAllUnreadCounts(): Promise<Record<string, number>> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<{ chat_id: string; unread_count: number }>(
      'SELECT chat_id, unread_count FROM chat_state WHERE unread_count > 0'
    );
    const result: Record<string, number> = {};
    for (const r of rows) result[r.chat_id] = r.unread_count;
    return result;
  });
}

// ─── Per-chat ephemeral timer ─────────────────────────────────────────────────

export async function setChatEphemeralTimer(chatId: string, seconds: number): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      `INSERT INTO chat_state (chat_id, ephemeral_timer, unread_count)
       VALUES (?, ?, COALESCE((SELECT unread_count FROM chat_state WHERE chat_id = ?), 0))
       ON CONFLICT(chat_id) DO UPDATE SET ephemeral_timer = excluded.ephemeral_timer`,
      chatId, seconds, chatId
    );
  });
}

export async function getChatEphemeralTimer(chatId: string): Promise<number> {
  return withDb(async (d) => {
    const row = await d.getFirstAsync<{ ephemeral_timer: number }>(
      'SELECT ephemeral_timer FROM chat_state WHERE chat_id = ?', chatId
    );
    return row?.ephemeral_timer ?? 0;
  });
}

export async function getAllChatEphemeralTimers(): Promise<Record<string, number>> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<{ chat_id: string; ephemeral_timer: number }>(
      'SELECT chat_id, ephemeral_timer FROM chat_state WHERE ephemeral_timer > 0'
    );
    const result: Record<string, number> = {};
    for (const r of rows) result[r.chat_id] = r.ephemeral_timer;
    return result;
  });
}

// ─── Ephemeral cleanup ────────────────────────────────────────────────────────

export async function deleteExpiredMessages(_timerSeconds?: number): Promise<void> {
  return withDb(async (d) => {
    const now = Date.now();
    // Only delete messages that have an explicit expiresAt set and have passed it.
    // The global timer is no longer used — expiresAt is authoritative.
    await d.runAsync(
      'DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at <= ?',
      now
    );
  });
}
