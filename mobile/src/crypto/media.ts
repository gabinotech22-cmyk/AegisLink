import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as FileSystem from 'expo-file-system/legacy';
import { RELAY_URL as SERVER_URL } from '../config';
import { fetchPowChallengeAt, solvePoW } from './registration';

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/**
 * Persistent ENCRYPTED media store. Ciphertext blobs are kept here under
 * documentDirectory so chat media survives cache purges, app restarts AND the
 * server's 24h blob TTL — while plaintext is only ever decrypted on demand into
 * the (purgeable) cache directory. This keeps the "zero plaintext at rest"
 * forensic posture: at-rest media is always the NaCl-secretbox ciphertext.
 */
const MEDIA_DIR = (FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? '') + 'media/';

async function ensureMediaDir(): Promise<void> {
  try {
    const info = await FileSystem.getInfoAsync(MEDIA_DIR);
    if (!info.exists) await FileSystem.makeDirectoryAsync(MEDIA_DIR, { intermediates: true });
  } catch { /* best-effort */ }
}

const encPathFor = (id: string): string => `${MEDIA_DIR}${id}.enc`;
const decPathFor = (id: string, ext: string): string => `${FileSystem.cacheDirectory}dec_${id}.${ext}`;

/**
 * Parse a `blob:` URI. Two on-wire shapes are accepted:
 *   - v2 (current): `blob:<id>:<key>:<nonce>:<token>` — token authorizes download
 *   - v1 (legacy):  `blob:<id>:<key>:<nonce>` — pre-C-1, no download token
 * base64 never contains ':', so positional splitting is unambiguous. Returns
 * null for non-blob or malformed URIs.
 */
function parseBlobUri(
  mediaUri: string
): { id: string; keyB64: string; nonceB64: string; token: string } | null {
  if (!mediaUri.startsWith('blob:')) return null;
  const parts = mediaUri.split(':');
  if (parts.length === 5) {
    return { id: parts[1], keyB64: parts[2], nonceB64: parts[3], token: parts[4] };
  }
  if (parts.length === 4) {
    return { id: parts[1], keyB64: parts[2], nonceB64: parts[3], token: '' };
  }
  return null;
}

/** Build the download URL, appending the authorization token when present (v2). */
function downloadUrlFor(id: string, token: string): string {
  const base = `${SERVER_URL}/blob/download/${id}`;
  return token ? `${base}?t=${encodeURIComponent(token)}` : base;
}

async function fileExists(uri: string): Promise<boolean> {
  try { return (await FileSystem.getInfoAsync(uri)).exists; } catch { return false; }
}

/** Exponential-backoff delays for upload/download retries: 0 ms, 500 ms, 1500 ms */
const RETRY_DELAYS_MS = [0, 500, 1500];
const MAX_ATTEMPTS = RETRY_DELAYS_MS.length;

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'video/mp4', 'video/quicktime',
  'audio/mpeg', 'audio/mp4', 'audio/m4a', 'audio/x-m4a', 'audio/aac', 'audio/ogg', 'audio/webm',
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
]);

/**
 * Purges all plaintext-decrypted and upload-temp files from the FS cache directory.
 * Call on logout/panic and after 30 s in background to reduce forensic window.
 */
export async function purgeCachedDecryptedMedia(): Promise<void> {
  const cacheDir = FileSystem.cacheDirectory;
  if (!cacheDir) return;
  const files = await FileSystem.readDirectoryAsync(cacheDir).catch(() => [] as string[]);
  await Promise.all(
    (files as string[])
      .filter((f) => f.startsWith('dec_') || f.startsWith('upload_tmp_'))
      .map((f) => FileSystem.deleteAsync(cacheDir + f, { idempotent: true }).catch(() => {}))
  );
}

/**
 * Encrypts a local file and uploads the ciphertext to the server's generic blob store.
 * @param fileUri Local file URI (e.g. from ImagePicker)
 * @param mimeType Optional MIME type to validate against the allow-list
 * @returns The media URI formatted as `blob:<id>:<keyB64>:<nonceB64>`
 */
