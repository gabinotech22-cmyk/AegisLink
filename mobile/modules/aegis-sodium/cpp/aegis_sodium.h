/*
 * aegis_sodium — the C core of the AegisLink mobile crypto module (F-1 B2).
 *
 * One function per primitive the JS facade needs, each taking (pointer, length)
 * pairs. EVERY length is validated here, in C, before libsodium touches memory
 * (a pointer may be NULL only when its length is 0):
 * the Kotlin (JNI) and Swift bindings only forward pointers from JS typed
 * arrays, so this file is the memory-safety boundary.
 *
 * Return codes:
 *   AEGIS_OK        success
 *   AEGIS_EVERIFY   authentication / signature verification failed (not an error)
 *   AEGIS_EBADLEN   a buffer has the wrong length
 *   AEGIS_EFAIL     libsodium reported a failure (e.g. low-order X25519 point)
 */
#ifndef AEGIS_SODIUM_H
#define AEGIS_SODIUM_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AEGIS_OK 0
#define AEGIS_EVERIFY 1
#define AEGIS_EBADLEN -1
#define AEGIS_EFAIL -2

/* Must be called once before anything else; idempotent. Returns AEGIS_OK or AEGIS_EFAIL. */
int aegis_init(void);

int aegis_randombytes(uint8_t *buf, size_t len);
/* AEGIS_OK if equal, AEGIS_EVERIFY if different (constant time). Lengths must match. */
int aegis_memcmp(const uint8_t *a, size_t alen, const uint8_t *b, size_t blen);

int aegis_box_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen);
int aegis_box_easy(uint8_t *c, size_t clen, const uint8_t *m, size_t mlen, const uint8_t *n, size_t nlen,
                   const uint8_t *pk, size_t pklen, const uint8_t *sk, size_t sklen);
int aegis_box_open_easy(uint8_t *m, size_t mlen, const uint8_t *c, size_t clen, const uint8_t *n, size_t nlen,
                        const uint8_t *pk, size_t pklen, const uint8_t *sk, size_t sklen);
int aegis_box_beforenm(uint8_t *k, size_t klen, const uint8_t *pk, size_t pklen, const uint8_t *sk, size_t sklen);

int aegis_secretbox_easy(uint8_t *c, size_t clen, const uint8_t *m, size_t mlen, const uint8_t *n, size_t nlen,
                         const uint8_t *k, size_t klen);
int aegis_secretbox_open_easy(uint8_t *m, size_t mlen, const uint8_t *c, size_t clen, const uint8_t *n,
                              size_t nlen, const uint8_t *k, size_t klen);

int aegis_scalarmult(uint8_t *q, size_t qlen, const uint8_t *n, size_t nlen, const uint8_t *p, size_t plen);
int aegis_scalarmult_base(uint8_t *q, size_t qlen, const uint8_t *n, size_t nlen);

int aegis_sign_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen);
int aegis_sign_seed_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen, const uint8_t *seed,
                            size_t seedlen);
int aegis_sign_detached(uint8_t *sig, size_t siglen, const uint8_t *m, size_t mlen, const uint8_t *sk,
                        size_t sklen);
int aegis_sign_verify_detached(const uint8_t *sig, size_t siglen, const uint8_t *m, size_t mlen,
                               const uint8_t *pk, size_t pklen);

/* HMAC-SHA256 with an arbitrary-length key (RFC 2104). */
int aegis_hmacsha256(uint8_t *out, size_t outlen, const uint8_t *m, size_t mlen, const uint8_t *k, size_t klen);

/* RFC 5869 HKDF-SHA256. An empty salt is HashLen zero bytes (RFC 5869 §2.2). outlen in 1..255*32. */
int aegis_hkdf_sha256(uint8_t *out, size_t outlen, const uint8_t *ikm, size_t ikmlen, const uint8_t *salt,
                      size_t saltlen, const uint8_t *info, size_t infolen);

/*
 * Argon2id (RFC 9106, version 0x13), one lane, raw output. libsodium's public
 * crypto_pwhash only takes 16-byte salts; this calls the Argon2 implementation
 * underneath it (argon2id_hash_raw), which takes any salt of 8+ bytes, so the
 * app's existing formats (32-byte backup salts, the duress PIN's domain salt)
 * derive natively and byte-identically to @noble/hashes. Slow by design: the
 * bindings run it off the JS thread.
 */
