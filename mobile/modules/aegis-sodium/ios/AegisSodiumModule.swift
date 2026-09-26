import AegisSodiumC
import ExpoModulesCore
import Foundation

/// F-1 B2: native libsodium for `src/crypto/sodium` (see ../index.ts).
///
/// Every function but argon2id, pbkdf2Sha256 and powSha256 is synchronous (JSI) and writes into
/// caller-allocated output arrays, returning the C core's code: 0 ok,
/// 1 verification failed, -1 bad length, -2 libsodium failure. The pointers
/// are the JS arrays' own memory (expo-modules-core `rawPointer`, byteOffset
/// already applied); no key material is copied. aegis_sodium.c validates every
/// length. Those three are the exceptions (async; see below).
public class AegisSodiumModule: Module {
  public func definition() -> ModuleDefinition {
    Name("AegisSodium")

    Function("init") { () -> Int in Int(aegis_init()) }
    Function("randombytes") { (buf: Uint8Array) -> Int in
      Int(aegis_randombytes(mp(buf), n(buf)))
    }
    Function("memcmp") { (a: Uint8Array, b: Uint8Array) -> Int in
      Int(aegis_memcmp(p(a), n(a), p(b), n(b)))
    }
    Function("boxKeypair") { (pk: Uint8Array, sk: Uint8Array) -> Int in
      Int(aegis_box_keypair(mp(pk), n(pk), mp(sk), n(sk)))
    }
    Function("boxEasy") { (c: Uint8Array, m: Uint8Array, nonce: Uint8Array, pk: Uint8Array, sk: Uint8Array) -> Int in
      Int(aegis_box_easy(mp(c), n(c), p(m), n(m), p(nonce), n(nonce), p(pk), n(pk), p(sk), n(sk)))
    }
    Function("boxOpenEasy") { (m: Uint8Array, c: Uint8Array, nonce: Uint8Array, pk: Uint8Array, sk: Uint8Array) -> Int in
      Int(aegis_box_open_easy(mp(m), n(m), p(c), n(c), p(nonce), n(nonce), p(pk), n(pk), p(sk), n(sk)))
    }
    Function("boxBeforenm") { (k: Uint8Array, pk: Uint8Array, sk: Uint8Array) -> Int in
      Int(aegis_box_beforenm(mp(k), n(k), p(pk), n(pk), p(sk), n(sk)))
    }
    Function("secretboxEasy") { (c: Uint8Array, m: Uint8Array, nonce: Uint8Array, k: Uint8Array) -> Int in
      Int(aegis_secretbox_easy(mp(c), n(c), p(m), n(m), p(nonce), n(nonce), p(k), n(k)))
    }
    Function("secretboxOpenEasy") { (m: Uint8Array, c: Uint8Array, nonce: Uint8Array, k: Uint8Array) -> Int in
      Int(aegis_secretbox_open_easy(mp(m), n(m), p(c), n(c), p(nonce), n(nonce), p(k), n(k)))
    }
    Function("scalarmult") { (q: Uint8Array, scalar: Uint8Array, point: Uint8Array) -> Int in
      Int(aegis_scalarmult(mp(q), n(q), p(scalar), n(scalar), p(point), n(point)))
    }
    Function("scalarmultBase") { (q: Uint8Array, scalar: Uint8Array) -> Int in
      Int(aegis_scalarmult_base(mp(q), n(q), p(scalar), n(scalar)))
    }
    Function("signKeypair") { (pk: Uint8Array, sk: Uint8Array) -> Int in
      Int(aegis_sign_keypair(mp(pk), n(pk), mp(sk), n(sk)))
    }
    Function("signSeedKeypair") { (pk: Uint8Array, sk: Uint8Array, seed: Uint8Array) -> Int in
      Int(aegis_sign_seed_keypair(mp(pk), n(pk), mp(sk), n(sk), p(seed), n(seed)))
    }
    Function("signDetached") { (sig: Uint8Array, m: Uint8Array, sk: Uint8Array) -> Int in
      Int(aegis_sign_detached(mp(sig), n(sig), p(m), n(m), p(sk), n(sk)))
    }
    Function("signVerifyDetached") { (sig: Uint8Array, m: Uint8Array, pk: Uint8Array) -> Int in
      Int(aegis_sign_verify_detached(p(sig), n(sig), p(m), n(m), p(pk), n(pk)))
    }
    Function("hmacsha256") { (out: Uint8Array, m: Uint8Array, k: Uint8Array) -> Int in
      Int(aegis_hmacsha256(mp(out), n(out), p(m), n(m), p(k), n(k)))
    }
    Function("hkdfSha256") { (out: Uint8Array, ikm: Uint8Array, salt: Uint8Array, info: Uint8Array) -> Int in
      Int(aegis_hkdf_sha256(mp(out), n(out), p(ikm), n(ikm), p(salt), n(salt), p(info), n(info)))
    }
    Function("mlkem768Keypair") { (pk: Uint8Array, sk: Uint8Array) -> Int in
      Int(aegis_mlkem768_keypair(mp(pk), n(pk), mp(sk), n(sk)))
    }
    Function("mlkem768SeedKeypair") { (pk: Uint8Array, sk: Uint8Array, seed: Uint8Array) -> Int in
      Int(aegis_mlkem768_seed_keypair(mp(pk), n(pk), mp(sk), n(sk), p(seed), n(seed)))
    }
    Function("mlkem768Enc") { (ct: Uint8Array, ss: Uint8Array, pk: Uint8Array) -> Int in
      Int(aegis_mlkem768_enc(mp(ct), n(ct), mp(ss), n(ss), p(pk), n(pk)))
    }
    Function("mlkem768Dec") { (ss: Uint8Array, ct: Uint8Array, sk: Uint8Array) -> Int in
      Int(aegis_mlkem768_dec(mp(ss), n(ss), p(ct), n(ct), p(sk), n(sk)))
    }
    // Hundreds of milliseconds of work: async (off the JS thread), so it cannot
    // touch JS memory. Expo copies the password and salt into `Data` on the JS
    // thread; the key comes back as an int array. Copies made here are zeroed.
    AsyncFunction("argon2id") { (pwd: Data, salt: Data, t: Int, mKib: Int, outLen: Int) throws -> [Int] in
      // Zero the password copy in place (resetBytes on a `var` copy would only
      // zero a fresh copy-on-write buffer, not this one).
      defer { wipe(pwd) }
      guard (1...64).contains(outLen), t >= 0, t <= Int(UInt32.max), mKib >= 0, mKib <= Int(UInt32.max) else {
        throw Exception(name: "ERR_AEGIS_ARGON2", description: "aegis_argon2id: bad parameters")
      }
      var out = [UInt8](repeating: 0, count: outLen)
      defer { out.withUnsafeMutableBytes { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) } }
      let rc = pwd.withUnsafeBytes { (pw: UnsafeRawBufferPointer) -> Int32 in
        salt.withUnsafeBytes { (sa: UnsafeRawBufferPointer) -> Int32 in
          aegis_argon2id(
            &out, outLen,
            pw.count == 0 ? nil : pw.bindMemory(to: UInt8.self).baseAddress, pw.count,
            sa.count == 0 ? nil : sa.bindMemory(to: UInt8.self).baseAddress, sa.count,
            UInt32(t), UInt32(mKib))
        }
      }
      guard rc == 0 else {
        throw Exception(name: "ERR_AEGIS_ARGON2", description: "aegis_argon2id failed: \(rc)")
      }
      return out.map { Int($0) }
    }
    // PBKDF2-HMAC-SHA256 for legacy backups (up to 600k iterations): async
    // like argon2id, with the same zeroing of the password and key copies.
    AsyncFunction("pbkdf2Sha256") { (pwd: Data, salt: Data, iterations: Int, outLen: Int) throws -> [Int] in
      defer { wipe(pwd) }
      guard (1...64).contains(outLen), iterations >= 0, iterations <= Int(UInt32.max) else {
        throw Exception(name: "ERR_AEGIS_PBKDF2", description: "aegis_pbkdf2_sha256: bad parameters")
      }
      var out = [UInt8](repeating: 0, count: outLen)
      defer { out.withUnsafeMutableBytes { _ = memset_s($0.baseAddress, $0.count, 0, $0.count) } }
      let rc = pwd.withUnsafeBytes { (pw: UnsafeRawBufferPointer) -> Int32 in
        salt.withUnsafeBytes { (sa: UnsafeRawBufferPointer) -> Int32 in
          aegis_pbkdf2_sha256(
            &out, outLen,
            pw.count == 0 ? nil : pw.bindMemory(to: UInt8.self).baseAddress, pw.count,
            sa.count == 0 ? nil : sa.bindMemory(to: UInt8.self).baseAddress, sa.count,
            UInt32(iterations))
        }
      }
      guard rc == 0 else {
        throw Exception(name: "ERR_AEGIS_PBKDF2", description: "aegis_pbkdf2_sha256 failed: \(rc)")
      }
      return out.map { Int($0) }
    }
    // The registration proof-of-work: up to a few hundred thousand SHA-256
    // hashes, so async like argon2id. The challenge is public (it came from the
    // relay); the nonce comes back as its 8 ASCII hex characters.
    AsyncFunction("powSha256") { (challenge: Data, difficulty: Int) throws -> String in
      guard difficulty >= 0, difficulty <= Int(UInt32.max) else {
        throw Exception(name: "ERR_AEGIS_POW", description: "aegis_pow_sha256: bad difficulty")
      }
      let nonceLen = 8
      var nonce = [UInt8](repeating: 0, count: nonceLen)
      let rc = challenge.withUnsafeBytes { (ch: UnsafeRawBufferPointer) -> Int32 in
        aegis_pow_sha256(
          &nonce, nonceLen,
          ch.count == 0 ? nil : ch.bindMemory(to: UInt8.self).baseAddress, ch.count,
          UInt32(difficulty))
      }
      guard rc == 0 else {
        throw Exception(name: "ERR_AEGIS_POW", description: "aegis_pow_sha256 failed: \(rc)")
      }
      return String(decoding: nonce, as: UTF8.self)
    }
  }
}

/// Length in bytes.
private func n(_ a: Uint8Array) -> Int { a.byteLength }

/// The array's memory, or nil when it is empty: Hermes may back an empty
/// ArrayBuffer with no storage, and the C core accepts NULL for length 0.
private func mp(_ a: Uint8Array) -> UnsafeMutablePointer<UInt8>? {
  a.byteLength == 0 ? nil : a.rawPointer.assumingMemoryBound(to: UInt8.self)
}

private func p(_ a: Uint8Array) -> UnsafePointer<UInt8>? {
  mp(a).map { UnsafePointer($0) }
}

/// Zeroes the bytes backing `data` (memset_s is never optimized away).
private func wipe(_ data: Data) {
  data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
    if let base = buf.baseAddress, buf.count > 0 {
      _ = memset_s(UnsafeMutableRawPointer(mutating: base), buf.count, 0, buf.count)
    }
  }
}
