package expo.modules.aegissodium

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array
import java.nio.ByteBuffer

/**
 * F-1 B2: native libsodium for `src/crypto/sodium` (see ../../../../../../../index.ts).
 *
 * Every function is synchronous (JSI) and writes into caller-allocated output
 * arrays, returning the C core's code: 0 ok, 1 verification failed,
 * -1 bad length, -2 libsodium failure. No key material is copied into the
 * JVM heap: buffers are direct views of the JS arrays.
 */
internal object AegisSodiumNative {
  init {
    System.loadLibrary("aegis_sodium")
  }

  @JvmStatic external fun nativeInit(): Int
  @JvmStatic external fun randombytes(buf: ByteBuffer?): Int
  @JvmStatic external fun memcmp(a: ByteBuffer?, b: ByteBuffer?): Int
  @JvmStatic external fun boxKeypair(pk: ByteBuffer?, sk: ByteBuffer?): Int
  @JvmStatic external fun boxEasy(c: ByteBuffer?, m: ByteBuffer?, n: ByteBuffer?, pk: ByteBuffer?, sk: ByteBuffer?): Int
  @JvmStatic external fun boxOpenEasy(m: ByteBuffer?, c: ByteBuffer?, n: ByteBuffer?, pk: ByteBuffer?, sk: ByteBuffer?): Int
  @JvmStatic external fun boxBeforenm(k: ByteBuffer?, pk: ByteBuffer?, sk: ByteBuffer?): Int
  @JvmStatic external fun secretboxEasy(c: ByteBuffer?, m: ByteBuffer?, n: ByteBuffer?, k: ByteBuffer?): Int
  @JvmStatic external fun secretboxOpenEasy(m: ByteBuffer?, c: ByteBuffer?, n: ByteBuffer?, k: ByteBuffer?): Int
  @JvmStatic external fun scalarmult(q: ByteBuffer?, n: ByteBuffer?, p: ByteBuffer?): Int
  @JvmStatic external fun scalarmultBase(q: ByteBuffer?, n: ByteBuffer?): Int
  @JvmStatic external fun signKeypair(pk: ByteBuffer?, sk: ByteBuffer?): Int
  @JvmStatic external fun signSeedKeypair(pk: ByteBuffer?, sk: ByteBuffer?, seed: ByteBuffer?): Int
  @JvmStatic external fun signDetached(sig: ByteBuffer?, m: ByteBuffer?, sk: ByteBuffer?): Int
  @JvmStatic external fun signVerifyDetached(sig: ByteBuffer?, m: ByteBuffer?, pk: ByteBuffer?): Int
  @JvmStatic external fun hmacsha256(out: ByteBuffer?, m: ByteBuffer?, k: ByteBuffer?): Int
  @JvmStatic external fun hkdfSha256(out: ByteBuffer?, ikm: ByteBuffer?, salt: ByteBuffer?, info: ByteBuffer?): Int
}

/** A direct view of the JS array's memory, or null when it is empty (Hermes may give it no storage). */
private fun b(a: Uint8Array): ByteBuffer? = if (a.byteLength == 0) null else a.toDirectBuffer()

class AegisSodiumModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("AegisSodium")

    Function("init") { AegisSodiumNative.nativeInit() }
    Function("randombytes") { buf: Uint8Array -> AegisSodiumNative.randombytes(b(buf)) }
    Function("memcmp") { a: Uint8Array, c: Uint8Array -> AegisSodiumNative.memcmp(b(a), b(c)) }
    Function("boxKeypair") { pk: Uint8Array, sk: Uint8Array -> AegisSodiumNative.boxKeypair(b(pk), b(sk)) }
    Function("boxEasy") { c: Uint8Array, m: Uint8Array, n: Uint8Array, pk: Uint8Array, sk: Uint8Array ->
      AegisSodiumNative.boxEasy(b(c), b(m), b(n), b(pk), b(sk))
    }
    Function("boxOpenEasy") { m: Uint8Array, c: Uint8Array, n: Uint8Array, pk: Uint8Array, sk: Uint8Array ->
      AegisSodiumNative.boxOpenEasy(b(m), b(c), b(n), b(pk), b(sk))
    }
    Function("boxBeforenm") { k: Uint8Array, pk: Uint8Array, sk: Uint8Array ->
      AegisSodiumNative.boxBeforenm(b(k), b(pk), b(sk))
    }
    Function("secretboxEasy") { c: Uint8Array, m: Uint8Array, n: Uint8Array, k: Uint8Array ->
      AegisSodiumNative.secretboxEasy(b(c), b(m), b(n), b(k))
    }
    Function("secretboxOpenEasy") { m: Uint8Array, c: Uint8Array, n: Uint8Array, k: Uint8Array ->
      AegisSodiumNative.secretboxOpenEasy(b(m), b(c), b(n), b(k))
    }
    Function("scalarmult") { q: Uint8Array, n: Uint8Array, p: Uint8Array ->
      AegisSodiumNative.scalarmult(b(q), b(n), b(p))
    }
    Function("scalarmultBase") { q: Uint8Array, n: Uint8Array -> AegisSodiumNative.scalarmultBase(b(q), b(n)) }
    Function("signKeypair") { pk: Uint8Array, sk: Uint8Array -> AegisSodiumNative.signKeypair(b(pk), b(sk)) }
    Function("signSeedKeypair") { pk: Uint8Array, sk: Uint8Array, seed: Uint8Array ->
      AegisSodiumNative.signSeedKeypair(b(pk), b(sk), b(seed))
    }
    Function("signDetached") { sig: Uint8Array, m: Uint8Array, sk: Uint8Array ->
      AegisSodiumNative.signDetached(b(sig), b(m), b(sk))
    }
    Function("signVerifyDetached") { sig: Uint8Array, m: Uint8Array, pk: Uint8Array ->
      AegisSodiumNative.signVerifyDetached(b(sig), b(m), b(pk))
    }
    Function("hmacsha256") { out: Uint8Array, m: Uint8Array, k: Uint8Array ->
      AegisSodiumNative.hmacsha256(b(out), b(m), b(k))
    }
    Function("hkdfSha256") { out: Uint8Array, ikm: Uint8Array, salt: Uint8Array, info: Uint8Array ->
      AegisSodiumNative.hkdfSha256(b(out), b(ikm), b(salt), b(info))
    }
  }
}