export async function encryptAndUploadMedia(fileUri: string, mimeType?: string): Promise<string> {
  // 0. Validate size and MIME type before reading the file into memory
  const info = await FileSystem.getInfoAsync(fileUri);
  if (info.exists && info.size > MAX_BYTES) {
    throw new Error('file_too_large');
  }
  if (mimeType !== undefined && !ALLOWED_MIME.has(mimeType)) {
    throw new Error('file_type_not_allowed');
  }

  // 1. Read file and convert to bytes
  const b64Data = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
  const fileBytes = decodeBase64(b64Data);

  // 2. Generate random key and nonce
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);

  // 3. Encrypt via XSalsa20-Poly1305
  const ciphertext = nacl.secretbox(fileBytes, nonce, key);

  // 4. Write ciphertext to temporary file
  const tempUri = FileSystem.cacheDirectory + 'upload_tmp_' + Date.now();
  await FileSystem.writeAsStringAsync(tempUri, encodeBase64(ciphertext), { encoding: FileSystem.EncodingType.Base64 });

  // 5. Upload with retries. Each attempt resolves a FRESH PoW challenge: the
  // relay CONSUMES the challenge the instant its PoW check passes — even when the
  // request then fails for another reason. Reusing the same challenge on a retry
  // would therefore always come back `challenge_unknown` (403), making the retry
  // loop useless. Re-solving per attempt lets a retry actually recover.
  let uploadResult: Awaited<ReturnType<typeof FileSystem.uploadAsync>> | null = null;
  let lastUploadError: Error = new Error('upload_not_attempted');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt]);

    let uploadUrl: string;
    try {
      const challenge = await fetchPowChallengeAt(`${SERVER_URL}/blob/challenge`);
      const powNonce = await solvePoW(challenge.challenge, challenge.difficulty);
      uploadUrl = `${SERVER_URL}/blob/upload?powChallenge=${encodeURIComponent(challenge.challenge)}&powNonce=${encodeURIComponent(powNonce)}`;
    } catch (e) {
      lastUploadError = new Error(`blob_pow_failed: ${(e as Error).message}`);
      continue;
    }

    try {
      const result = await FileSystem.uploadAsync(uploadUrl, tempUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
        // MUST declare a Content-Type: the relay's body parser (express.raw via
        // type-is) only buffers the request into a Buffer when a Content-Type is
        // present. Without this header uploadAsync sends none → express.raw skips
        // → req.body is not a Buffer → 400 body_must_be_binary. This is what broke
        // ALL media (image/audio/gif), in both 1:1 and group chats, since they all
        // share this single upload path.
        headers: { 'Content-Type': 'application/octet-stream' },
      });
      if (result.status === 200) {
        uploadResult = result;
        break;
      }
      lastUploadError = new Error(`upload_http_${result.status}`);
    } catch (e) {
      lastUploadError = e instanceof Error ? e : new Error(String(e));
    }
  }

  if (!uploadResult) {
    await FileSystem.deleteAsync(tempUri, { idempotent: true });
    throw new Error(`Failed to upload media: ${lastUploadError.message}`);
  }

  const { id, token } = JSON.parse(uploadResult.body) as { id: string; token?: string };

  // 6. Persist the ciphertext locally (encrypted-at-rest) so the sender can
  // re-render the image after the cache is purged, without depending on the
  // server blob (which is deleted after 24h). Move the temp ciphertext into
  // the persistent media dir keyed by the server-assigned id.
  await ensureMediaDir();
  try {
    await FileSystem.moveAsync({ from: tempUri, to: encPathFor(id) });
  } catch {
    // Move can fail across volumes — fall back to copy, then drop the temp.
    try { await FileSystem.copyAsync({ from: tempUri, to: encPathFor(id) }); } catch { /* non-fatal */ }
    await FileSystem.deleteAsync(tempUri, { idempotent: true });
  }

  // 7. Return formatted E2EE uri. The download token (C-1) is appended as a 5th
  // component so it travels inside the E2EE envelope and never reaches the relay
  // out-of-band. Older relays that don't return a token degrade to the v1 shape.
  const keyB64 = encodeBase64(key);
  const nonceB64 = encodeBase64(nonce);
  return token ? `blob:${id}:${keyB64}:${nonceB64}:${token}` : `blob:${id}:${keyB64}:${nonceB64}`;
}

/** Outcome of fetching a server blob into the local encrypted-at-rest store. */
export type BlobFetchState = 'ok' | 'expired' | 'unavailable';

/**
 * Ensure the ENCRYPTED ciphertext for a `blob:` URI is cached locally and
 * persistently (no decryption). Call this at receive time while online so the
 * media survives the server's 24h blob TTL and the device going offline.
 *
 * Returns `'ok'` once the ciphertext is local, `'expired'` if the server reports
 * the blob is gone for good (B-7: HTTP 404/410 — the 24h TTL elapsed), or
 * `'unavailable'` if it could not be fetched after the transient-error retries.
 */
export async function persistEncryptedBlob(mediaUri: string): Promise<BlobFetchState> {
  const parsed = parseBlobUri(mediaUri);
  if (!parsed) return 'unavailable';
  const { id, token } = parsed;
  await ensureMediaDir();
  if (await fileExists(encPathFor(id))) return 'ok'; // already persisted
  const downloadUrl = downloadUrlFor(id, token);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt]);
    try {
      const result = await FileSystem.downloadAsync(downloadUrl, encPathFor(id));
      if (result.status === 200) return 'ok';
      await FileSystem.deleteAsync(encPathFor(id), { idempotent: true });
      // 404/410 = the server's 24h TTL elapsed; the blob is gone for good. Stop
      // retrying (it will never reappear) and report it as expired so the UI can
      // render "adjunto expirado" instead of an endless spinner.
      if (result.status === 404 || result.status === 410) return 'expired';
    } catch { /* network error — retry */ }
  }
  return 'unavailable';
}

