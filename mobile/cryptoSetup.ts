// CRITICAL — imported FIRST from index.ts, before App and any crypto library.
//
// React Native exposes no Web Crypto. The NaCl primitives (src/crypto/sodium)
// take their randomness from native libsodium directly, but @noble/* (ML-KEM
// for PQXDH prekeys, Argon2/PBKDF2 salts) needs globalThis.crypto.getRandomValues,
// which @noble/hashes captures AT MODULE-LOAD time. ml_kem768.keygen() calls it
// during registration; without it the relay registration throws
// "crypto.getRandomValues must be defined" and the identity is never published.
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
