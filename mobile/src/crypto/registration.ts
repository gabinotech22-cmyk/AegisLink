/**
 * AegisLink — Registration (Fase 1)
 * ---------------------------------------------------------------------------
 * Uploads the public identity profile and prekey bundle to the relay after
 * anonymous onboarding completes. NEVER uploads:
 *   - Identity.secretKey / signingSecretKey
 *   - PreKeySecrets.signedPreKey.secretKey
 *   - PreKeySecrets.opkSecrets values
 *
 * Privacy invariants:
 *   - No PII in any request body.
 *   - PoW gates registration so the relay rate-limits without IP logs.
 *   - All errors are surfaced as `{ ok: false, error }` — never thrown to UI.
 */

import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import type {
  Identity,
  OneTimePreKeyPublic,
  PreKeySecrets,
  SignedPreKeyPublic,
} from './types';

export interface PowChallenge {
  challenge: string;
  difficulty: number;
}

export interface RegistrationResult {
  ok: boolean;
  error?: string;
}

interface IdentityPostBody {
  aegisId: string;
  publicKey: string;
  signingPublicKey: string;
  powChallenge: string;
  powNonce: string;
}

interface PreKeysPostBody {
  aegisId: string;
  /** Ed25519 signature over `${aegisId}:prekeys:${floor(ts/30000)}` — auth for the upload. */
  sig: string;
  /** Client timestamp (ms); server requires |now - ts| <= 60s. */
  ts: number;
  signedPreKey: SignedPreKeyPublic;
  oneTimePreKeys: OneTimePreKeyPublic[];
}

// ---------------------------------------------------------------------------
// Hermes-compatible timeout helper
// AbortSignal.timeout() is not available in React Native's Hermes engine.
// ---------------------------------------------------------------------------
function makeTimeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

// ---------------------------------------------------------------------------
// PoW
// ---------------------------------------------------------------------------

/**
 * Fetch a fresh PoW challenge from the relay. The challenge is an opaque
 * server-issued string; the difficulty is the number of leading zero bits
 * required on SHA256(nonce || challenge).
 */
export async function fetchPowChallenge(
  relayUrl: string,
): Promise<PowChallenge> {
  // Identity/prekeys PoW lives at /identity/challenge. Callers pass the relay
  // BASE url; the endpoint path is appended here.
  return fetchPowChallengeAt(`${trimSlash(relayUrl)}/identity/challenge`);
}

/**
 * Fetch a PoW challenge from an explicit challenge endpoint URL.
 *
 * Unlike `fetchPowChallenge` (which assumes `/identity/challenge`), this takes
 * the FULL challenge URL so other PoW-gated endpoints can reuse the same solver.
 * The blob store, for example, has its own dedicated `/blob/challenge` with an
 * independent rate-limiter — passing the base url here would 404.
 */
export async function fetchPowChallengeAt(
  challengeUrl: string,
): Promise<PowChallenge> {
  const res = await fetch(trimSlash(challengeUrl), {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: makeTimeoutSignal(8000),
  });
  if (!res.ok) {
    throw new Error(`PoW challenge fetch failed: HTTP ${res.status}`);
  }
  const json: unknown = await res.json();
  if (!isPowChallenge(json)) {
    throw new Error('PoW challenge: malformed response');
  }
  return { challenge: json.challenge, difficulty: json.difficulty };
}

/**
 * Solve a PoW challenge by finding a hex `nonce` such that
 * SHA256(utf8(nonce + challenge)) has `difficulty` leading zero bits.
 *
 * Implemented as an async-yielding loop so the JS thread can paint UI between
 * batches on mobile devices.
 */
