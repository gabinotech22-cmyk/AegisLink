/**
 * Minimal typings for the subset of sodium-native (libsodium N-API binding)
 * used by `crypto/sodium/native.ts`. sodium-native ships no types, and
 * `@types/sodium-native` tracks an older API; declaring exactly what we call
 * keeps the native surface auditable. Byte-identical twins:
 * `server/src/types/sodium-native.d.ts`, `desktop/src/main/types/sodium-native.d.ts`,
 * `mobile/modules/aegis-sodium/jest/sodium-native.d.ts`.
 */
declare module 'sodium-native' {
  type Bytes = Uint8Array;

  const sodium: {
    randombytes_buf(buf: Bytes): void;
    sodium_memcmp(a: Bytes, b: Bytes): boolean;
    sodium_memzero(buf: Bytes): void;
    /** Secure memory (guard pages, mlock) for the desktop key vault (F-1b). */
    sodium_malloc(size: number): Buffer;
    sodium_mprotect_noaccess(buf: Buffer): void;
    sodium_mprotect_readonly(buf: Buffer): void;
    sodium_mprotect_readwrite(buf: Buffer): void;

    crypto_box_keypair(pk: Bytes, sk: Bytes): void;
    crypto_box_easy(c: Bytes, m: Bytes, n: Bytes, pk: Bytes, sk: Bytes): void;
    crypto_box_open_easy(m: Bytes, c: Bytes, n: Bytes, pk: Bytes, sk: Bytes): boolean;

    crypto_secretbox_easy(c: Bytes, m: Bytes, n: Bytes, k: Bytes): void;
    crypto_secretbox_open_easy(m: Bytes, c: Bytes, n: Bytes, k: Bytes): boolean;

    /** Throws when the result is the all-zero point (low-order input). */
    crypto_scalarmult(q: Bytes, n: Bytes, p: Bytes): void;
    crypto_scalarmult_base(q: Bytes, n: Bytes): void;

    /** Salsa20 keystream (desktop: HSalsa20 for `boxBefore.ts`). */
    crypto_stream_salsa20(c: Bytes, n: Bytes, k: Bytes): void;

    crypto_sign_keypair(pk: Bytes, sk: Bytes): void;
    crypto_sign_seed_keypair(pk: Bytes, sk: Bytes, seed: Bytes): void;
    crypto_sign_detached(sig: Bytes, m: Bytes, sk: Bytes): void;
    crypto_sign_verify_detached(sig: Bytes, m: Bytes, pk: Bytes): boolean;

    /** The proof-of-work miner's hash (`jest/nodeBackend.ts` powSha256). */
    crypto_hash_sha256(out: Bytes, input: Bytes): void;

    /** Argon2 with a 16-byte salt only (mobile Jest stand-in: `jest/nodeBackend.ts`). */
    crypto_pwhash(out: Bytes, pwd: Bytes, salt: Bytes, opslimit: number, memlimit: number, alg: number): void;
    readonly crypto_pwhash_ALG_ARGON2ID13: number;
    readonly crypto_pwhash_SALTBYTES: number;
  };

  export default sodium;
}
