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
import { logger } from '../utils/logger';
import * as SecureStore from 'expo-secure-store';
import { encodeBase64 } from 'tweetnacl-util';
import { sha256 } from '@noble/hashes/sha256';
import { utf8ToBytes } from '@noble/hashes/utils';
import type {
  Identity,
  OneTimePreKeyPublic,
  PreKeySecrets,
  SignedPreKeyPublic,
  PqSignedPreKeyPublic,
} from './types';

// ---------------------------------------------------------------------------
// SecureStore mirror keys (best-effort secondary cache; DB is authoritative)
// ---------------------------------------------------------------------------
// These mirror the slot-scoped keys defined in socket/client.ts so the legacy
// SecureStore read paths (X3DH receiver lookups) keep working. The DB is the
// source of truth; SecureStore writes are non-fatal. The slot prefix is read
// lazily from db/local via dynamic import inside the upload function.

/** Prekey-store diagnostics — dev + diag builds only (see rdiag in socket/client.ts). */
function rdiag(msg: string): void {
  if (__DEV__ || process.env.EXPO_PUBLIC_AEGIS_DIAG === '1') logger.warn(msg);
}

function secureKeyHelpers(slotPrefix: string) {
  return {
    spkSecretKey: (keyId: number) => `aegis.${slotPrefix}spkSecret.${keyId}`,
    opkSecretKey: (keyId: number) => `aegis.${slotPrefix}opkSecret.${keyId}`,
    SECURE_SPK_SECRET_KEY: () => `aegis.${slotPrefix}spkSecret.b64`,
    SECURE_SPK_KEYID_KEY: () => `aegis.${slotPrefix}spk.keyId`,
    SECURE_OPK_IDS_KEY: () => `aegis.${slotPrefix}opkIds.json`,
  };
}

export interface PowChallenge {
  challenge: string;
  difficulty: number;
}

export interface RegistrationResult {
  ok: boolean;
  error?: string;
  /**
   * When the relay rate-limits us (HTTP 429), the cooldown it asks us to honor,
   * in milliseconds. Callers should not retry before this elapses — retrying
   * inside the window is wasted work and can extend a sliding-window ban.
   */
  retryAfterMs?: number;
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
  /**
   * PQXDH signed PQ prekey (ML-KEM-768). MUST be published so peers fetch it in
   * the bundle and include an ML-KEM ciphertext in their X3DH init — otherwise
   * the receiver's anti-downgrade gate (shouldUsePqReceiver) aborts every
   * handshake and no message/profile envelope is ever decrypted.
   */
  pqSignedPreKey?: PqSignedPreKeyPublic;
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

  // ── Buffer-reuse strategy (Hermes hot loop) ────────────────────────────────
  // The naive loop rebuilt the SHA-256 input on EVERY iteration:
  //   utf8ToBytes(nonce)  → 1 alloc
  //   new Uint8Array(...) → 1 alloc
  //   two .set(...)       → 2 copies
  // i.e. ≥2 heap allocations per hash × ~262 k hashes (difficulty 18). On Hermes
  // (no JIT, pure-JS SHA-256) that GC churn — not the hashing — dominated the
  // runtime and could push a single solve past the challenge TTL on old devices.
  //
  // Instead we allocate ONE reusable input buffer laid out as:
  //   [ zero-padded hex nonce (nonceWidth bytes) | challenge bytes ]
  // The challenge suffix is written ONCE and never touched again. The nonce
  // region is a fixed-width, zero-padded ASCII-hex counter that we advance in
  // place like an odometer (increment the least-significant hex digit, carry
  // left) — zero allocations and zero string building inside the loop.
  //
  // Protocol note: we hash (and therefore return) the EXACT zero-padded hex
  // string (e.g. "0000000a"). The relay re-hashes `nonce + challenge` as a
  // plain string concatenation (server/src/pow/challenge.ts), so leading zeros
  // are re-hashed identically and its `/^[0-9a-f]{1,32}$/` gate accepts the
  // fixed-width form. As long as the returned string is byte-for-byte what we
  // hashed locally, client and server agree.
  let nonceWidth = 8; // up to 0xffff_ffff attempts before the field must widen
  let input = new Uint8Array(nonceWidth + challengeBytes.length);
  input.set(challengeBytes, nonceWidth);
  input.fill(0x30 /* '0' */, 0, nonceWidth); // initialize nonce = "0000...0"

