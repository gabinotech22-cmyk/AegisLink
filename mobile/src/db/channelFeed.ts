import { withDb, encryptBody, decryptBody } from './core';
import type { FeedPost } from '../store/channels';

/**
 * Local at-rest cache of a sealed channel's projected feed.
 *
 * The relay does not retain channel broadcast history forever, and the verified
 * chain head IS persisted (for delta pulls), so without this a cold restart would
 * resume from the head into an empty in-memory feed and show no posts. We persist
 * the decrypted FeedPost list encrypted at rest (encryptBody) — only opaque
 * ciphertext lands on disk, preserving zero-metadata — and restore it on load.
 *
 * Bounded to the most recent posts so an active channel can't grow the row without
 * limit; the head still advances, so trimming only affects how far back the local
 * history reaches, never delta correctness.
 */
const MAX_CACHED_POSTS = 500;

/** Persist (replace) a channel's feed cache. Keeps only the last MAX_CACHED_POSTS. */
export async function saveChannelFeed(channelId: string, posts: FeedPost[]): Promise<void> {
  const trimmed = posts.length > MAX_CACHED_POSTS ? posts.slice(-MAX_CACHED_POSTS) : posts;
  const enc = await encryptBody(JSON.stringify(trimmed));
  return withDb(async (d) => {
    await d.runAsync(
      'INSERT OR REPLACE INTO channel_feed (channel_id, posts_enc, updated_at) VALUES (?, ?, ?)',
      channelId, enc, Date.now(),
    );
  });
}

/** Restore a channel's cached feed, or [] if none/corrupt. */
export async function loadChannelFeed(channelId: string): Promise<FeedPost[]> {
  const row = await withDb(async (d) =>
    d.getFirstAsync<{ posts_enc: string }>(
      'SELECT posts_enc FROM channel_feed WHERE channel_id = ?', channelId,
    ),
  );
  if (!row?.posts_enc) return [];
  const json = await decryptBody(row.posts_enc);
  if (!json || json === '[DECRYPTION_ERROR]') return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as FeedPost[]) : [];
  } catch {
    return [];
  }
}

/** Drop a channel's feed cache (on leave/unsubscribe). */
export async function deleteChannelFeed(channelId: string): Promise<void> {
  return withDb(async (d) => {
    await d.runAsync('DELETE FROM channel_feed WHERE channel_id = ?', channelId);
  });
}
