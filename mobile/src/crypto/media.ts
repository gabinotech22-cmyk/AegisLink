import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as FileSystem from 'expo-file-system/legacy';
import { RELAY_URL as SERVER_URL } from '../config';
import { fetchPowChallengeAt, solvePoW } from './registration';

const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

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

  // 5. Resolve PoW challenge for the blob endpoint, then upload
  let powChallenge: string;
  let powNonce: string;
  try {
    const challenge = await fetchPowChallengeAt(`${SERVER_URL}/blob/challenge`);
    powChallenge = challenge.challenge;
    powNonce = await solvePoW(challenge.challenge, challenge.difficulty);
  } catch (e) {
    await FileSystem.deleteAsync(tempUri, { idempotent: true });
    throw new Error(`blob_pow_failed: ${(e as Error).message}`);
  }

  const uploadUrl = `${SERVER_URL}/blob/upload?powChallenge=${encodeURIComponent(powChallenge)}&powNonce=${encodeURIComponent(powNonce)}`;

  let uploadResult: Awaited<ReturnType<typeof FileSystem.uploadAsync>> | null = null;
  let lastUploadError: Error = new Error('upload_not_attempted');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt]);
    try {
      const result = await FileSystem.uploadAsync(uploadUrl, tempUri, {
        httpMethod: 'POST',
        uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
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

  await FileSystem.deleteAsync(tempUri, { idempotent: true });

  if (!uploadResult) {
    throw new Error(`Failed to upload media: ${lastUploadError.message}`);
  }

  const { id } = JSON.parse(uploadResult.body);

  // 6. Return formatted E2EE uri
  const keyB64 = encodeBase64(key);
  const nonceB64 = encodeBase64(nonce);
  return `blob:${id}:${keyB64}:${nonceB64}`;
}

/**
 * Downloads a ciphertext blob, decrypts it, and saves the plaintext locally.
 * @param mediaUri The formatted URI string `blob:<id>:<keyB64>:<nonceB64>`
 * @returns Local file URI to the decrypted media
 */
export async function downloadAndDecryptMedia(mediaUri: string, ext: string = 'jpg'): Promise<string> {
  if (!mediaUri.startsWith('blob:')) return mediaUri;

  const parts = mediaUri.split(':');
  if (parts.length !== 4) throw new Error('Invalid blob URI format');
  const [_, id, keyB64, nonceB64] = parts;

  const key = decodeBase64(keyB64);
  const nonce = decodeBase64(nonceB64);

  const downloadUrl = `${SERVER_URL}/blob/download/${id}`;

  // Download encrypted file (with retry on transient network errors)
  const tempEncryptedUri = FileSystem.cacheDirectory + `enc_${id}`;
  let downloadResult: Awaited<ReturnType<typeof FileSystem.downloadAsync>> | null = null;
  let lastDownloadError: Error = new Error('download_not_attempted');
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(RETRY_DELAYS_MS[attempt]);
    try {
      const result = await FileSystem.downloadAsync(downloadUrl, tempEncryptedUri);
      if (result.status === 200) {
        downloadResult = result;
        break;
      }
      lastDownloadError = new Error(`download_http_${result.status}`);
    } catch (e) {
      lastDownloadError = e instanceof Error ? e : new Error(String(e));
    }
  }
  if (!downloadResult) {
    throw new Error(`Failed to download media: ${lastDownloadError.message}`);
  }

  // Read encrypted data
  const encB64Data = await FileSystem.readAsStringAsync(tempEncryptedUri, { encoding: FileSystem.EncodingType.Base64 });
  const ciphertext = decodeBase64(encB64Data);

  // Decrypt
  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  if (!plaintext) {
    await FileSystem.deleteAsync(tempEncryptedUri, { idempotent: true });
    throw new Error('Media decryption failed (MAC mismatch or invalid key)');
  }

  // Save decrypted data to disk
  // Extension is configurable so RN can detect the media type (e.g. 'm4a' for audio)
  const tempDecryptedUri = FileSystem.cacheDirectory + `dec_${id}.${ext}`;
  const plainB64Data = encodeBase64(plaintext);
  await FileSystem.writeAsStringAsync(tempDecryptedUri, plainB64Data, { encoding: FileSystem.EncodingType.Base64 });

  // Cleanup ciphertext
  await FileSystem.deleteAsync(tempEncryptedUri, { idempotent: true });

  return tempDecryptedUri;
}