  // eslint-disable-next-line no-constant-condition
  while (true) {
    for (let i = 0; i < batch; i++) {
      const digest = sha256(input);
      if (hasLeadingZeroBits(digest, difficulty)) {
        // Return the exact hex string we hashed (leading zeros included). The
        // only allocation on the entire solve path, executed once.
        let nonce = '';
        for (let p = 0; p < nonceWidth; p++) {
          nonce += String.fromCharCode(input[p]);
        }
        return nonce;
      }
      // Odometer increment for the next attempt. ASCII hex codes:
      //   '0'..'9' = 0x30..0x39, 'a'..'f' = 0x61..0x66.
      let pos = nonceWidth - 1;
      while (pos >= 0) {
        const d = input[pos];
        if (d === 0x39) {
          // '9' → 'a'
          input[pos] = 0x61;
          break;
        } else if (d === 0x66) {
          // 'f' → '0', carry to the digit on the left
          input[pos] = 0x30;
          pos--;
        } else {
          // '0'..'8' or 'a'..'e' → +1
          input[pos] = d + 1;
          break;
        }
      }
      if (pos < 0) {
        // Overflowed the whole field (…ffff → 1…0000). Widen by one hex digit.
        // At real difficulties this never fires (P ≈ e^-16384 at 18 bits), but it
        // keeps the loop correct for arbitrarily hard challenges instead of
        // silently wrapping the counter.
        nonceWidth += 1;
        const widened = new Uint8Array(nonceWidth + challengeBytes.length);
        widened.set(challengeBytes, nonceWidth);
        widened.fill(0x30 /* '0' */, 0, nonceWidth);
        widened[0] = 0x31; // leading '1' → value "1" + zeros
        input = widened;
      }
    }
    // Yield to the event loop so React Native can keep the UI responsive.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

/**
 * Count leading zero bits on a digest against a required `bits` threshold.
 * Exported for protocol-compatibility tests (the same predicate the server
 * enforces). Efficient and correct — do not change without a matching server
 * change.
 */
export function hasLeadingZeroBits(digest: Uint8Array, bits: number): boolean {
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
  pqSignedPreKeyPublic?: PqSignedPreKeyPublic,
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
      retryAfterMs: parseRetryAfterMs(detail, identityRes),
    };
  }

  // Defensive check: ensure secrets are NOT being shipped by accident.
  if (containsAnySecret(signedPreKeyPublic, oneTimePreKeysPublic)) {
    return { ok: false, error: 'prekeys: refusing to upload — secret material detected' };
  }

  // ── DURABLE persistence of prekey SECRETS (registration path) ───────────────
  // The relay only ever receives PUBLIC material. But a peer that fetches this
  // SPK will run X3DH against it, so we MUST be able to read the matching SECRET
  // back later. Previously the registration path discarded `preKeySecrets`
  // entirely (`void preKeySecrets`), so a freshly created identity published an
  // SPK whose secret it could never read → peer hits "ABORT no-spk". This mirrors
  // the refill path in socket/client.ts:uploadPreKeys.
  //
  // INVARIANT: write the SPK secret to the durable, encrypted-at-rest DB FIRST,
  // read it back by keyId, and ONLY publish the public SPK if that readback
  // succeeds. Never publish a SPK whose secret we cannot read back.
  const persistResult = await persistPrekeySecretsDurably(preKeySecrets);
  if (!persistResult.ok) {
    // Identity row already exists server-side, but we refuse to publish a SPK we
    // cannot complete. Caller can retry; until then the bundle stays unpublished.
    rdiag(
      `[RDIAG] prekey-store ABORT spkId=${preKeySecrets.signedPreKey.keyId} dbReadback=NULL — NOT POSTing /prekeys`,
    );
    return {
      ok: false,
      error: `prekeys: could not persist SPK secret for keyId ${preKeySecrets.signedPreKey.keyId} — refusing to publish`,
    };
  }

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
      retryAfterMs: parseRetryAfterMs(detail, prekeysRes),
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

/**
 * Extract the cooldown the relay wants us to honor after a 429.
 * Prefers the JSON body's `retryAfterMs`; falls back to the standard
 * `Retry-After` header (seconds → ms). Returns undefined when neither is
 * present or parseable.
 */
function parseRetryAfterMs(detail: string, res: Response): number | undefined {
  try {
    const body = JSON.parse(detail) as { retryAfterMs?: unknown };
    if (typeof body.retryAfterMs === 'number' && body.retryAfterMs > 0) {
      return body.retryAfterMs;
    }
  } catch {
    // detail wasn't JSON — fall through to the header
  }
  const header = res.headers.get('Retry-After');
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds > 0) return seconds * 1000;
  }
  return undefined;
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

