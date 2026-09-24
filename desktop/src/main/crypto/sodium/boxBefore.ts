/**
 * `crypto_box_beforenm` (TweetNaCl `nacl.box.before`) on native libsodium.
 *
 * sodium-native does not expose `crypto_box_beforenm` nor `crypto_core_hsalsa20`,
 * so it is composed from what it does expose, natively:
 *
 *   k = HSalsa20(X25519(sk, pk), 0^16)
 *
 * HSalsa20 is the Salsa20 core WITHOUT the final feed-forward, returning words
 * 0, 5, 10, 15, 6, 7, 8, 9. A Salsa20 keystream block with a zero nonce and a
 * zero block counter has exactly HSalsa20's input state (sigma, key, 16 zero
 * bytes in words 6-9), so HSalsa20 = block - input on those words: minus sigma
 * on 0/5/10/15, and words 6-9 as they are (their input is zero). Pinned against
 * TweetNaCl in `__tests__/sodium-ops.test.ts`.
 *
 * Desktop-only (mobile's public-channel approvals need it; the relay does not),
 * so it lives beside — not inside — `native.ts`, which must stay byte-identical
 * to the relay's copy.
 *
 * Stricter than TweetNaCl, like `scalarMult`: a low-order `pk` THROWS instead of
 * deriving a key from the all-zero point (libsodium's crypto_box_beforenm, which
 * mobile runs, fails the same way).
 */
import sodium from 'sodium-native'
import { scalarMult } from './native'

// "expand 32-byte k", little-endian words.
const SIGMA = [0x61707865, 0x3320646e, 0x79622d32, 0x6b206574] as const
const SIGMA_WORDS = [0, 5, 10, 15] as const

export function boxBefore(publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array {
  if (!(publicKey instanceof Uint8Array) || !(secretKey instanceof Uint8Array)) {
    throw new TypeError('unexpected type, use Uint8Array')
  }
  if (publicKey.length !== 32) throw new Error('bad public key size')
  if (secretKey.length !== 32) throw new Error('bad secret key size')
  const shared = scalarMult(secretKey, publicKey)
  const block = new Uint8Array(64)
  try {
    sodium.crypto_stream_salsa20(block, new Uint8Array(8), shared)
    const words = new DataView(block.buffer, block.byteOffset, block.byteLength)
    const out = new Uint8Array(32)
    const outWords = new DataView(out.buffer)
    SIGMA_WORDS.forEach((w, i) => {
      outWords.setUint32(i * 4, (words.getUint32(w * 4, true) - SIGMA[i]) >>> 0, true)
    })
    for (let i = 0; i < 4; i++) outWords.setUint32(16 + i * 4, words.getUint32((6 + i) * 4, true), true)
    return out
  } finally {
    // golden rule #9: the raw DH output and the keystream block are key material.
    shared.fill(0)
    block.fill(0)
  }
}
