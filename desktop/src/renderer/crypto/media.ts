import { nacl, secretboxAsync, secretboxOpenAsync } from './sodium';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import { normalizeOnion } from '../net/relayRef';
import { relayBaseUrl } from '../net/relayPoolCore';
import { getHomeRelay, homeRelayBaseUrl } from '../net/homeRelay';

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
  const ciphertext = await secretboxAsync(fileBytes, nonce, key);

  // 4. Fetch PoW challenge from relay
  const challengeRes = await fetch(`${homeRelayBaseUrl()}/blob/challenge`);
  if (!challengeRes.ok) throw new Error('Failed to fetch upload challenge');
  const { challenge, difficulty } = (await challengeRes.json()) as { challenge: string; difficulty: number };

  // 5. Solve proof-of-work (SHA-256 hashcash, same algo as server verifyPoW)
  const powNonce = await solvePoW(challenge, difficulty);

  // 6. Upload ciphertext with solved PoW as query params
  const uploadUrl = `${homeRelayBaseUrl()}/blob/upload?powChallenge=${challenge}&powNonce=${powNonce}`;
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: ciphertext as unknown as BodyInit,
  });
  if (!res.ok) throw new Error('Failed to upload media');
  const { id, token } = (await res.json()) as { id: string; token?: string };

  // 7. Wipe the key from local scope — it now lives only inside the E2EE message.
  // The download token (C-1) is appended as a 5th component so it rides inside
  // the E2EE envelope. Older relays without a token degrade to the v1 shape.
  const keyB64 = encodeBase64(key);
  const nonceB64 = encodeBase64(nonce);
  key.fill(0);
  // Federation F2: a blob uploaded to a non-official home relay carries that
  // relay's onion (v3) so a contact on another relay knows where to fetch it.
  return formatBlobUri(id, keyB64, nonceB64, token ?? '', getHomeRelay()?.onion ?? null);
}

export interface ParsedBlobUri {
  id: string;
  keyB64: string;
  nonceB64: string;
  token: string;
  /** Onion of the relay hosting the blob (v3); null = the official relay. */
  host: string | null;
}

/**
 * Parse a `blob:` URI (parity with mobile/src/crypto/media.ts):
 *   v3 `blob:<id>:<key>:<nonce>:<token>:<onion>`, v2 `...:<token>`, v1 `blob:<id>:<key>:<nonce>`.
 * A v3 host that is not a valid v3 onion makes the URI malformed — never a
 * silent fallback to the official relay.
 */
export function parseBlobUri(mediaUri: string): ParsedBlobUri | null {
  if (!mediaUri.startsWith('blob:')) return null;
  const parts = mediaUri.split(':');
  if (parts.length === 6) {
    const host = normalizeOnion(parts[5]);
    if (!host) return null;
    return { id: parts[1], keyB64: parts[2], nonceB64: parts[3], token: parts[4], host };
  }
  if (parts.length === 5) return { id: parts[1], keyB64: parts[2], nonceB64: parts[3], token: parts[4], host: null };
  if (parts.length === 4) return { id: parts[1], keyB64: parts[2], nonceB64: parts[3], token: '', host: null };
  return null;
}

/** Format for the wire; the host is appended (v3) only for a non-official relay. */
export function formatBlobUri(id: string, keyB64: string, nonceB64: string, token: string, host: string | null): string {
  const base = token ? `blob:${id}:${keyB64}:${nonceB64}:${token}` : `blob:${id}:${keyB64}:${nonceB64}`;
  return host && token ? `${base}:${host}` : base;
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

  const parsed = parseBlobUri(mediaUri);
  if (!parsed) throw new Error('Invalid blob URI format');
  const { id, keyB64, nonceB64, token, host } = parsed;

  const key = decodeBase64(keyB64);
  const nonce = decodeBase64(nonceB64);

  // A v3 blob lives on the sender's relay; the whole session is proxied through
  // Tor, so a .onion base resolves inside Tor with the same fetch().
  const base = `${host ? relayBaseUrl(host) : homeRelayBaseUrl()}/blob/download/${id}`;
  const downloadUrl = token ? `${base}?t=${encodeURIComponent(token)}` : base;
  const res = await fetch(downloadUrl);
  if (!res.ok) {
    key.fill(0);
    // B-7: 404/410 = the server's 24h blob TTL elapsed; the attachment is gone
    // for good. Surface a distinguishable error so the UI can show "adjunto
    // expirado" instead of a generic failure. Mirrors mobile's BlobFetchState.
    throw new Error(
      res.status === 404 || res.status === 410 ? 'attachment_expired' : 'attachment_unavailable',
    );
  }
  const ciphertext = new Uint8Array(await res.arrayBuffer());

  const plaintext = await secretboxOpenAsync(ciphertext, nonce, key);
  key.fill(0);
  if (!plaintext) {
    throw new Error('Media decryption failed (MAC mismatch or invalid key)');
  }

  const blob = new Blob([plaintext as unknown as ArrayBuffer], { type: mimeType });
  return URL.createObjectURL(blob);
}
