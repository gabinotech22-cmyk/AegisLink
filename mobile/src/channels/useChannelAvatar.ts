/**
 * useChannelAvatar -- React hook that resolves a channel's avatar to a local
 * file:// URI (downloading + SHA-256 verifying on first access, then cached).
 *
 * Returns null while loading or when no avatar is available; the caller falls
 * back to the identicon via Avatar's existing `seed` prop.
 */

import { useState, useEffect } from 'react';
import { resolveChannelAvatar } from './channelAvatarCache';

/**
 * @param channelId   Base64 channel ID
 * @param avatarHash  SHA-256 from the signed manifest (32 bytes), or null
 */
export function useChannelAvatar(
  channelId: string,
  avatarHash: Uint8Array | null,
): string | null {
  const [uri, setUri] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!avatarHash) {
      setUri(null);
      return;
    }
    void resolveChannelAvatar(channelId, avatarHash).then((resolved) => {
      if (!cancelled) setUri(resolved);
    });
    return () => { cancelled = true; };
  }, [channelId, avatarHash]);

  return uri;
}
