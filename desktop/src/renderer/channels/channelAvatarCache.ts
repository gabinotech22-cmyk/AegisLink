/**
 * Channel avatar cache (desktop). Parity in BEHAVIOUR with
 * mobile/src/channels/channelAvatarCache.ts, not in mechanism: mobile writes
 * verified bytes to expo-file-system, the renderer has no filesystem, so this
 * caches blob: URLs in memory.
 *
 * What must NOT differ is the check. The avatar comes from the relay, and the
 * relay is untrusted: the SHA-256 committed in the signed manifest is the only
 * thing that says the bytes are the ones the channel owner published. A relay
 * that swaps the image has to be caught here or nowhere. So the hash is
 * verified before the blob is ever handed to an <img>, the comparison is
 * constant-time (golden rule #8), and a mismatch yields null rather than a
 * best-effort render.
 *
 * The cost of an in-memory cache is a re-download after a restart. That is a
 * fair trade against writing image files next to the encrypted database.
 */
import { sha256 } from '@noble/hashes/sha2.js';
import nacl from 'tweetnacl';
import { channelAvatarUrl } from '../api/publicChannels';
import { logger } from '../utils/logger';

/** channelId -> blob: URL of verified bytes. */
const cache = new Map<string, string>();

/** One download per channel at a time, so N renders do not N-plex the request. */
const inflight = new Map<string, Promise<string | null>>();

/** Constant-time equality for byte arrays (golden rule #8). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && nacl.verify(a, b);
}

/**
 * Resolve a channel's avatar to a blob: URL, downloading and verifying if
 * needed. Returns null when the channel has no avatar, when the bytes fail the
 * SHA-256 committed in the manifest, or when the download fails.
 */
export async function resolveChannelAvatar(
  channelId: string,
  avatarHash: Uint8Array | null
): Promise<string | null> {
  if (!avatarHash || avatarHash.length !== 32) return null;

  const cached = cache.get(channelId);
  if (cached) return cached;

  const existing = inflight.get(channelId);
  if (existing) return existing;

  const promise = downloadAndVerify(channelId, avatarHash);
  inflight.set(channelId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(channelId);
  }
}

async function downloadAndVerify(
  channelId: string,
  avatarHash: Uint8Array
): Promise<string | null> {
  try {
    const res = await fetch(channelAvatarUrl(channelId));
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());

    if (!bytesEqual(sha256(bytes), avatarHash)) {
      // The relay served bytes the channel owner never signed for. Refuse them.
      logger.warn('[channelAvatarCache] SHA-256 mismatch -- relay served a tampered avatar');
      return null;
    }

    const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
    cache.set(channelId, url);
    return url;
  } catch (e) {
    logger.warn(`[channelAvatarCache] download failed: ${(e as Error).message}`);
    return null;
  }
}

/** Drop the cached avatar (replaced avatar, or channel removed). */
export async function evictChannelAvatar(channelId: string): Promise<void> {
  const url = cache.get(channelId);
  if (url) {
    URL.revokeObjectURL(url); // otherwise the bytes stay alive for the session
    cache.delete(channelId);
  }
}

/** SHA-256 of a data: URL or blob: URL, to commit an avatar during creation. */
export async function hashLocalFile(uri: string): Promise<Uint8Array> {
  const res = await fetch(uri);
  return sha256(new Uint8Array(await res.arrayBuffer()));
}

/**
 * Upload avatar bytes to the relay; returns the server-side blob id.
 *
 * Gated by the same proof-of-work as mobile: the blob endpoint takes bytes from
 * anyone, so PoW is what stops it becoming free storage for a stranger.
 */
export async function uploadAvatarBlob(uri: string): Promise<string> {
  const { fetchPowChallengeAt, solvePoW } = await import('../crypto/registration');
  const { SERVER_URL } = await import('../config');

  const challenge = await fetchPowChallengeAt(`${SERVER_URL}/blob/challenge`);
  const powNonce = await solvePoW(challenge.challenge, challenge.difficulty);
  const uploadUrl =
    `${SERVER_URL}/blob/upload?powChallenge=${encodeURIComponent(challenge.challenge)}` +
    `&powNonce=${encodeURIComponent(powNonce)}`;

  const src = await fetch(uri);
  const bytes = new Uint8Array(await src.arrayBuffer());

  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: bytes as BodyInit,
  });
  if (!res.ok) throw new Error(`avatar_upload_http_${res.status}`);

  const body = (await res.json()) as { id: string };
  return body.id;
}

/**
 * Seed the cache with the local image chosen during creation, so the owner sees
 * their own avatar immediately instead of waiting for a round trip through the
 * relay that is only going to hand the same bytes back.
 */
export async function cacheLocalAvatar(channelId: string, localUri: string): Promise<string> {
  const res = await fetch(localUri);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const url = URL.createObjectURL(new Blob([bytes as BlobPart]));
  const prev = cache.get(channelId);
  if (prev) URL.revokeObjectURL(prev);
  cache.set(channelId, url);
  return url;
}
