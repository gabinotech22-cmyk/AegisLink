import { homeRelayBaseUrl } from './net/homeRelay';
import { relayFetch } from './net/relayHttp';
import type { RelayRef } from './net/relayRef';

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
  // F5: OUR relay — clearnet HTTPS for the official one, embedded Tor for a
  // self-hosted (.onion) home; relayFetch dispatches by URL.
  const res = await relayFetch(`${homeRelayBaseUrl()}${path}`, {
    headers: { 'content-type': 'application/json' },
    signal: makeSignal(10_000),
    ...(init as { method?: 'GET' | 'POST' | 'DELETE' | 'PUT'; body?: string; headers?: Record<string, string> }),
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

/**
 * Federation F2: look an identity up on ANOTHER relay, over Tor through the
 * relay pool. Same record shape and the same ApiError statuses as
 * `lookupIdentity`, so callers keep one error path. A relay that disables its
 * directory (IDENTITY_LOOKUP=off, FEDERATION-DESIGN §4.3) answers 404 like an
 * unknown id — the contact must then be added from a link/QR, which carries
 * the key.
 */
export async function lookupIdentityAt(relay: RelayRef, aegisId: string): Promise<IdentityRecord> {
  const { foreignRelayHttp } = require('./net/relayPool') as typeof import('./net/relayPool');
  const res = await foreignRelayHttp(relay, `/identity/${encodeURIComponent(aegisId)}`);
  if (!res) throw new ApiError(0, 'Network request failed');
  if (res.status !== 200) throw new ApiError(res.status, `HTTP ${res.status}`);
  try {
    return JSON.parse(res.body) as IdentityRecord;
  } catch {
    throw new ApiError(res.status, 'malformed identity record');
  }
}

// NOTE: the HTTP poll endpoint was removed in the 2026-06 audit (A-8). Poll
// votes travel inside E2EE group messages (`[vote:...]`) and are tallied
// client-side — the relay never sees a vote. The old castAnonymousVote/
// fetchPollTally helpers were unused and called a ballot-stuffable,
// metadata-leaking endpoint; both are gone.

