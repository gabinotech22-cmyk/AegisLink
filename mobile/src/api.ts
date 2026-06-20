import { SERVER_URL } from './config';

export interface IdentityRecord {
  aegisId: string;
  publicKey: string;        // X25519 public key, base64
  signingPublicKey: string; // Ed25519 signing key, base64
  createdAt: number;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

function makeSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: { 'content-type': 'application/json' },
    signal: makeSignal(10_000),
    ...init,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      detail = body.error ?? detail;
    } catch {
      /* keep statusText */
    }
    throw new ApiError(res.status, detail);
  }
  return res.json() as Promise<T>;
}

export function registerIdentity(
  aegisId: string,
  publicKeyB64: string,
  signingPublicKeyB64: string,
): Promise<IdentityRecord> {
  return request<IdentityRecord>('/identity', {
    method: 'POST',
    body: JSON.stringify({ aegisId, publicKey: publicKeyB64, signingPublicKey: signingPublicKeyB64 }),
  });
}

export function lookupIdentity(aegisId: string): Promise<IdentityRecord> {
  return request<IdentityRecord>(`/identity/${encodeURIComponent(aegisId)}`);
}

// NOTE: the HTTP poll endpoint was removed in the 2026-06 audit (A-8). Poll
// votes travel inside E2EE group messages (`[vote:...]`) and are tallied
// client-side — the relay never sees a vote. The old castAnonymousVote/
// fetchPollTally helpers were unused and called a ballot-stuffable,
// metadata-leaking endpoint; both are gone.

