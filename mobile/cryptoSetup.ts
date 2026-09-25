// CRITICAL — imported FIRST from index.ts, before App and any crypto library.
//
// React Native exposes no Web Crypto. The primitives in src/crypto/sodium
// (NaCl, ML-KEM-768, Argon2id) take their randomness from native libsodium
// directly, but any @noble/* helper that draws randomness needs
// globalThis.crypto.getRandomValues, which @noble/hashes captures AT MODULE-LOAD
// time. When ML-KEM still ran on @noble, a missing shim made registration throw
// "crypto.getRandomValues must be defined" and the identity was never
// published; the shim stays so no library can hit that again.
// Because ES imports are hoisted, this shim MUST be installed in a module that
// is imported before App's @noble import chain evaluates — hence this dedicated
// file rather than inline code in index.ts.
//
// Both consumers now draw from the SAME generator: libsodium's randombytes_buf
// (F-1 B2). We deliberately avoid the react-native-get-random-values package.
// `sodium/random` (not the `sodium` index): it must not pull in @noble before
// the getRandomValues shim below is installed.
import { fillRandom } from './src/crypto/sodium/random';

const g = globalThis as unknown as { crypto?: { getRandomValues?: unknown } };
if (g.crypto == null) {
  g.crypto = {};
}
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = <T extends ArrayBufferView | null>(array: T): T => {
    if (array == null) return array;
    fillRandom(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
    return array;
  };
}