export async function solvePoW(
  challenge: string,
  difficulty: number,
): Promise<string> {
  if (!Number.isInteger(difficulty) || difficulty < 0 || difficulty > 256) {
    throw new Error('PoW: invalid difficulty');
  }
  const challengeBytes = utf8ToBytes(challenge);
  const batch = 2048;
  let counter = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (let i = 0; i < batch; i++) {
      const nonce = counter.toString(16);
      const nonceBytes = utf8ToBytes(nonce);
      const input = new Uint8Array(nonceBytes.length + challengeBytes.length);
      input.set(nonceBytes, 0);
      input.set(challengeBytes, nonceBytes.length);
      const digest = sha256(input);
      if (hasLeadingZeroBits(digest, difficulty)) {
        return nonce;
      }
      counter++;
    }
    // Yield to the event loop so React Native can keep the UI responsive.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
  const fullBytes = Math.floor(bits / 8);
  const remBits = bits % 8;
  for (let i = 0; i < fullBytes; i++) {
    if (digest[i] !== 0) return false;
  }
  if (remBits === 0) return true;
  const mask = 0xff << (8 - remBits);
  return (digest[fullBytes] & mask) === 0;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

/**
 * Two-phase upload:
 *   1) POST /identity   — registers the public profile, gated by PoW.
 *   2) POST /prekeys    — uploads SPK + OPKs (public material only).
 *
 * If the prekeys POST fails the identity is still registered server-side; the
 * caller should retry the prekeys upload separately. We surface the granular
 * error so the Mobile team can decide whether to retry.
 */
export async function uploadIdentityAndPrekeys(
  identity: Identity,
  preKeySecrets: PreKeySecrets,
  relayUrl: string,
  powChallenge: string,
  powNonce: string,
  oneTimePreKeysPublic: OneTimePreKeyPublic[],
  signedPreKeyPublic: SignedPreKeyPublic,
): Promise<RegistrationResult> {
  const base = trimSlash(relayUrl);

  const identityBody: IdentityPostBody = {
    aegisId: identity.aegisId,
    publicKey: identity.publicKeyB64,
    signingPublicKey: identity.signingPublicKeyB64,
    powChallenge,
    powNonce,
  };

  let identityRes: Response;
  try {
    identityRes = await fetch(`${base}/identity`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(identityBody),
      signal: makeTimeoutSignal(10000),
    });
  } catch (e) {
    return { ok: false, error: `identity: network error: ${errMsg(e)}` };
  }

  // 201 = created, 200 = already registered with same key (idempotent re-register)
  if (identityRes.status !== 201 && identityRes.status !== 200) {
    const detail = await safeText(identityRes);
    return {
      ok: false,
      error: `identity: HTTP ${identityRes.status}${detail ? ` — ${detail}` : ''}`,
    };
  }

  // Defensive check: ensure secrets are NOT being shipped by accident.
  if (containsAnySecret(signedPreKeyPublic, oneTimePreKeysPublic)) {
    return { ok: false, error: 'prekeys: refusing to upload — secret material detected' };
  }
  // Touch `preKeySecrets` so callers see we receive (but never serialize) it.
  // This explicit no-op keeps the type-checker honest about the contract.
  void preKeySecrets;

  // Authenticate the prekeys upload: the server requires an Ed25519 signature
  // over `${aegisId}:prekeys:${timeBucket}` plus a fresh timestamp. Without
  // these the POST /prekeys endpoint rejects with HTTP 400 (sig/ts Required),
  // which silently broke registration for every NEW identity — the account got
  // an identity row but no prekeys, so it stayed effectively unregistered.
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const sig = encodeBase64(
    nacl.sign.detached(utf8ToBytes(`${identity.aegisId}:prekeys:${timeBucket}`), identity.signingSecretKey),
  );

  const prekeysBody: PreKeysPostBody = {
    aegisId: identity.aegisId,
    sig,
    ts,
    signedPreKey: signedPreKeyPublic,
    oneTimePreKeys: oneTimePreKeysPublic,
  };

  let prekeysRes: Response;
  try {
    prekeysRes = await fetch(`${base}/prekeys`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(prekeysBody),
      signal: makeTimeoutSignal(10000),
    });
  } catch (e) {
    return { ok: false, error: `prekeys: network error: ${errMsg(e)}` };
  }

  if (prekeysRes.status !== 201 && prekeysRes.status !== 200) {
    const detail = await safeText(prekeysRes);
    return {
      ok: false,
      error: `prekeys: HTTP ${prekeysRes.status}${detail ? ` — ${detail}` : ''}`,
    };
  }

  return { ok: true };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function trimSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return 'unknown';
}

async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '';
  }
}

function isPowChallenge(v: unknown): v is PowChallenge {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o.challenge === 'string' && typeof o.difficulty === 'number';
}

/**
 * Belt-and-suspenders: scan the prekey payload structure for any field that
 * looks like it might be a secret. The public types don't include such
 * fields, but if some refactor ever introduces one this guard fails closed.
 */
function containsAnySecret(
  spk: SignedPreKeyPublic,
  opks: OneTimePreKeyPublic[],
): boolean {
  const spkAny = spk as unknown as Record<string, unknown>;
  if ('secretKey' in spkAny || 'secretKeyB64' in spkAny) return true;
  for (const opk of opks) {
    const o = opk as unknown as Record<string, unknown>;
    if ('secretKey' in o || 'secretKeyB64' in o) return true;
  }
  return false;
}