#define AEGIS_ARGON2_OUT_MIN 16
#define AEGIS_ARGON2_OUT_MAX 64
#define AEGIS_ARGON2_SALT_MIN 8
#define AEGIS_ARGON2_SALT_MAX 64
#define AEGIS_ARGON2_PWD_MAX 65536
#define AEGIS_ARGON2_T_MAX 16
#define AEGIS_ARGON2_M_MIN_KIB 8
#define AEGIS_ARGON2_M_MAX_KIB 262144 /* 256 MiB */
int aegis_argon2id(uint8_t *out, size_t outlen, const uint8_t *pwd, size_t pwdlen, const uint8_t *salt,
                   size_t saltlen, uint32_t t_cost, uint32_t m_kib);

/*
 * Registration proof-of-work (the relay's server/src/pow/challenge.ts): find
 * the first 8-hex-digit nonce "00000000", "00000001", ... "ffffffff" such that
 * SHA-256(nonce || challenge) starts with `difficulty` zero bits, and write its
 * 8 ASCII characters to `nonce`. Same order, and so the same nonce, as the
 * JavaScript miner it replaces. AEGIS_EFAIL if none of the 2^32 nonces works
 * (never at the relay's difficulties, 12-18). Seconds of work on Hermes, a
 * fraction of a second here: the bindings run it off the JS thread.
 */
#define AEGIS_POW_NONCE_LEN 8
#define AEGIS_POW_CHALLENGE_MAX 512
#define AEGIS_POW_DIFFICULTY_MAX 32
int aegis_pow_sha256(uint8_t *nonce, size_t noncelen, const uint8_t *challenge, size_t challen, uint32_t difficulty);

/*
 * ML-KEM-768 (FIPS 203), libsodium's crypto_kem_mlkem768. Byte-compatible with
 * @noble/post-quantum, which the app used before: same seed -> key pair, same
 * 2400-byte expanded secret key (dk), same ciphertexts and shared secrets, same
 * implicit rejection of a tampered ciphertext, so stored PQ prekeys and ratchet
 * states keep working. The shared secret is secret: callers zero it when done.
 */
#define AEGIS_MLKEM768_PK 1184
#define AEGIS_MLKEM768_SK 2400
#define AEGIS_MLKEM768_CT 1088
#define AEGIS_MLKEM768_SS 32
#define AEGIS_MLKEM768_SEED 64
int aegis_mlkem768_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen);
/* Deterministic key pair from a 64-byte seed (d || z); for test vectors. */
int aegis_mlkem768_seed_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen, const uint8_t *seed,
                                size_t seedlen);
/* AEGIS_EFAIL if the public key fails FIPS 203's encapsulation-key check. */
int aegis_mlkem768_enc(uint8_t *ct, size_t ctlen, uint8_t *ss, size_t sslen, const uint8_t *pk, size_t pklen);
/* AEGIS_OK for any well-formed ciphertext (implicit rejection); AEGIS_EFAIL if the secret key
 * fails FIPS 203's hash check (H(ek) embedded in dk), as @noble's decapsulate does. */
int aegis_mlkem768_dec(uint8_t *ss, size_t sslen, const uint8_t *ct, size_t ctlen, const uint8_t *sk, size_t sklen);

/*
 * PBKDF2-HMAC-SHA256 (RFC 8018), for restoring legacy v1/v2 backups (100k and
 * 600k iterations). Byte-identical to @noble/hashes pbkdf2(sha256, ...), which
 * wrote them. Slow by design: the bindings run it off the JS thread.
 */
#define AEGIS_PBKDF2_OUT_MAX 64
#define AEGIS_PBKDF2_PWD_MAX 65536
#define AEGIS_PBKDF2_SALT_MAX 1024
#define AEGIS_PBKDF2_ITER_MAX 10000000
int aegis_pbkdf2_sha256(uint8_t *out, size_t outlen, const uint8_t *pwd, size_t pwdlen, const uint8_t *salt,
                        size_t saltlen, uint32_t iterations);

#ifdef __cplusplus
}
#endif

#endif
