/**
 * CSPRNG installation, split out of `./index.ts` on purpose: `cryptoSetup.ts`
 * imports this BEFORE any @noble module is evaluated (noble captures
 * `globalThis.crypto` at module-load time, and cryptoSetup is what installs it).
 * Keep this file free of @noble imports.
 */
import tweetnacl from 'tweetnacl';

/** Install the process CSPRNG. Called once from `cryptoSetup.ts`. */
export function setRandomSource(fill: (out: Uint8Array, n: number) => void): void {
  tweetnacl.setPRNG(fill);
}
