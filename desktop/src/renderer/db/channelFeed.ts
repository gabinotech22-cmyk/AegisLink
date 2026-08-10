/**
 * Local at-rest cache of a sealed channel's projected feed (desktop).
 * Parity with mobile/src/db/channelFeed.ts.
 *
 * The relay does not retain channel broadcast history forever, and the verified
 * chain head IS persisted for delta pulls, so without this a cold restart would
 * resume from the head into an empty feed and show no posts at all.
 *
 * Encryption and the 500-post cap live in the main process, next to the DB, so
 * the plaintext feed never crosses IPC in the stored direction and the bound
 * cannot be skipped by a renderer that forgets it.
 */
import { getActiveDbSlot } from './local';
import type { FeedPost } from '../store/channels';

const db = () => window.aegis.db;

/** Persist (replace) a channel's feed cache. */
export async function saveChannelFeed(channelId: string, posts: FeedPost[]): Promise<void> {
  await db().saveChannelFeed(getActiveDbSlot(), channelId, JSON.stringify(posts));
}

/** Restore a channel's cached feed, or [] if absent or unreadable. */
export async function loadChannelFeed(channelId: string): Promise<FeedPost[]> {
  const json = await db().loadChannelFeed(getActiveDbSlot(), channelId);
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? (parsed as FeedPost[]) : [];
  } catch {
    // A feed we cannot parse is an empty feed. Never a crash, never a partial
    // render of posts whose chain we could not verify.
    return [];
  }
}

/** Drop a channel's feed cache (on leave/unsubscribe). */
export async function deleteChannelFeed(channelId: string): Promise<void> {
  await db().deleteChannelFeed(channelId);
}
