/**
 * Test helpers for the F-1b key vault.
 *
 * `rawStoredIdentity()` is an identity as stored BEFORE F-1b: raw base64
 * secrets, which `identityFromStored` imports into the vault (migration path).
 * `rawSecrets(identity)` exports a vault identity's secrets so a test can play
 * the peer side with plain libsodium, and `vk(raw)` goes the other way (tests
 * are on the vaultExport guard's allowlist; production code is not).
 */
import { encodeBase64 } from 'tweetnacl-util';
import { nacl } from '../../sodium';
import { vault, type VaultKey } from '../../sodium/vault';
import { createIdentity, exportIdentitySecrets, importIdentity, type Identity } from '../../identity';

export interface RawStoredIdentity {
  publicKeyB64: string;
  secretKeyStored: string;
  signingPublicKeyB64: string;
  signingSecretKeyStored: string;
  createdAt: number;
  box: { publicKey: Uint8Array; secretKey: Uint8Array };
  sign: { publicKey: Uint8Array; secretKey: Uint8Array };
}

export function rawStoredIdentity(): RawStoredIdentity {
  const box = nacl.box.keyPair();
  const sign = nacl.sign.keyPair.fromSeed(box.secretKey);
  return {
    publicKeyB64: encodeBase64(box.publicKey),
    secretKeyStored: encodeBase64(box.secretKey),
    signingPublicKeyB64: encodeBase64(sign.publicKey),
    signingSecretKeyStored: encodeBase64(sign.secretKey),
    createdAt: 1_700_000_000_000,
    box,
    sign,
  };
}

export function rawSecrets(identity: Identity): { secretKey: Uint8Array; signingSecretKey: Uint8Array } {
  return exportIdentitySecrets(identity);
}

const imported = new WeakMap<Uint8Array, VaultKey>();

/**
 * A raw test key (32-byte X25519 or 64-byte Ed25519 secret) as a vault key, so
 * tests that build keys with plain libsodium can call the handle-based API.
 * The caller's bytes stay intact (the vault zeroes only its own copy).
 */
export function vk(raw: Uint8Array, slot = 'self'): VaultKey {
  const hit = imported.get(raw);
  if (hit) return hit;
  const key = vault.import(slot, raw.length === 64 ? 'ed25519' : 'x25519', raw.slice()).key;
  imported.set(raw, key);
  return key;
}

/**
 * A vault identity from raw test keypairs (box = X25519, sign = Ed25519 with
 * its public half), so a test can keep the raw pair for the peer side. The
 * AegisID can be overridden for tests that pin it.
 */
export function identityFromRaw(
  box: { secretKey: Uint8Array },
  sign: { secretKey: Uint8Array },
  aegisId?: string,
  slot = 'self',
): Identity {
  const id = importIdentity(slot, box.secretKey.slice(), sign.secretKey.slice(), Date.now());
  return aegisId === undefined ? id : { ...id, aegisId };
}

/** The key fields of an Identity (fresh vault keys), for stub identities whose public fields a test pins. */
export function stubKeys(): Pick<Identity, 'secretKey' | 'signingSecretKey' | 'secretKeyStored' | 'signingSecretKeyStored'> {
  const id = createIdentity();
  return {
    secretKey: id.secretKey,
    signingSecretKey: id.signingSecretKey,
    secretKeyStored: id.secretKeyStored,
    signingSecretKeyStored: id.signingSecretKeyStored,
  };
}

let memoBox: VaultKey | null = null;
let memoSign: VaultKey | null = null;

/** One X25519 vault key per test file, for mocked identities whose key is not checked. */
export function testBoxKey(): VaultKey {
  return (memoBox ??= vault.generate('self', 'x25519').key);
}

/** One Ed25519 vault key per test file, for mocked identities whose signatures are not checked. */
export function testSignKey(): VaultKey {
  return (memoSign ??= vault.generate('self', 'ed25519').key);
}