/**
 * Resolve a `blob:<id>:<key>:<nonce>` URI to a local DECRYPTED file path.
 * Decryption happens on demand into the purgeable cache dir; the ciphertext is
 * kept persistently in MEDIA_DIR. Returns null if the media can no longer be
 * recovered (no local ciphertext and the server blob has expired). Non-blob
 * URIs are returned as-is when the file still exists.
 */
/** Resolution of a media URI: a usable local `path`, or null with the reason. */
export type MediaResolution =
  | { path: string; state: 'ok' }
  | { path: null; state: 'expired' | 'unavailable' };

/**
 * Like {@link resolveMedia} but reports WHY a blob is unrecoverable so the UI can
 * distinguish a permanently-expired attachment (B-7: server TTL elapsed → show
 * "adjunto expirado") from a transient failure (still downloading / decrypt
 * error → spinner or retry).
 */
export async function resolveMediaDetailed(mediaUri: string, ext: string = 'jpg'): Promise<MediaResolution> {
  if (!mediaUri) return { path: null, state: 'unavailable' };
  if (!mediaUri.startsWith('blob:')) {
    return (await fileExists(mediaUri))
      ? { path: mediaUri, state: 'ok' }
      : { path: null, state: 'unavailable' };
  }
  const parsed = parseBlobUri(mediaUri);
  if (!parsed) return { path: null, state: 'unavailable' };
  const { id, keyB64, nonceB64 } = parsed;

  const decPath = decPathFor(id, ext);
  if (await fileExists(decPath)) return { path: decPath, state: 'ok' }; // already decrypted in cache

  await ensureMediaDir();
  if (!(await fileExists(encPathFor(id)))) {
    const fetched = await persistEncryptedBlob(mediaUri);
    if (fetched === 'expired') return { path: null, state: 'expired' };
    if (!(await fileExists(encPathFor(id)))) return { path: null, state: 'unavailable' };
  }

  try {
    const encB64 = await FileSystem.readAsStringAsync(encPathFor(id), { encoding: FileSystem.EncodingType.Base64 });
    const ciphertext = decodeBase64(encB64);
    const plaintext = nacl.secretbox.open(ciphertext, decodeBase64(nonceB64), decodeBase64(keyB64));
    if (!plaintext) return { path: null, state: 'unavailable' };
    await FileSystem.writeAsStringAsync(decPath, encodeBase64(plaintext), { encoding: FileSystem.EncodingType.Base64 });
    return { path: decPath, state: 'ok' };
  } catch {
    return { path: null, state: 'unavailable' };
  }
}

export async function resolveMedia(mediaUri: string, ext: string = 'jpg'): Promise<string | null> {
  return (await resolveMediaDetailed(mediaUri, ext)).path;
}

/**
 * Downloads a ciphertext blob, decrypts it, and returns a local plaintext path.
 * Now backed by the persistent encrypted-at-rest store (resolveMedia), so the
 * ciphertext is retained locally and the plaintext can be re-derived after a
 * cache purge. Throws if the media cannot be recovered.
 * @param mediaUri The formatted URI string `blob:<id>:<keyB64>:<nonceB64>`
 */
export async function downloadAndDecryptMedia(mediaUri: string, ext: string = 'jpg'): Promise<string> {
  if (!mediaUri.startsWith('blob:')) return mediaUri;
  const res = await resolveMediaDetailed(mediaUri, ext);
  if (res.path) return res.path;
  // Distinguishable causes so callers can surface "adjunto expirado" (B-7).
  throw new Error(res.state === 'expired' ? 'attachment_expired' : 'attachment_unavailable');
}

/**
 * Encrypts and uploads multiple files in parallel.
 * Each item's `uri` is a local file path; `type` is the MIME type (optional).
 * Returns an array of `Attachment` objects with `uri` set to the `blob:...` reference.
 */
export async function encryptAndUploadAll(
  items: Array<{ uri: string; type?: string; fileName?: string; width?: number; height?: number; duration?: number }>
): Promise<import('../db/local').Attachment[]> {
  const results = await Promise.all(
    items.map(async (item) => {
      const blobUri = await encryptAndUploadMedia(item.uri, item.type);
      const att: import('../db/local').Attachment = {
        type: item.type?.startsWith('video') ? 'video'
            : item.type?.startsWith('audio') ? 'audio'
            : item.type?.startsWith('image') ? 'image'
            : item.fileName ? 'file'
            : 'image',
        uri: blobUri,
        fileName: item.fileName,
        mimeType: item.type,
        width: item.width,
        height: item.height,
        duration: item.duration,
      };
      return att;
    })
  );
  return results;
}

/** Delete the persistent encrypted copy for a blob URI (e.g. on message delete). */
export async function deletePersistedMedia(mediaUri: string): Promise<void> {
  const parsed = parseBlobUri(mediaUri);
  if (!parsed) return;
  await FileSystem.deleteAsync(encPathFor(parsed.id), { idempotent: true }).catch(() => {});
}
