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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: { 'content-type': 'application/json' },
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

export function castAnonymousVote(
  pollId: string,
  voterHash: string,
  optionIndex: number,
): Promise<{ ok: boolean; counts: number[] }> {
  return request<{ ok: boolean; counts: number[] }>('/polls/vote', {
    method: 'POST',
    body: JSON.stringify({ pollId, voterHash, optionIndex }),
  });
}

export function fetchPollTally(pollId: string): Promise<{ counts: number[] }> {
  return request<{ counts: number[] }>(`/polls/${encodeURIComponent(pollId)}`);
}

