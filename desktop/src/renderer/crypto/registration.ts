/**
 * AegisLink — Registration
 * ---------------------------------------------------------------------------
 * Identical to the mobile version — uses only fetch() and @noble/hashes which
 * work in the Electron renderer. Uploads PUBLIC material only:
 *   - aegisId, publicKey, signingPublicKey
 *   - signedPreKey (public + signature), oneTimePreKeys (public)
 *
 * NEVER uploads: Identity.secretKey, signingSecretKey, OPK secrets, SPK secret.
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
import type { PqSignedPreKeyPublic } from './signal/x3dh';

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
  ts: number;
  signedPreKey: SignedPreKeyPublic;
  oneTimePreKeys: OneTimePreKeyPublic[];
  /** PQXDH (v2) signed PQ prekey. Omitted ⇒ v1-only bundle. Relay verifies the
   * Ed25519 signature server-side and stores it as an opaque blob. */
  pqSignedPreKey?: PqSignedPreKeyPublic;
}

export async function fetchPowChallenge(
  relayUrl: string,
): Promise<PowChallenge> {
  const res = await fetch(`${trimSlash(relayUrl)}/identity/challenge`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
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
    // Yield so the renderer stays responsive.
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

export async function uploadIdentityAndPrekeys(
  identity: Identity,
  preKeySecrets: PreKeySecrets,
  relayUrl: string,
  powChallenge: string,
  powNonce: string,
  oneTimePreKeysPublic: OneTimePreKeyPublic[],
  signedPreKeyPublic: SignedPreKeyPublic,
  pqSignedPreKeyPublic?: PqSignedPreKeyPublic | null,
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
    });
  } catch (e) {
    return { ok: false, error: `identity: network error: ${errMsg(e)}` };
  }

  if (identityRes.status !== 201 && identityRes.status !== 200) {
    const detail = await safeText(identityRes);
    return {
      ok: false,
      error: `identity: HTTP ${identityRes.status}${detail ? ` — ${detail}` : ''}`,
    };
  }

  if (containsAnySecret(signedPreKeyPublic, oneTimePreKeysPublic)) {
    return { ok: false, error: 'prekeys: refusing to upload — secret material detected' };
  }
  // Secrets are persisted by the caller (store/identity.ts) BEFORE this upload
  // runs — never publish an SPK whose secret cannot be read back.
  void preKeySecrets;

  // Authenticate the prekeys upload: the server requires an Ed25519 signature
  // over `${aegisId}:prekeys:${timeBucket}` plus a fresh timestamp. Without
  // these, POST /prekeys rejects with HTTP 400 (sig/ts Required) and a new
  // identity stays effectively unregistered. Mirrors mobile registration.ts.
  const ts = Date.now();
  const timeBucket = Math.floor(ts / 30_000);
  const sig = encodeBase64(
    nacl.sign.detached(
      utf8ToBytes(`${identity.aegisId}:prekeys:${timeBucket}`),
      identity.signingSecretKey,
    ),
  );

  const prekeysBody: PreKeysPostBody = {
    aegisId: identity.aegisId,
    sig,
    ts,
    signedPreKey: signedPreKeyPublic,
    oneTimePreKeys: oneTimePreKeysPublic,
    ...(pqSignedPreKeyPublic ? { pqSignedPreKey: pqSignedPreKeyPublic } : {}),
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
