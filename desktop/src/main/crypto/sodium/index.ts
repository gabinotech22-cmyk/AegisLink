/**
 * Main-process twin of `src/renderer/crypto/sodium` (post-audit follow-up F-1):
 * the one place the Electron main process gets NaCl primitives from. Today it
 * only backs the at-rest DB encryption in `ipc/database.ts`; it is also where
 * the native libsodium binding (sodium-native) lands, which the sandboxed
 * renderer reaches over IPC.
 *
 * Enforced by `src/renderer/crypto/__tests__/crypto-imports.test.ts`.
 */
import tweetnacl from 'tweetnacl'

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

export const nacl: MainNaclPrimitives = tweetnacl
