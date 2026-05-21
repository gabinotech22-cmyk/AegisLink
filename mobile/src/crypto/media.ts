import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as FileSystem from 'expo-file-system/legacy';
import { SERVER_URL } from '../config';

/**
 * Encrypts a local file and uploads the ciphertext to the server's generic blob store.
 * @param fileUri Local file URI (e.g. from ImagePicker)
 * @returns The media URI formatted as `blob:<id>:<keyB64>:<nonceB64>`
 */
export async function encryptAndUploadMedia(fileUri: string): Promise<string> {
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

  // 5. Upload binary ciphertext
  const uploadUrl = `${SERVER_URL}/blob/upload`;
  const uploadResult = await FileSystem.uploadAsync(uploadUrl, tempUri, {
    httpMethod: 'POST',
    uploadType: FileSystem.FileSystemUploadType.BINARY_CONTENT,
  });

  await FileSystem.deleteAsync(tempUri, { idempotent: true });

  if (uploadResult.status !== 200) {
    throw new Error('Failed to upload media');
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
  
  // Download encrypted file
  const tempEncryptedUri = FileSystem.cacheDirectory + `enc_${id}`;
  const downloadResult = await FileSystem.downloadAsync(downloadUrl, tempEncryptedUri);
  if (downloadResult.status !== 200) {
    throw new Error('Failed to download media');
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
