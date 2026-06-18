import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { SERVER_URL } from '../config';

/**
 * Encrypted media upload / download for the Electron renderer.
 *
 * Differences vs. mobile:
 *   - Mobile reads/writes files via expo-file-system. The renderer uses the
 *     standard browser File API: Blob/ArrayBuffer for I/O, fetch() for
 *     transport, and URL.createObjectURL for on-screen rendering.
 *   - The plaintext NEVER touches disk on the renderer side; decrypted bytes
 *     live in memory as a Blob URL until the consumer drops the reference.
 */

// ── PoW helpers (mirrors server/src/__tests__/blob.test.ts solvePoW) ─────────

function hasLeadingZeroBits(buf: Uint8Array, bits: number): boolean {
  let remaining = bits;
  for (const byte of buf) {
    if (remaining <= 0) break;
    const check = remaining >= 8 ? 8 : remaining;
    const mask = 0xff & (0xff << (8 - check));
    if ((byte & mask) !== 0) return false;
    remaining -= 8;
  }
  return true;
}

async function solvePoW(challenge: string, difficulty: number): Promise<string> {
  const enc = new TextEncoder();
  let nonce = 0;
  while (true) {
    const nonceHex = nonce.toString(16);
    const data = enc.encode(nonceHex + challenge);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
    if (hasLeadingZeroBits(digest, difficulty)) return nonceHex;
    nonce++;
  }
}

/**
 * Encrypts a File/Blob locally and uploads the ciphertext to the relay.
 * Returns a `blob:<id>:<keyB64>:<nonceB64>` URI — same wire format as mobile.
 *
 * @param file Browser File / Blob (e.g. from <input type="file">)
 */
export async function encryptAndUploadMedia(file: Blob): Promise<string> {
  // 1. Read file bytes
  const fileBytes = new Uint8Array(await file.arrayBuffer());

  // 2. Generate random key and nonce
  const key = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);

  // 3. Encrypt via XSalsa20-Poly1305
  const ciphertext = nacl.secretbox(fileBytes, nonce, key);

  // 4. Fetch PoW challenge from relay
  const challengeRes = await fetch(`${SERVER_URL}/blob/challenge`);
  if (!challengeRes.ok) throw new Error('Failed to fetch upload challenge');
  const { challenge, difficulty } = (await challengeRes.json()) as { challenge: string; difficulty: number };

  // 5. Solve proof-of-work (SHA-256 hashcash, same algo as server verifyPoW)
  const powNonce = await solvePoW(challenge, difficulty);

  // 6. Upload ciphertext with solved PoW as query params
  const uploadUrl = `${SERVER_URL}/blob/upload?powChallenge=${challenge}&powNonce=${powNonce}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext as unknown as BodyInit,
  });
  if (!res.ok) throw new Error('Failed to upload media');
  const { id } = (await res.json()) as { id: string };

  // 7. Wipe the key from local scope — it now lives only inside the E2EE message.
  const keyB64 = encodeBase64(key);
  const nonceB64 = encodeBase64(nonce);
  key.fill(0);
  return `blob:${id}:${keyB64}:${nonceB64}`;
}

/**
 * Downloads ciphertext, decrypts it, and returns an in-memory Object URL the
 * caller can hand to an <img>, <audio> or <video> element. The caller is
 * responsible for revoking the URL when no longer needed.
 *
 * @param mediaUri The wire URI `blob:<id>:<keyB64>:<nonceB64>`
 * @param mimeType Optional MIME hint (e.g. 'image/jpeg', 'audio/mp4')
 */
export async function downloadAndDecryptMedia(
  mediaUri: string,
  mimeType: string = 'application/octet-stream',
): Promise<string> {
  if (!mediaUri.startsWith('blob:')) return mediaUri;

  const parts = mediaUri.split(':');
  if (parts.length !== 4) throw new Error('Invalid blob URI format');
  const [, id, keyB64, nonceB64] = parts;

  const key = decodeBase64(keyB64);
  const nonce = decodeBase64(nonceB64);

  const downloadUrl = `${SERVER_URL}/blob/download/${id}`;
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    key.fill(0);
    throw new Error('Failed to download media');
  }
  const ciphertext = new Uint8Array(await res.arrayBuffer());

  const plaintext = nacl.secretbox.open(ciphertext, nonce, key);
  key.fill(0);
  if (!plaintext) {
    throw new Error('Media decryption failed (MAC mismatch or invalid key)');
  }

  const blob = new Blob([plaintext as unknown as ArrayBuffer], { type: mimeType });
  return URL.createObjectURL(blob);
}
