import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';
import './ipc-types';

// Renderer SecureStorage slots — must match db/local.ts (desktop).
const SECRET_KEY_SLOT = 'aegis.secretKey.b64';
const SIGN_SECRET_KEY_SLOT = 'aegis.signSecretKey.b64';

const secureStorage = (): Window['aegis']['secureStorage'] => window.aegis.secureStorage;

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

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, charsOut: number): string {
  let bits = 0n;
  for (const b of bytes) bits = (bits << 8n) | BigInt(b);
  const totalBits = BigInt(bytes.length * 8);
  const needed = BigInt(charsOut * 5);
  if (totalBits > needed) bits = bits >> (totalBits - needed);
  else if (totalBits < needed) bits = bits << (needed - totalBits);
  let out = '';
  for (let i = charsOut - 1; i >= 0; i--) {
    const idx = Number((bits >> BigInt(i * 5)) & 0x1fn);
    out += CROCKFORD[idx];
  }
  return out;
}

export function deriveAegisId(publicKey: Uint8Array): string {
  if (publicKey.length < 7) throw new Error('public key too short');
  const head = publicKey.slice(0, 7);
  const raw = encodeBase32(head, 11);
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 11)}`;
}

export function createIdentity(): Identity {
  const { publicKey, secretKey } = generateKeyPair();
  // Derive signing key from box secret key so the same seed recreates both.
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
// Private keys NEVER leave the OS-backed secureStorage (Keychain/Credential Vault).

export async function getProfilePublicKey(profileId: string): Promise<Uint8Array> {
  const signSecretB64 = await secureStorage().get(SIGN_SECRET_KEY_SLOT);
  if (!signSecretB64) {
    throw new Error(`no signing key in secureStorage for profile ${profileId}`);
  }
  const signSecret = decodeBase64(signSecretB64);
  // nacl sign secret key is 64 bytes: first 32 are the seed, last 32 the public key.
  return signSecret.slice(32, 64);
}

export async function signWithProfileKey(
  profileId: string,
  payload: Uint8Array
): Promise<Uint8Array> {
  const signSecretB64 = await secureStorage().get(SIGN_SECRET_KEY_SLOT);
  if (!signSecretB64) {
    throw new Error(`no signing key in secureStorage for profile ${profileId}`);
  }
  const signSecret = decodeBase64(signSecretB64);
  return nacl.sign.detached(payload, signSecret);
}

// Reference SECRET_KEY_SLOT so it is documented and discoverable.
export const IDENTITY_SECRET_KEY_SLOT = SECRET_KEY_SLOT;
export const IDENTITY_SIGN_SECRET_KEY_SLOT = SIGN_SECRET_KEY_SLOT;

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
  // Mobile parity: mobile/src/crypto/identity.ts:identityFromStored.
  const signKeys = (opts.signingPublicKeyB64 && opts.signingSecretKeyB64)
    ? {
        publicKey: decodeBase64(opts.signingPublicKeyB64),
        secretKey: decodeBase64(opts.signingSecretKeyB64),
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
