/**
 * HMAC-SHA256 / HKDF-SHA256 for the renderer — the keyed hash primitives (chain
 * keys, root keys, mailbox roots) — on node:crypto (OpenSSL, native) in the main
 * process (F-1). Byte-identical to the @noble/hashes implementation the renderer
 * used before (pinned by `f1-golden.test.ts`). Unkeyed SHA-2 stays in the
 * renderer (see `src/renderer/crypto/sodium/index.ts`).
 */
import { createHmac, hkdfSync } from 'node:crypto'

const toBytes = (b: Uint8Array | ArrayBuffer): Uint8Array =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))

export function hmacSha256(key: Uint8Array, data: Uint8Array): Uint8Array {
  return toBytes(createHmac('sha256', key).update(data).digest())
}

/**
 * RFC 5869 HKDF-SHA256. An undefined salt is an empty salt, which HMAC pads to
 * the same block as the RFC's HashLen zero bytes (what @noble did), so the
 * output is identical. node:crypto caps `info` at 1024 bytes (every caller
 * passes a short constant label); above that it throws — never a different key.
 */
export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array | undefined,
  info: Uint8Array | undefined,
  length: number,
): Uint8Array {
  return toBytes(hkdfSync('sha256', ikm, salt ?? new Uint8Array(0), info ?? new Uint8Array(0), length))
}
