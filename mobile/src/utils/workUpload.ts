/**
 * workUpload — blob upload helper for Work channel attachments.
 *
 * Flow:
 *   1. GET  /blob/challenge  → { challenge, difficulty }
 *   2. Solve PoW: increment nonce until sha256hex(challenge + nonce) starts
 *      with `difficulty` zero hex chars.
 *   3. POST /blob/upload  multipart/form-data with file + powChallenge + powNonce
 *   4. Return { blobId, sizeBytes }
 */

import { SERVER_URL } from '../config';

import * as Crypto from 'expo-crypto';

// ─── PoW solver ───────────────────────────────────────────────────────────────

/** sha256 of a UTF-8 string, returned as lowercase hex. */
async function sha256hex(input: string): Promise<string> {
  return await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, input);
}

/** Solve PoW: find nonce s.t. sha256(challenge + nonce) starts with `difficulty` zero chars. */
async function solvePoW(challenge: string, difficulty: number): Promise<number> {
  const prefix = '0'.repeat(difficulty);
  let nonce = 0;
  while (true) {
    const hash = await sha256hex(challenge + nonce.toString());
    if (hash.startsWith(prefix)) return nonce;
    nonce++;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface BlobUploadResult {
  blobId: string;
  sizeBytes: number;
}

/**
 * Upload a local file URI to the blob relay.
 *
 * @param uri      local file URI (file:// or content://)
 * @param filename original filename (e.g. "photo.jpg")
 * @param mimeType MIME type (e.g. "image/jpeg")
 */
export async function uploadWorkBlob(
  uri: string,
  filename: string,
  mimeType: string,
): Promise<BlobUploadResult> {
  // 1. Get challenge
  const challengeRes = await fetch(`${SERVER_URL}/blob/challenge`);
  if (!challengeRes.ok) {
    throw new Error(`blob/challenge failed: ${challengeRes.status}`);
  }
  const { challenge, difficulty } = (await challengeRes.json()) as {
    challenge: string;
    difficulty: number;
  };

  // 2. Solve PoW
  const nonce = await solvePoW(challenge, difficulty);

  // 3. Build multipart body
  const form = new FormData();
  form.append('file', {
    uri,
    name: filename,
    type: mimeType,
  } as unknown as Blob);
  form.append('powChallenge', challenge);
  form.append('powNonce', nonce.toString());

  // 4. Upload
  const uploadRes = await fetch(`${SERVER_URL}/blob/upload`, {
    method: 'POST',
    body: form,
    // Do NOT set Content-Type — let fetch set the multipart boundary
  });

  if (!uploadRes.ok) {
    throw new Error(`blob/upload failed: ${uploadRes.status}`);
  }

  const data = (await uploadRes.json()) as { blobId: string; sizeBytes: number };
  return { blobId: data.blobId, sizeBytes: data.sizeBytes };
}
