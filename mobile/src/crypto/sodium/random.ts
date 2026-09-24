/**
 * The process CSPRNG: libsodium's randombytes_buf in the native module
 * (Android: /dev/urandom, iOS: arc4random_buf — the OS generator).
 *
 * Split out of `./index.ts` on purpose: `cryptoSetup.ts` imports this BEFORE any
 * @noble module is evaluated (noble captures `globalThis.crypto` at module-load
 * time, and cryptoSetup is what installs it). Keep this file free of @noble
 * imports.
 */
import AegisSodium, { AEGIS_OK } from '../../../modules/aegis-sodium';

/** Fill `out` with CSPRNG bytes, in place. Throws rather than leave it unfilled. */
export function fillRandom(out: Uint8Array): void {
  if (AegisSodium.randombytes(out) !== AEGIS_OK) throw new Error('aegis-sodium: randombytes failed');
}
