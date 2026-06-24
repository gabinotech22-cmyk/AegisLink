/**
 * AegisLink — Account deletion (B-2) — desktop
 * ---------------------------------------------------------------------------
 * Renderer-side twin of mobile/src/crypto/accountDeletion.ts. Builds the
 * authenticated `DELETE /identity/:id` request and reports the outcome; the
 * caller runs the local wipe (window.aegis.db.wipeDatabase + secureStorage
 * wipe via db/local.ts → wipeDatabase()) and identity reset.
 *
 * Auth mirrors the prekey-upload scheme (see `registration.ts`, `:prekeys:`):
 * an Ed25519 detached signature over `${aegisId}:delete:${floor(ts / 30000)}`
 * proving possession of the identity's signing secret key (golden rule #3).
 * `ts = Date.now()` must be within ±60s of server time.
 *
 * Errors are returned (never thrown) so the UI can decide whether to wipe.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { utf8ToBytes } from '@noble/hashes/utils.js';
import type { Identity } from './identity';
import { RELAY_URL } from '../config';

export interface DeleteAccountResult {
  /**
   * true only when no server-side trace remains: HTTP 200 (deleted) or 404
   * (the relay already holds no record — the deletion goal is met either way).
   */
  ok: boolean;
  /** HTTP status, when a response was received. */
  status?: number;
  /** Human-readable failure reason (never thrown). */
  error?: string;
}

function makeTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Sign and issue `DELETE /identity/:id` against the relay.
 *
 * 200 / 404 → `ok: true`. Any other status (403 invalid_signature, 400 bad
 * timestamp/body, 429 rate-limited, 5xx) or a network error → `ok: false` with
 * a message; the caller must NOT wipe locally unless the user explicitly
 * chooses to.
 */
export async function deleteAccountOnRelay(identity: Identity): Promise<DeleteAccountResult> {
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const sig = encodeBase64(
    nacl.sign.detached(
      utf8ToBytes(`${identity.aegisId}:delete:${timeBucket}`),
      identity.signingSecretKey,
    ),
  );

  let res: Response;
  try {
    res = await fetch(
      `${trimSlash(RELAY_URL)}/identity/${encodeURIComponent(identity.aegisId)}`,
      {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ sig, ts }),
        signal: makeTimeoutSignal(10_000),
      },
    );
  } catch (e) {
    return { ok: false, error: `network error: ${e instanceof Error ? e.message : 'unknown'}` };
  }

  if (res.status === 200 || res.status === 404) {
    return { ok: true, status: res.status };
  }

  let reason = res.statusText || `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) reason = body.error;
  } catch {
    /* keep statusText */
  }
  return { ok: false, status: res.status, error: reason };
}
