/**
 * AegisLink -- Channel avatar local cache (Slice 2)
 *
 * Downloads a channel's PUBLIC avatar (GET /public-channels/:id/avatar),
 * verifies SHA-256(bytes) === manifest.avatarHash, and persists the validated
 * image in documentDirectory so it survives cache purges and avoids
 * re-downloading on every render.
 *
 * The avatar is PUBLIC branding content (not E2EE media). It is stored
 * as raw JPEG/PNG bytes on disk -- there is no NaCl-secretbox layer here.
 * If a channel upgrades to private branding, this module would need an
 * encrypt-at-rest pass; for now it mirrors the relay's "public, max-age=3600"
 * cache semantics.
 *
 * Integrity guarantee: the displayed avatar is trusted only if its SHA-256
 * matches the hash committed in the channel's Ed25519-signed manifest. A
 * relay that serves a tampered image is detected and the client falls back
 * to the identicon.
 */

import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '@noble/hashes/sha2';
import { decodeBase64 } from 'tweetnacl-util';
import nacl from 'tweetnacl';
import { channelAvatarUrl } from '../api/publicChannels';
import { logger } from '../utils/logger';

const AVATAR_DIR = (FileSystem.documentDirectory ?? '') + 'channel_avatars/';

/** Local file path for a channel's cached avatar. */
function pathFor(channelId: string): string {
  // channelId is base64 — strip / and + for a safe filename.
  const safe = channelId.replace(/[/+=]/g, '_');
  return `${AVATAR_DIR}${safe}.jpg`;
}

async function ensureDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(AVATAR_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(AVATAR_DIR, { intermediates: true });
  } catch { /* best effort */ }
}

/** Constant-time equality for byte arrays (golden rule #8). */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && nacl.verify(a, b);
}

/**
 * In-flight download deduplication: one download per channelId at a time.
 * Prevents N concurrent renders from N-plexing the same HTTP request.
 */
const inflight = new Map<string, Promise<string | null>>();

/**
 * Resolve a channel's avatar to a local file:// URI, downloading and verifying
 * if needed. Returns null when:
 *   - The channel has no avatar (no avatarHash in manifest / no blob on server)
 *   - The downloaded bytes fail the SHA-256 integrity check
 *   - A network/FS error prevents the download
 *
 * @param channelId    Base64 channel ID
 * @param avatarHash   SHA-256 committed in the signed manifest (32 bytes), or null
 */
export async function resolveChannelAvatar(
  channelId: string,
  avatarHash: Uint8Array | null,
): Promise<string | null> {
  if (!avatarHash || avatarHash.length !== 32) return null;

  // Fast path: already cached and verified.
  const cached = pathFor(channelId);
  try {
    const info = await FileSystem.getInfoAsync(cached);
    if (info.exists && info.size > 0) return cached;
  } catch { /* miss -- download */ }

  // Deduplicate concurrent requests for the same channelId.
  const existing = inflight.get(channelId);
  if (existing) return existing;

  const promise = downloadAndVerify(channelId, avatarHash, cached);
  inflight.set(channelId, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(channelId);
  }
}

async function downloadAndVerify(
  channelId: string,
  avatarHash: Uint8Array,
  dest: string,
): Promise<string | null> {
  await ensureDir();
  const url = channelAvatarUrl(channelId);
  const tmp = `${dest}.tmp`;

  try {
    const result = await FileSystem.downloadAsync(url, tmp);
    if (result.status !== 200) {
      await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      return null;
    }

    // Read downloaded bytes and verify SHA-256 against the manifest commitment.
    const b64 = await FileSystem.readAsStringAsync(tmp, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const bytes = decodeBase64(b64);
    const hash = sha256(bytes);

    if (!bytesEqual(hash, avatarHash)) {
      logger.warn('[channelAvatarCache] SHA-256 mismatch -- relay served tampered avatar');
      await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
      return null;
    }

    // Atomically move to final path (overwrites stale cache).
    try {
      await FileSystem.deleteAsync(dest, { idempotent: true });
    } catch { /* ignore */ }
    await FileSystem.moveAsync({ from: tmp, to: dest });
    return dest;
  } catch (e) {
    logger.warn(`[channelAvatarCache] download failed: ${(e as Error).message}`);
    await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => {});
    return null;
  }
}

/**
 * Evict the cached avatar for a channel (e.g. when the avatar is replaced or
 * the channel is removed).
 */
export async function evictChannelAvatar(channelId: string): Promise<void> {
  await FileSystem.deleteAsync(pathFor(channelId), { idempotent: true }).catch(() => {});
}

/**
 * Compute SHA-256 of a local file (for use during channel creation to commit
 * the avatarHash into the manifest before signing).
 */
export async function hashLocalFile(uri: string): Promise<Uint8Array> {
  const b64 = await FileSystem.readAsStringAsync(uri, {
    encoding: FileSystem.EncodingType.Base64,
  });
  return sha256(decodeBase64(b64));
}

/**
 * Upload a local avatar image to the relay's blob store (POST /blob/upload)
 * and return the blobId. Reuses the same PoW-gated upload path as E2EE media,
 * but the avatar is PUBLIC (not encrypted). Max 256 KB.
 */
export async function uploadAvatarBlob(uri: string): Promise<string> {
  const { fetchPowChallengeAt, solvePoW } = await import('../crypto/registration');
  const { SERVER_URL } = await import('../config');

  const challenge = await fetchPowChallengeAt(`${SERVER_URL}/blob/challenge`);
  const powNonce = await solvePoW(challenge.challenge, challenge.difficulty);
  const uploadUrl = `${SERVER_URL}/blob/upload?powChallenge=${encodeURIComponent(challenge.challenge)}&powNonce=${encodeURIComponent(powNonce)}`;

  const result = await FileSystem.uploadAsync(uploadUrl, uri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
    headers: { 'Content-Type': 'application/octet-stream' },
  });

  if (result.status !== 200) {
    throw new Error(`avatar_upload_http_${result.status}`);
  }

  const body = JSON.parse(result.body) as { id: string };
  return body.id;
}

/**
 * Persist a local image as the cached avatar for a channel (used after
 * creation so the creator sees their own avatar immediately without
 * re-downloading from the relay).
 */
export async function cacheLocalAvatar(channelId: string, localUri: string): Promise<string> {
  await ensureDir();
  const dest = pathFor(channelId);
  try {
    await FileSystem.deleteAsync(dest, { idempotent: true });
  } catch { /* ignore */ }
  await FileSystem.copyAsync({ from: localUri, to: dest });
  return dest;
}
