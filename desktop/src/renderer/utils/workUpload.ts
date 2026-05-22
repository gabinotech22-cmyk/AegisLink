import { SERVER_URL } from '../config';

// ---------------------------------------------------------------------------
// Proof-of-Work helper
// ---------------------------------------------------------------------------

async function sha256hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function solvePoW(challenge: string, difficulty: number): Promise<string> {
  const prefix = '0'.repeat(difficulty);
  let nonce = 0;
  while (true) {
    const nonceHex = nonce.toString(16);
    const hash = await sha256hex(challenge + nonceHex);
    if (hash.startsWith(prefix)) {
      return nonceHex;
    }
    nonce++;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface BlobUploadResult {
  blobId: string;
  sizeBytes: number;
}

export async function uploadWorkBlob(file: File): Promise<BlobUploadResult> {
  // 1. Get challenge
  const challengeRes = await fetch(`${SERVER_URL}/blob/challenge`);
  if (!challengeRes.ok) {
    throw new Error(`Challenge request failed: ${challengeRes.status}`);
  }
  const { challenge, difficulty } = (await challengeRes.json()) as {
    challenge: string;
    difficulty: number;
  };

  // 2. Solve PoW
  const powNonce = await solvePoW(challenge, difficulty);

  // 3. Upload
  const form = new FormData();
  form.append('file', file);
  form.append('powChallenge', challenge);
  form.append('powNonce', powNonce);

  const uploadRes = await fetch(`${SERVER_URL}/blob/upload`, {
    method: 'POST',
    body: form,
  });
  if (!uploadRes.ok) {
    throw new Error(`Upload failed: ${uploadRes.status}`);
  }
  const data = (await uploadRes.json()) as { blobId: string };
  return { blobId: data.blobId, sizeBytes: file.size };
}
