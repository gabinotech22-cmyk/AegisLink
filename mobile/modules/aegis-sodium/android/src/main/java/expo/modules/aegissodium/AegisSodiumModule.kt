package expo.modules.aegissodium

import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import expo.modules.kotlin.typedarray.Uint8Array
import java.nio.ByteBuffer

/**
 * F-1 B2: native libsodium for `src/crypto/sodium` (see ../../../../../../../index.ts).
 *
 * Every function but argon2id and powSha256 is synchronous (JSI) and writes into
 * caller-allocated output arrays, returning the C core's code: 0 ok,
 * 1 verification failed, -1 bad length, -2 libsodium failure. No key material
 * is copied into the JVM heap: buffers are direct views of the JS arrays.
 * argon2id and powSha256 are the exceptions (async; see below).
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
  @JvmStatic external fun argon2id(out: ByteBuffer?, pwd: ByteBuffer?, salt: ByteBuffer?, t: Int, m: Int): Int
  @JvmStatic external fun powSha256(nonce: ByteBuffer?, challenge: ByteBuffer?, difficulty: Int): Int
  @JvmStatic external fun mlkem768Keypair(pk: ByteBuffer?, sk: ByteBuffer?): Int
  @JvmStatic external fun mlkem768SeedKeypair(pk: ByteBuffer?, sk: ByteBuffer?, seed: ByteBuffer?): Int
  @JvmStatic external fun mlkem768Enc(ct: ByteBuffer?, ss: ByteBuffer?, pk: ByteBuffer?): Int
  @JvmStatic external fun mlkem768Dec(ss: ByteBuffer?, ct: ByteBuffer?, sk: ByteBuffer?): Int
}

/** A direct view of the JS array's memory, or null when it is empty (Hermes may give it no storage). */
private fun b(a: Uint8Array): ByteBuffer? = if (a.byteLength == 0) null else a.toDirectBuffer()

/** A native-heap copy of `bytes` for a call made off the JS thread; null when empty. */
private fun direct(bytes: ByteArray): ByteBuffer? =
  if (bytes.isEmpty()) null else ByteBuffer.allocateDirect(bytes.size).put(bytes).also { it.flip() }

private fun wipe(buf: ByteBuffer?) {
  if (buf == null) return
  buf.clear()
  while (buf.hasRemaining()) buf.put(0)
}

/**
 * Argon2id runs for hundreds of milliseconds, so it is an AsyncFunction (a
 * background thread) and cannot touch JS memory: Expo copies the password and
 * salt into ByteArrays on the JS thread, and the key comes back as an int array.
 * Every copy made here is zeroed before returning.
 */
private fun argon2id(pwd: ByteArray, salt: ByteArray, t: Int, mKib: Int, outLen: Int): IntArray {
  if (outLen <= 0 || outLen > 64) {
    pwd.fill(0)
    throw CodedException("ERR_AEGIS_ARGON2", "aegis_argon2id: bad output length", null)
  }
  val out = ByteBuffer.allocateDirect(outLen)
  val p = direct(pwd)
  pwd.fill(0)
  val s = direct(salt)
  try {
    val rc = AegisSodiumNative.argon2id(out, p, s, t, mKib)
    if (rc != 0) throw CodedException("ERR_AEGIS_ARGON2", "aegis_argon2id failed: $rc", null)
    return IntArray(outLen) { out.get(it).toInt() and 0xff }
  } finally {
    wipe(out)
    wipe(p)
  }
}

/**
 * The registration proof-of-work: up to a few hundred thousand SHA-256 hashes,
 * so it runs off the JS thread like argon2id. The challenge is public (it came
 * from the relay); the nonce comes back as its 8 ASCII hex characters.
 */
private fun powSha256(challenge: ByteArray, difficulty: Int): String {
  val nonce = ByteBuffer.allocateDirect(8)
  val rc = AegisSodiumNative.powSha256(nonce, direct(challenge), difficulty)
  if (rc != 0) throw CodedException("ERR_AEGIS_POW", "aegis_pow_sha256 failed: $rc", null)
  return String(ByteArray(8) { nonce.get(it) }, Charsets.US_ASCII)
}

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
    Function("mlkem768Keypair") { pk: Uint8Array, sk: Uint8Array -> AegisSodiumNative.mlkem768Keypair(b(pk), b(sk)) }
    Function("mlkem768SeedKeypair") { pk: Uint8Array, sk: Uint8Array, seed: Uint8Array ->
      AegisSodiumNative.mlkem768SeedKeypair(b(pk), b(sk), b(seed))
    }
    Function("mlkem768Enc") { ct: Uint8Array, ss: Uint8Array, pk: Uint8Array ->
      AegisSodiumNative.mlkem768Enc(b(ct), b(ss), b(pk))
    }
    Function("mlkem768Dec") { ss: Uint8Array, ct: Uint8Array, sk: Uint8Array ->
      AegisSodiumNative.mlkem768Dec(b(ss), b(ct), b(sk))
    }
    AsyncFunction("argon2id") { pwd: ByteArray, salt: ByteArray, t: Int, mKib: Int, outLen: Int ->
      argon2id(pwd, salt, t, mKib, outLen)
    }
    AsyncFunction("powSha256") { challenge: ByteArray, difficulty: Int -> powSha256(challenge, difficulty) }
  }
}
