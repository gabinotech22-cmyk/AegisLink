// CRITICAL — imported FIRST from index.ts, before App and any crypto library.
//
// React Native exposes no Web Crypto, so two independent random sources must be
// wired up before anything touches them:
//
//   1. The NaCl primitives (src/crypto/sodium) → via setRandomSource (call-time,
//      used by identity/secretbox).
//   2. @noble/*   → via globalThis.crypto.getRandomValues, which @noble/hashes
//      captures AT MODULE-LOAD time. ml_kem768.keygen() (PQXDH prekeys) calls it
//      during registration; without it the relay registration throws
//      "crypto.getRandomValues must be defined" and the identity is never
//      published. Because ES imports are hoisted, this shim MUST be installed in
//      a module that is imported before App's @noble import chain evaluates —
//      hence this dedicated file rather than inline code in index.ts.
//
// Both sources are backed by the SAME expo-crypto hardware RNG; we deliberately
// avoid the react-native-get-random-values package.
// `sodium/random` (not the `sodium` index): it must not pull in @noble before
// the getRandomValues shim below is installed.
import { setRandomSource } from './src/crypto/sodium/random';
import { getRandomBytes } from 'expo-crypto';

// expo-crypto's getRandomBytes REJECTS requests larger than 1024 bytes
// ("expected a valid number from range 0...1024"), so fill in ≤1024-byte chunks.
function fillRandom(out: Uint8Array, n: number): void {
  const MAX = 1024;
  for (let offset = 0; offset < n; offset += MAX) {
    const chunk = Math.min(MAX, n - offset);
    const random = getRandomBytes(chunk);
    for (let i = 0; i < chunk; i++) out[offset + i] = random[i];
  }
}

setRandomSource((out, n) => fillRandom(out, n));

// Minimal Web Crypto getRandomValues shim for @noble/* (ml-kem PQXDH, hashes).
const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
if (g.crypto == null) {
  g.crypto = {};
}
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array == null) return array;
    const view = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
    fillRandom(view, view.length);
    return array;
  };
}
