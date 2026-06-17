/**
 * AegisLink — ensureRegistered
 * ---------------------------------------------------------------------------
 * Single authoritative path for publishing a local identity to the relay.
 * Both onboarding and the socket unknown_identity handler call this function;
 * no other code should duplicate the PoW → upload → verify sequence.
 *
 * Privacy invariants: no PII is sent; only the public bundle is uploaded.
 */

import { fetchPowChallenge, solvePoW, uploadIdentityAndPrekeys, type RegistrationResult } from './registration';
import { ensureDevicePreKeys } from './signal/x3dh';
import { lookupIdentity } from '../api';
import type { Identity } from './identity';
import { SERVER_URL } from '../config';

/**
 * Full registration result, including the verification step.
 *   ok=true  → relay confirmed: lookup returned our public key
 *   ok=false → upload failed, relay didn't confirm, or network error
 */
export interface EnsureResult {
  ok: boolean;
  error?: string;
  /** Relay-requested cooldown (ms) when registration was rate-limited (429). */
  retryAfterMs?: number;
}

/**
 * Idempotent: publish the identity bundle to the relay and verify the relay
 * can serve it back. Returns ok=true only when the relay confirms.
 *
 * Errors are returned (never thrown) so callers decide whether to block or
 * continue.
 *
 * Rate-limit (429) and 409 (already registered) are treated as non-fatal
 * to keep the caller logic uniform; the store maps them appropriately.
 */
export async function ensureRegistered(identity: Identity): Promise<EnsureResult> {
  try {
    const { challenge, difficulty } = await fetchPowChallenge(SERVER_URL);
    const nonce = await solvePoW(challenge, difficulty);

    const preKeys = await ensureDevicePreKeys(identity);

    const result: RegistrationResult = await uploadIdentityAndPrekeys(
      identity,
      {
        signedPreKey: { keyId: preKeys.signedPreKey.keyId, secretKey: preKeys.signedPreKey.secretKey },
        opkSecrets: preKeys.opkSecrets,
      },
      SERVER_URL,
      challenge,
      nonce,
      preKeys.oneTimePreKeys,
      {
        keyId: preKeys.signedPreKey.keyId,
        publicKeyB64: preKeys.signedPreKey.publicKeyB64,
        signatureB64: preKeys.signedPreKey.signatureB64,
      },
      // Publish the PQXDH PQ prekey too — without it the relay bundle has no
      // PQSPK, senders fall back to v1, and the receiver's anti-downgrade gate
      // aborts every handshake (no messages/profiles ever decrypt).
      {
        keyId: preKeys.pqSignedPreKey.keyId,
        publicKeyB64: preKeys.pqSignedPreKey.publicKeyB64,
        signatureB64: preKeys.pqSignedPreKey.signatureB64,
      },
    );

    if (!result.ok) {
      // 409 means identity is already on the relay — treat as success so the
      // verification step can confirm it is still reachable.
      const is409 = result.error?.includes('409') || result.error?.toLowerCase().includes('conflict') || result.error?.toLowerCase().includes('already');
      if (!is409) {
        return { ok: false, error: result.error ?? 'Upload failed', retryAfterMs: result.retryAfterMs };
      }
    }

    // Verify: the relay must serve our public key back.
    try {
      const record = await lookupIdentity(identity.aegisId);
      if (record.publicKey !== identity.publicKeyB64) {
        return { ok: false, error: 'Relay returned a different public key — key mismatch' };
      }
      return { ok: true };
    } catch (verifyErr) {
      const msg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      return { ok: false, error: `Upload ok but verification failed: ${msg}` };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: msg };
  }
}
