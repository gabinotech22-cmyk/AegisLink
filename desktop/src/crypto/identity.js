import nacl from 'tweetnacl';
import { encodeBase64, decodeBase64 } from 'tweetnacl-util';

// SecureStore slots — match mobile naming for protocol parity.
const SECRET_KEY_SLOT = 'aegis.secretKey.b64';
const SIGN_SECRET_KEY_SLOT = 'aegis.signSecretKey.b64';
const IDENTITY_META_SLOT = 'aegis.identity.meta.v1';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes, charsOut) {
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

export function deriveAegisId(publicKey) {
  if (publicKey.length < 7) throw new Error('public key too short');
  const head = publicKey.slice(0, 7);
  const raw = encodeBase32(head, 11);
  return `${raw.slice(0, 3)}-${raw.slice(3, 7)}-${raw.slice(7, 11)}`;
}

export function generateKeyPair() {
  return nacl.box.keyPair();
}

export function generateSigningKeyPair() {
  return nacl.sign.keyPair();
}

function createIdentityInMemory() {
  const { publicKey, secretKey } = nacl.box.keyPair();
  const signSeed = nacl.randomBytes(32);
  const signKeys = nacl.sign.keyPair.fromSeed(signSeed);
  signSeed.fill(0);
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

function requireSecureStore() {
  if (typeof window === 'undefined' || !window.secureStore) {
    throw new Error('identity: window.secureStore IPC bridge unavailable');
  }
  return window.secureStore;
}

/**
 * Generate a brand-new on-device identity and persist secrets to the
 * Electron secure-storage IPC bridge. Returns the full Identity (including
 * public material). Private keys never leave this function's caller chain
 * other than via window.secureStore.set.
 */
export async function generateIdentity() {
  const id = createIdentityInMemory();
  const ss = requireSecureStore();
  await ss.set(SECRET_KEY_SLOT, id.secretKeyB64);
  await ss.set(SIGN_SECRET_KEY_SLOT, id.signingSecretKeyB64);
  await ss.set(
    IDENTITY_META_SLOT,
    JSON.stringify({
      aegisId: id.aegisId,
      publicKeyB64: id.publicKeyB64,
      signingPublicKeyB64: id.signingPublicKeyB64,
      createdAt: id.createdAt,
    }),
  );
  return id;
}

/**
 * Load identity from SecureStore. Returns null if nothing persisted.
 */
export async function loadIdentity() {
  const ss = requireSecureStore();
  const [secretKeyB64, signingSecretKeyB64, metaJson] = await Promise.all([
    ss.get(SECRET_KEY_SLOT),
    ss.get(SIGN_SECRET_KEY_SLOT),
    ss.get(IDENTITY_META_SLOT),
  ]);
  if (!secretKeyB64 || !signingSecretKeyB64 || !metaJson) return null;
  const meta = JSON.parse(metaJson);
  const publicKey = decodeBase64(meta.publicKeyB64);
  const secretKey = decodeBase64(secretKeyB64);
  const signingPublicKey = decodeBase64(meta.signingPublicKeyB64);
  const signingSecretKey = decodeBase64(signingSecretKeyB64);
  return {
    aegisId: meta.aegisId,
    publicKey,
    secretKey,
    publicKeyB64: meta.publicKeyB64,
    secretKeyB64,
    signingPublicKey,
    signingSecretKey,
    signingPublicKeyB64: meta.signingPublicKeyB64,
    signingSecretKeyB64,
    createdAt: meta.createdAt,
  };
}

export async function clearIdentity() {
  const ss = requireSecureStore();
  await ss.delete(SECRET_KEY_SLOT);
  await ss.delete(SIGN_SECRET_KEY_SLOT);
  await ss.delete(IDENTITY_META_SLOT);
}

/**
 * Returns the public bundle (no secret material) for the loaded identity.
 */
export async function getPublicKeyBundle() {
  const id = await loadIdentity();
  if (!id) return null;
  return {
    aegisId: id.aegisId,
    publicKeyB64: id.publicKeyB64,
    signingPublicKeyB64: id.signingPublicKeyB64,
  };
}

/**
 * Pure helper for tests / non-persistent flows. Does NOT touch SecureStore.
 */
export function createEphemeralIdentity() {
  return createIdentityInMemory();
}

/**
 * Returns the 32-byte Ed25519 signing public key for the given profile.
 * Derived from the signing secret key stored in the secureStore IPC bridge —
 * nacl sign secret keys are 64 bytes: first 32 are the seed, last 32 are
 * the public half.
 */
export async function getProfilePublicKey(profileId) {
  const ss = requireSecureStore();
  const signSecretB64 = await ss.get(SIGN_SECRET_KEY_SLOT);
  if (!signSecretB64) {
    throw new Error(`no signing key in secureStore for profile ${profileId}`);
  }
  const signSecret = decodeBase64(signSecretB64);
  return signSecret.slice(32, 64);
}

/**
 * Signs an arbitrary payload with the Ed25519 signing key from the OS keychain.
 * Returns a 64-byte detached signature. The private key is loaded transiently
 * and never logged, copied, or persisted beyond the IPC fetch.
 */
export async function signWithProfileKey(profileId, payload) {
  const ss = requireSecureStore();
  const signSecretB64 = await ss.get(SIGN_SECRET_KEY_SLOT);
  if (!signSecretB64) {
    throw new Error(`no signing key in secureStore for profile ${profileId}`);
  }
  const signSecret = decodeBase64(signSecretB64);
  return nacl.sign.detached(payload, signSecret);
}
