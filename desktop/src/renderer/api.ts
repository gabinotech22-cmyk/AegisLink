/**
 * AegisLink Desktop — HTTP API client for the relay server.
 *
 * Ported from mobile/src/api.ts.
 * Only change: SERVER_URL imported from ./config (VITE_RELAY_URL env var)
 * instead of Expo's EXPO_PUBLIC_SERVER_URL.
 */

import { RELAY_URL } from './config';

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
  const res = await fetch(`${RELAY_URL}${path}`, {
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
    body: JSON.stringify({
      aegisId,
      publicKey: publicKeyB64,
      signingPublicKey: signingPublicKeyB64,
    }),
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
