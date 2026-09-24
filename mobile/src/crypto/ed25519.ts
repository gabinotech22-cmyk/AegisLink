/**
 * Strict Ed25519 signature verification.
 *
 * TweetNaCl's `nacl.sign.detached.verify` does not check that the scalar half
 * of the signature (S, bytes 32..63) is reduced mod L. Any valid signature
 * (R, S) therefore has a second valid encoding (R, S + L) for the same message
 * and key: signatures are malleable. This does NOT allow forging a signature
 * over a new message, but it breaks any code that treats signature bytes as
 * unique (dedup, replay caches, content ids). libsodium and @noble reject
 * S >= L (RFC 8032 §5.1.7); we do the same, then defer to TweetNaCl.
 *
 * Every Ed25519 verification in the client goes through this function — never
 * call `nacl.sign.detached.verify` directly. The same file lives, byte-identical
 * in logic, in `desktop/src/renderer/crypto/ed25519.ts` and
 * `server/src/crypto/ed25519.ts`.
 *
 * The comparison is not constant-time on purpose: S is public (it travels on
 * the wire), so its value leaks nothing.
 */
import { nacl } from './sodium';

/** L = 2^252 + 27742317777372353535851937790883648493, little-endian. */
const L = new Uint8Array([
  0xed, 0xd3, 0xf5, 0x5c, 0x1a, 0x63, 0x12, 0x58,
  0xd6, 0x9c, 0xf7, 0xa2, 0xde, 0xf9, 0xde, 0x14,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
  0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x10,
]);

/** True iff the 32-byte little-endian scalar at `sig[32..64)` is < L. */
export function isCanonicalScalar(sig: Uint8Array): boolean {
  if (sig.length !== nacl.sign.signatureLength) return false;
  for (let i = 31; i >= 0; i--) {
    const s = sig[32 + i];
    if (s < L[i]) return true;
    if (s > L[i]) return false;
  }
  return false; // S == L
}

/** `nacl.sign.detached.verify`, plus rejection of non-canonical S. */
export function verifyDetached(msg: Uint8Array, sig: Uint8Array, publicKey: Uint8Array): boolean {
  if (!isCanonicalScalar(sig)) return false;
  return nacl.sign.detached.verify(msg, sig, publicKey);
}