// ---------------------------------------------------------------------------
// Durable prekey-secret persistence (registration path)
// ---------------------------------------------------------------------------

/**
 * Persist the SPK secret + keyId + every OPK secret to the durable,
 * encrypted-at-rest SQLite store. The SPK secret is written and read back
 * (with one retry) to enforce the publish invariant: we return `{ ok: false }`
 * if the SPK secret cannot be persisted-and-read-back, in which case the caller
 * MUST NOT publish the public SPK.
 *
 * The SecureStore mirror is best-effort (non-fatal) so legacy read paths keep
 * working — the DB is authoritative.
 *
 * db/local is required lazily (CommonJS, inside the function) to avoid pulling
 * expo-sqlite / native modules into this otherwise pure-crypto module's static
 * graph — keeps it side-effect free at import time and Jest-friendly (a dynamic
 * `import()` would need --experimental-vm-modules; `require` does not).
 */
async function persistPrekeySecretsDurably(
  preKeySecrets: PreKeySecrets,
): Promise<{ ok: boolean }> {
  const spkKeyId = preKeySecrets.signedPreKey.keyId;
  const spkSecretB64 = encodeBase64(preKeySecrets.signedPreKey.secretKey);

  const db = require('../db/local') as typeof import('../db/local');

  // ── PRIMARY: durable SQLite (encrypted at rest). Source of truth. ──────────
  const persistSpkToDb = async (): Promise<boolean> => {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await db.saveSpkSecret(spkKeyId, spkSecretB64);
        const back = await db.loadSpkSecret(spkKeyId);
        if (back === spkSecretB64) return true;
      } catch (e) {
        if (__DEV__) logger.warn('[registration] SPK secret DB write attempt failed', attempt, e);
      }
    }
    return false;
  };

  if (!(await persistSpkToDb())) {
    return { ok: false };
  }

  // Persist the durable keyId counter and every OPK secret.
  try {
    await db.setSpkKeyId(spkKeyId);
  } catch (e) {
    if (__DEV__) logger.warn('[registration] could not persist SPK keyId to DB', e);
  }
  // Start the SPK age clock for the age-based rotation trigger (B-3).
  try {
    await db.setSpkCreatedAt(Date.now());
  } catch (e) {
    if (__DEV__) logger.warn('[registration] could not persist SPK createdAt to DB', e);
  }
  for (const [keyId, secret] of preKeySecrets.opkSecrets.entries()) {
    try {
      await db.saveOpkSecret(keyId, encodeBase64(secret));
    } catch (e) {
      if (__DEV__) logger.warn('[registration] could not persist OPK secret to DB', keyId, e);
    }
  }

  // ── SECONDARY: SecureStore mirror (best-effort; DB is authoritative). ──────
  try {
    const slot = db.getActiveDbSlot();
    const slotPrefix = slot === 'self' ? '' : `${slot}.`;
    const keys = secureKeyHelpers(slotPrefix);
    const secureOpts = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK };

    await SecureStore.setItemAsync(keys.spkSecretKey(spkKeyId), spkSecretB64, secureOpts);
    await SecureStore.setItemAsync(keys.SECURE_SPK_SECRET_KEY(), spkSecretB64, secureOpts);
    await SecureStore.setItemAsync(keys.SECURE_SPK_KEYID_KEY(), String(spkKeyId), secureOpts);

    for (const [keyId, secret] of preKeySecrets.opkSecrets.entries()) {
      await SecureStore.setItemAsync(keys.opkSecretKey(keyId), encodeBase64(secret), secureOpts);
    }
    await SecureStore.setItemAsync(
      keys.SECURE_OPK_IDS_KEY(),
      JSON.stringify(Array.from(preKeySecrets.opkSecrets.keys())),
      secureOpts,
    );
  } catch (err) {
    // Non-fatal: the DB is the durable source of truth.
    if (__DEV__) logger.warn('[registration] SecureStore prekey mirror failed (DB is authoritative):', err);
  }

  // [RDIAG] confirm the SPK secret is readable back from the DURABLE store.
  rdiag(
    `[RDIAG] prekey-store DONE spkId=${spkKeyId} dbReadback=OK opkCount=${preKeySecrets.opkSecrets.size}`,
  );

  return { ok: true };
}
