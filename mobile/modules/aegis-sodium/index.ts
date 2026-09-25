/**
 * aegis-sodium — native libsodium for the mobile crypto facade (F-1 B2).
 *
 * The C core (`cpp/aegis_sodium.c`) is compiled with the vendored,
 * signature-verified libsodium (`vendor/`) into the app on both platforms
 * (Android: `android/`, JNI; iOS: `ios/`, Swift). This file only types it.
 *
 * Calling convention: every function but `argon2id`, `pbkdf2Sha256` and
 * `powSha256` is synchronous (JSI), writes into caller-allocated output
 * arrays, and returns a code (below). Only `src/crypto/sodium` calls it;
 * everything else goes through that facade.
 *
 * `requireNativeModule` THROWS when the module is not in the binary (Expo Go,
 * a stale dev client): the app fails closed rather than falling back to a
 * JavaScript implementation (golden rule #1).
 */
import { requireNativeModule } from 'expo';

/** Return codes of the C core (`cpp/aegis_sodium.h`). */
export const AEGIS_OK = 0;
export const AEGIS_EVERIFY = 1;
export const AEGIS_EBADLEN = -1;
export const AEGIS_EFAIL = -2;
/** Vault: profile locked, or handle unknown / released / of another type. */
export const AEGIS_ENOKEY = -3;

type B = Uint8Array;

export interface AegisSodiumNative {
  init(): number;
  randombytes(buf: B): number;
  memcmp(a: B, b: B): number;
  boxKeypair(pk: B, sk: B): number;
  boxEasy(c: B, m: B, n: B, pk: B, sk: B): number;
  boxOpenEasy(m: B, c: B, n: B, pk: B, sk: B): number;
  boxBeforenm(k: B, pk: B, sk: B): number;
  secretboxEasy(c: B, m: B, n: B, k: B): number;
  secretboxOpenEasy(m: B, c: B, n: B, k: B): number;
  scalarmult(q: B, n: B, p: B): number;
  scalarmultBase(q: B, n: B): number;
  signKeypair(pk: B, sk: B): number;
  signSeedKeypair(pk: B, sk: B, seed: B): number;
  signDetached(sig: B, m: B, sk: B): number;
  signVerifyDetached(sig: B, m: B, pk: B): number;
  hmacsha256(out: B, m: B, k: B): number;
  hkdfSha256(out: B, ikm: B, salt: B, info: B): number;
  // ── Key vault (F-1b, cpp/aegis_vault.h). Handles are 4-byte arrays. ──
  /** Load (or create) the profile's KEK from the Keychain/Keystore into the C vault. */
  vaultUnlock(slot: string): Promise<void>;
  /** Destroy the profile's keys and forget its KEK (its blobs become unreadable). */
  vaultDestroyProfile(slot: string): Promise<void>;
  vaultLock(slot: string): number;
  vaultLockAll(): number;
  vaultGenerate(handle: B, blob: B, pub: B, slot: B, type: number): number;
  vaultImport(handle: B, blob: B, pub: B, slot: B, type: number, raw: B): number;
  vaultLoad(handle: B, type: B, pub: B, slot: B, blob: B): number;
  vaultDeriveEd25519(handle: B, blob: B, pub: B, xhandle: B): number;
  vaultRelease(handle: B): number;
  vaultSign(handle: B, sig: B, m: B): number;
  vaultScalarmult(handle: B, q: B, p: B): number;
  vaultBox(handle: B, c: B, m: B, n: B, pk: B): number;
  vaultBoxOpen(handle: B, m: B, c: B, n: B, pk: B): number;
  vaultMlkem768Dec(handle: B, ss: B, ct: B): number;
  vaultLiveKeys(): number;
  mlkem768Keypair(pk: B, sk: B): number;
  mlkem768SeedKeypair(pk: B, sk: B, seed: B): number;
  mlkem768Enc(ct: B, ss: B, pk: B): number;
  mlkem768Dec(ss: B, ct: B, sk: B): number;
  /**
   * Argon2id, one lane. The only ASYNC function: it runs on a background thread
   * for hundreds of milliseconds, so it takes copies and resolves to the key as
   * an array of byte values; it rejects on any non-OK code.
   */
  argon2id(pwd: B, salt: B, t: number, mKib: number, outLen: number): Promise<number[]>;
  /** PBKDF2-HMAC-SHA256 (legacy backups), async like argon2id; resolves to the key bytes. */
  pbkdf2Sha256(pwd: B, salt: B, iterations: number, outLen: number): Promise<number[]>;
  /**
   * Registration proof-of-work (`aegis_pow_sha256`), async like argon2id:
   * resolves to the first 8-hex-digit nonce whose SHA-256(nonce || challenge)
   * has `difficulty` leading zero bits; rejects on any non-OK code.
   */
  powSha256(challenge: B, difficulty: number): Promise<string>;
}

const AegisSodium = requireNativeModule<AegisSodiumNative>('AegisSodium');

export default AegisSodium;
