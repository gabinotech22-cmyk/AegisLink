import { withDb } from './core';

export interface StoredCall {
  id: string;
  contactId: string;
  direction: 'in' | 'out';
  media: 'audio' | 'video';
  status: 'missed' | 'answered' | 'declined';
  startedAt: number;
  durationS: number;
}

export async function saveCall(c: StoredCall): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync(
      'INSERT OR REPLACE INTO call_history (id, contact_id, direction, media, status, started_at, duration_s) VALUES (?, ?, ?, ?, ?, ?, ?)',
      c.id, c.contactId, c.direction, c.media, c.status, c.startedAt, c.durationS
    );
  });
}

export async function getCallHistory(contactId: string, limit = 50): Promise<StoredCall[]> {
  return withDb(async (d) => {
    const rows = await d.getAllAsync<{
      id: string; contact_id: string; direction: string; media: string;
      status: string; started_at: number; duration_s: number;
    }>(
      'SELECT id, contact_id, direction, media, status, started_at, duration_s FROM call_history WHERE contact_id = ? ORDER BY started_at DESC LIMIT ?',
      contactId, limit
    );
    return rows.map((r) => ({
      id: r.id, contactId: r.contact_id,
      direction: r.direction as 'in' | 'out',
      media: r.media as 'audio' | 'video',
      status: r.status as 'missed' | 'answered' | 'declined',
      startedAt: r.started_at, durationS: r.duration_s,
    }));
  });
}
