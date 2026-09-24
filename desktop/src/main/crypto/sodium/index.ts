/**
 * Main-process NaCl entry point (post-audit follow-up F-1): native libsodium
 * (sodium-native) via `./native.ts`, byte-compatible with the TweetNaCl it
 * replaced. It backs the at-rest DB encryption in `ipc/database.ts`; the
 * sandboxed renderer reaches the same native code over IPC (`ipc/sodium.ts`,
 * operation table in `./ops.ts`).
 *
 * Enforced by `src/renderer/crypto/__tests__/crypto-imports.test.ts`.
 */
import * as native from './native'

export interface MainNaclPrimitives {
  randomBytes(n: number): Uint8Array
  secretbox: {
    (msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array
    open(box: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array | null
    readonly keyLength: number
    readonly nonceLength: number
    readonly overheadLength: number
  }
}

export const nacl: MainNaclPrimitives = {
  randomBytes: native.randomBytes,
  // A fresh wrapper: never decorate the native module's own export (ops.ts uses it too).
  secretbox: Object.assign((msg: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array =>
    native.secretbox(msg, nonce, key), {
    open: native.secretboxOpen,
    keyLength: native.LENGTHS.secretboxKey,
    nonceLength: native.LENGTHS.nonce,
    overheadLength: native.LENGTHS.overhead,
  }),
}
