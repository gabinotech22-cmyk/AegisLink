/**
 * AegisLink — Sealed Public Channels REST client (Phase 2c, mobile)
 *
 * Thin client for the relay's /public-channels endpoints
 * (server/src/routes/publicChannels.ts). The relay only ever holds opaque signed
 * manifest blobs — these calls move blobs, never plaintext channel content. The
 * client MUST verify a fetched manifest's signature before trusting it
 * (verifyManifest in crypto/publicChannelKey); the relay's own check is not a
 * substitute (golden rule #7 — trust is client-verified, not relay-asserted).
 *
 * All endpoints 404 when the relay's PUBLIC_CHANNELS flag is off.
 */

import { SERVER_URL } from '../config';
import { ApiError } from '../api';

const TIMEOUT_MS = 10_000;

function makeSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${SERVER_URL}${path}`, {
    headers: { 'content-type': 'application/json' },
    signal: makeSignal(TIMEOUT_MS),
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

/** One row of the public directory — the signed manifest blob is opaque to the relay. */
export interface PublicChannelRecord {
  channel_id: string;
  signed_manifest_blob: string;
  delivery_token_hash_b64: string;
  channel_type: string;
  created_at: number;
}

export type PublicChannelType = 'open' | 'readonly' | 'moderated' | 'approval';

export interface RegisterChannelRequest {
  /** JSON-serialized signed manifest blob (sig + all manifest fields). */
  signedManifestBlob: string;
  /** SHA-256 hash of the channel delivery token, base64. */
  deliveryTokenHashB64: string;
  channelType: PublicChannelType;
}

/** Public directory of channels. Manifests are unverified blobs — verify before trust. */
export function listPublicChannels(): Promise<{ channels: PublicChannelRecord[] }> {
  return request<{ channels: PublicChannelRecord[] }>('/public-channels');
}

/** A single channel's signed manifest blob. Verify its signature before trusting it. */
export function getPublicChannelManifest(channelId: string): Promise<{ signed_manifest_blob: string }> {
  return request<{ signed_manifest_blob: string }>(
    `/public-channels/${encodeURIComponent(channelId)}/manifest`,
  );
}

/** Register a new channel (manifest signature is re-verified server-side). */
export function registerPublicChannel(body: RegisterChannelRequest): Promise<{ channelId: string }> {
  return request<{ channelId: string }>('/public-channels', {
    method: 'POST',
    body: JSON.stringify(body),
  });
}
