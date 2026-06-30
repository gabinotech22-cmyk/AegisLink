import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import * as SecureStore from 'expo-secure-store';
import { signSecretKeySlot } from './types';
import { deriveAegisId } from './aegisId';

// Re-exported for backward compatibility: deriveAegisId now lives in the pure
// crypto/aegisId module so the ID↔key binding can be enforced at every trust
// boundary without pulling native modules in. Existing importers of
// `deriveAegisId` from './identity' keep working unchanged.
export { deriveAegisId };

export interface KeyPair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export interface Identity {
  aegisId: string;
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  publicKeyB64: string;
  secretKeyB64: string;
  signingPublicKey: Uint8Array;
  signingSecretKey: Uint8Array;
  signingPublicKeyB64: string;
  signingSecretKeyB64: string;
  createdAt: number;
}

export function generateKeyPair(): KeyPair {
  return nacl.box.keyPair();
}

export function generateSigningKeyPair(): KeyPair {
  return nacl.sign.keyPair();
}

export function createIdentity(): Identity {
  const { publicKey, secretKey } = generateKeyPair();
  // Derive signing key from box secret key so a 32-word mnemonic fully restores the identity.
  const signKeys = nacl.sign.keyPair.fromSeed(secretKey);
  return {
    aegisId: deriveAegisId(publicKey),
    publicKey,
    secretKey,
    publicKeyB64: encodeBase64(publicKey),
    secretKeyB64: encodeBase64(secretKey),
    signingPublicKey: signKeys.publicKey,
    signingSecretKey: signKeys.secretKey,
    signingPublicKeyB64: encodeBase64(signKeys.publicKey),
    signingSecretKeyB64: encodeBase64(signKeys.secretKey),
    createdAt: Date.now(),
  };
}

// ── Web3 integration helpers ─────────────────────────────────────────────────
// These functions access SecureStore directly so the private key never leaves
// the device's secure enclave. `profileId` is the slot id of the profile
// ('self' for the primary profile, or e.g. 'work' / 'slot_1' for others).

/**
 * Loads the 64-byte Ed25519 signing secret key for the given profile/slot.
 *
 * Per-profile isolation: the slot name is derived from `profileId` via the
 * single source of truth in crypto/types. The primary profile ('self') maps to
 * the legacy un-suffixed slot (SLOT_KEY_PREFIX.SIGN_SECRET), so existing
 * identities created before multi-profile support keep working with zero
 * migration. Non-'self' profiles use their own suffixed slot and NEVER read the
 * primary's legacy key — doing so would break isolation and let one profile
 * sign with another's identity.
 *
 * The secret never leaves SecureStore except as the in-memory Uint8Array the
 * caller needs to sign with.
 */
async function loadSignSecret(profileId: string): Promise<Uint8Array> {
  const slot = signSecretKeySlot(profileId);
  // For 'self', slot === SLOT_KEY_PREFIX.SIGN_SECRET (the legacy name), so the
  // primary profile is read in place with no migration step required.
  const signSecretB64 = await SecureStore.getItemAsync(slot);

  if (!signSecretB64) {
    throw new Error(`no signing key in SecureStore for profile ${profileId}`);
  }
  return decodeBase64(signSecretB64);
}

/**
 * Returns the 32-byte Ed25519 signing public key for the given profile.
 * Derived from that profile's signing secret key (64 bytes = seed || pubkey).
 */
export async function getProfilePublicKey(profileId: string): Promise<Uint8Array> {
  const signSecret = await loadSignSecret(profileId);
  // nacl sign secret key is 64 bytes: first 32 are the seed, last 32 the public key.
  return signSecret.slice(32, 64);
}

/**
 * Signs an arbitrary payload with the given profile's Ed25519 signing key.
 * Returns a 64-byte detached signature. The private key never leaves SecureStore.
 */
export async function signWithProfileKey(
  profileId: string,
  payload: Uint8Array
): Promise<Uint8Array> {
  const signSecret = await loadSignSecret(profileId);
  return nacl.sign.detached(payload, signSecret);
}

// ─────────────────────────────────────────────────────────────────────────────

export function identityFromStored(opts: {
  publicKeyB64: string;
  secretKeyB64: string;
  signingPublicKeyB64?: string;
  signingSecretKeyB64?: string;
  createdAt: number;
}): Identity {
  const publicKey = decodeBase64(opts.publicKeyB64);
  const secretKey = decodeBase64(opts.secretKeyB64);
  // Missing signing material (pre-multi-key DBs): DERIVE it deterministically
  // from the box secret key, exactly as createIdentity does
  // (nacl.sign.keyPair.fromSeed). A throwaway RANDOM pair would produce
  // signatures no contact can verify (sealed-sender rejects everything) AND would
  // mask a corrupted/half-written identity as valid. Deterministic derivation
  // restores the user's REAL signing identity instead (golden rule #1/#3).
  const signKeys = (opts.signingPublicKeyB64 && opts.signingSecretKeyB64)
    ? {
        publicKey: decodeBase64(opts.signingPublicKeyB64),
        secretKey: decodeBase64(opts.signingSecretKeyB64)
      }
    : nacl.sign.keyPair.fromSeed(secretKey);

  return {
    aegisId: deriveAegisId(publicKey),
    publicKey,
    secretKey,
    publicKeyB64: opts.publicKeyB64,
    secretKeyB64: opts.secretKeyB64,
    signingPublicKey: signKeys.publicKey,
    signingSecretKey: signKeys.secretKey,
    signingPublicKeyB64: opts.signingPublicKeyB64 ?? encodeBase64(signKeys.publicKey),
    signingSecretKeyB64: opts.signingSecretKeyB64 ?? encodeBase64(signKeys.secretKey),
    createdAt: opts.createdAt,
  };
}
