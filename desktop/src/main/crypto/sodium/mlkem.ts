/**
 * ML-KEM-768 (FIPS 203) for the renderer, in the MAIN process (F-1b phase 2).
 * sodium-native 5.1 does not expose libsodium's crypto_kem_mlkem768, so this is
 * @noble/post-quantum — the implementation the renderer used to run itself, so
 * the bytes are unchanged (same seed → key pair, same 2400-byte secret key,
 * same ciphertexts, same implicit rejection). What moves: the computation and
 * its intermediates leave the renderer's heap. It is still JavaScript, so its
 * constant-time guarantee remains source-level (docs/PROTOCOL.md §2.1).
 */
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js'

const PK = 1184
const SK = 2400
const CT = 1088
const SEED = 64

function bytes(v: unknown, len: number, what: string): Uint8Array {
  if (!(v instanceof Uint8Array)) throw new TypeError('unexpected type, use Uint8Array')
  if (v.length !== len) throw new Error(`ml_kem768.${what}: bad size`)
  return v
}

export function mlkemKeygen(seed?: Uint8Array): { publicKey: Uint8Array; secretKey: Uint8Array } {
  return seed === undefined ? ml_kem768.keygen() : ml_kem768.keygen(bytes(seed, SEED, 'keygen seed'))
}

export function mlkemEncapsulate(publicKey: Uint8Array): { cipherText: Uint8Array; sharedSecret: Uint8Array } {
  return ml_kem768.encapsulate(bytes(publicKey, PK, 'encapsulate public key'))
}

export function mlkemDecapsulate(cipherText: Uint8Array, secretKey: Uint8Array): Uint8Array {
  return ml_kem768.decapsulate(bytes(cipherText, CT, 'decapsulate ciphertext'), bytes(secretKey, SK, 'decapsulate secret key'))
}
