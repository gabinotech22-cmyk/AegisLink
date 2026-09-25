/**
 * aegis-sodium — native libsodium for the mobile crypto facade (F-1 B2).
 *
 * The C core (`cpp/aegis_sodium.c`) is compiled with the vendored,
 * signature-verified libsodium (`vendor/`) into the app on both platforms
 * (Android: `android/`, JNI; iOS: `ios/`, Swift). This file only types it.
 *
 * Calling convention: every function but `argon2id` is synchronous (JSI),
 * writes into caller-allocated output arrays, and returns a code (below). Only
 * `src/crypto/sodium` calls it; everything else goes through that facade.
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
  /**
   * Argon2id, one lane. The only ASYNC function: it runs on a background thread
   * for hundreds of milliseconds, so it takes copies and resolves to the key as
   * an array of byte values; it rejects on any non-OK code.
   */
  argon2id(pwd: B, salt: B, t: number, mKib: number, outLen: number): Promise<number[]>;
}

const AegisSodium = requireNativeModule<AegisSodiumNative>('AegisSodium');

export default AegisSodium;
