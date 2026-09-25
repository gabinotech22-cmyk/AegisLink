/*
 * aegis_sodium — see aegis_sodium.h. Every function validates every length
 * (and that a non-empty buffer is not NULL) before calling libsodium; a wrong
 * length is AEGIS_EBADLEN, never a read or write out of bounds.
 *
 * The bindings pass NULL for a zero-length JS array (Hermes may back an empty
 * ArrayBuffer with no storage), so a NULL pointer is valid exactly when its
 * length is 0.
 */
#include "aegis_sodium.h"

#include <sodium.h>
#include <string.h>

/* libsodium's internal Argon2 API (not part of <sodium.h>), compiled from the same vendored sources. */
#include "../vendor/libsodium/src/libsodium/crypto_pwhash/argon2/argon2.h"

/* A buffer of `len` bytes: NULL only when empty. */
#define NEED(p, len)                                                                                                 \
  do {                                                                                                               \
    if ((len) != 0 && (p) == NULL) return AEGIS_EBADLEN;                                                             \
  } while (0)

/* A buffer that must be exactly `want` bytes (want > 0, so never NULL). */
#define EXACT(p, len, want)                                                                                          \
  do {                                                                                                               \
    if ((len) != (want) || (p) == NULL) return AEGIS_EBADLEN;                                                        \
  } while (0)

int aegis_init(void) {
  /* sodium_init: 0 = initialized now, 1 = already initialized, -1 = failure. */
  return sodium_init() < 0 ? AEGIS_EFAIL : AEGIS_OK;
}

int aegis_randombytes(uint8_t *buf, size_t len) {
  NEED(buf, len);
  if (len > 0) randombytes_buf(buf, len);
  return AEGIS_OK;
}

int aegis_memcmp(const uint8_t *a, size_t alen, const uint8_t *b, size_t blen) {
  if (alen != blen) return AEGIS_EBADLEN;
  if (alen == 0) return AEGIS_EVERIFY;
  NEED(a, alen);
  NEED(b, blen);
  return sodium_memcmp(a, b, alen) == 0 ? AEGIS_OK : AEGIS_EVERIFY;
}

int aegis_box_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen) {
  EXACT(pk, pklen, crypto_box_PUBLICKEYBYTES);
  EXACT(sk, sklen, crypto_box_SECRETKEYBYTES);
  return crypto_box_keypair(pk, sk) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_box_easy(uint8_t *c, size_t clen, const uint8_t *m, size_t mlen, const uint8_t *n, size_t nlen,
                   const uint8_t *pk, size_t pklen, const uint8_t *sk, size_t sklen) {
  if (mlen > SIZE_MAX - crypto_box_MACBYTES || clen != mlen + crypto_box_MACBYTES || c == NULL) return AEGIS_EBADLEN;
  NEED(m, mlen);
  EXACT(n, nlen, crypto_box_NONCEBYTES);
  EXACT(pk, pklen, crypto_box_PUBLICKEYBYTES);
  EXACT(sk, sklen, crypto_box_SECRETKEYBYTES);
  return crypto_box_easy(c, m, mlen, n, pk, sk) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_box_open_easy(uint8_t *m, size_t mlen, const uint8_t *c, size_t clen, const uint8_t *n, size_t nlen,
                        const uint8_t *pk, size_t pklen, const uint8_t *sk, size_t sklen) {
  uint8_t empty[1];
  if (clen < crypto_box_MACBYTES || mlen != clen - crypto_box_MACBYTES || c == NULL) return AEGIS_EBADLEN;
  NEED(m, mlen);
  EXACT(n, nlen, crypto_box_NONCEBYTES);
  EXACT(pk, pklen, crypto_box_PUBLICKEYBYTES);
  EXACT(sk, sklen, crypto_box_SECRETKEYBYTES);
  return crypto_box_open_easy(m != NULL ? m : empty, c, clen, n, pk, sk) == 0 ? AEGIS_OK : AEGIS_EVERIFY;
}

int aegis_box_beforenm(uint8_t *k, size_t klen, const uint8_t *pk, size_t pklen, const uint8_t *sk, size_t sklen) {
  EXACT(k, klen, crypto_box_BEFORENMBYTES);
  EXACT(pk, pklen, crypto_box_PUBLICKEYBYTES);
  EXACT(sk, sklen, crypto_box_SECRETKEYBYTES);
  /* -1 when the X25519 output is all-zero (low-order public key): fail closed. */
  return crypto_box_beforenm(k, pk, sk) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_secretbox_easy(uint8_t *c, size_t clen, const uint8_t *m, size_t mlen, const uint8_t *n, size_t nlen,
                         const uint8_t *k, size_t klen) {
  if (mlen > SIZE_MAX - crypto_secretbox_MACBYTES || clen != mlen + crypto_secretbox_MACBYTES || c == NULL)
    return AEGIS_EBADLEN;
  NEED(m, mlen);
  EXACT(n, nlen, crypto_secretbox_NONCEBYTES);
  EXACT(k, klen, crypto_secretbox_KEYBYTES);
  return crypto_secretbox_easy(c, m, mlen, n, k) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_secretbox_open_easy(uint8_t *m, size_t mlen, const uint8_t *c, size_t clen, const uint8_t *n,
                              size_t nlen, const uint8_t *k, size_t klen) {
  uint8_t empty[1];
  if (clen < crypto_secretbox_MACBYTES || mlen != clen - crypto_secretbox_MACBYTES || c == NULL)
    return AEGIS_EBADLEN;
  NEED(m, mlen);
  EXACT(n, nlen, crypto_secretbox_NONCEBYTES);
  EXACT(k, klen, crypto_secretbox_KEYBYTES);
  return crypto_secretbox_open_easy(m != NULL ? m : empty, c, clen, n, k) == 0 ? AEGIS_OK : AEGIS_EVERIFY;
}

int aegis_scalarmult(uint8_t *q, size_t qlen, const uint8_t *n, size_t nlen, const uint8_t *p, size_t plen) {
  EXACT(q, qlen, crypto_scalarmult_BYTES);
  EXACT(n, nlen, crypto_scalarmult_SCALARBYTES);
  EXACT(p, plen, crypto_scalarmult_BYTES);
  /* -1 when the result is the all-zero point (low-order input): fail closed. */
  return crypto_scalarmult(q, n, p) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_scalarmult_base(uint8_t *q, size_t qlen, const uint8_t *n, size_t nlen) {
  EXACT(q, qlen, crypto_scalarmult_BYTES);
  EXACT(n, nlen, crypto_scalarmult_SCALARBYTES);
  return crypto_scalarmult_base(q, n) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_sign_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen) {
  EXACT(pk, pklen, crypto_sign_PUBLICKEYBYTES);
  EXACT(sk, sklen, crypto_sign_SECRETKEYBYTES);
  return crypto_sign_keypair(pk, sk) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_sign_seed_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen, const uint8_t *seed,
                            size_t seedlen) {
  EXACT(pk, pklen, crypto_sign_PUBLICKEYBYTES);
  EXACT(sk, sklen, crypto_sign_SECRETKEYBYTES);
  EXACT(seed, seedlen, crypto_sign_SEEDBYTES);
  return crypto_sign_seed_keypair(pk, sk, seed) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_sign_detached(uint8_t *sig, size_t siglen, const uint8_t *m, size_t mlen, const uint8_t *sk,
                        size_t sklen) {
  EXACT(sig, siglen, crypto_sign_BYTES);
  NEED(m, mlen);
  EXACT(sk, sklen, crypto_sign_SECRETKEYBYTES);
  return crypto_sign_detached(sig, NULL, m, mlen, sk) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_sign_verify_detached(const uint8_t *sig, size_t siglen, const uint8_t *m, size_t mlen,
                               const uint8_t *pk, size_t pklen) {
  EXACT(sig, siglen, crypto_sign_BYTES);
  NEED(m, mlen);
  EXACT(pk, pklen, crypto_sign_PUBLICKEYBYTES);
  return crypto_sign_verify_detached(sig, m, mlen, pk) == 0 ? AEGIS_OK : AEGIS_EVERIFY;
}

int aegis_hmacsha256(uint8_t *out, size_t outlen, const uint8_t *m, size_t mlen, const uint8_t *k, size_t klen) {
  crypto_auth_hmacsha256_state st;
  int rc;
  EXACT(out, outlen, crypto_auth_hmacsha256_BYTES);
  NEED(m, mlen);
  NEED(k, klen);
  rc = (crypto_auth_hmacsha256_init(&st, k, klen) == 0 && crypto_auth_hmacsha256_update(&st, m, mlen) == 0 &&
        crypto_auth_hmacsha256_final(&st, out) == 0)
           ? AEGIS_OK
           : AEGIS_EFAIL;
  sodium_memzero(&st, sizeof st);
  return rc;
}

int aegis_hkdf_sha256(uint8_t *out, size_t outlen, const uint8_t *ikm, size_t ikmlen, const uint8_t *salt,
                      size_t saltlen, const uint8_t *info, size_t infolen) {
  uint8_t prk[crypto_kdf_hkdf_sha256_KEYBYTES];
  int rc;
  if (outlen == 0 || outlen > crypto_kdf_hkdf_sha256_BYTES_MAX || out == NULL) return AEGIS_EBADLEN;
  NEED(ikm, ikmlen);
  NEED(salt, saltlen);
  NEED(info, infolen);
  /* HMAC zero-pads the key, so an empty salt equals HashLen zero bytes (RFC 5869 §2.2). */
  rc = crypto_kdf_hkdf_sha256_extract(prk, salt, saltlen, ikm, ikmlen) == 0 &&
               crypto_kdf_hkdf_sha256_expand(out, outlen, (const char *) info, infolen, prk) == 0
           ? AEGIS_OK
           : AEGIS_EFAIL;
  sodium_memzero(prk, sizeof prk);
  return rc;
}

int aegis_argon2id(uint8_t *out, size_t outlen, const uint8_t *pwd, size_t pwdlen, const uint8_t *salt,
                   size_t saltlen, uint32_t t_cost, uint32_t m_kib) {
  int rc;
  if (outlen < AEGIS_ARGON2_OUT_MIN || outlen > AEGIS_ARGON2_OUT_MAX || out == NULL) return AEGIS_EBADLEN;
  if (saltlen < AEGIS_ARGON2_SALT_MIN || saltlen > AEGIS_ARGON2_SALT_MAX || salt == NULL) return AEGIS_EBADLEN;
  if (pwdlen > AEGIS_ARGON2_PWD_MAX) return AEGIS_EBADLEN;
  NEED(pwd, pwdlen);
  /* Cost bounds: the callers' parameters are constants, but a stray value must
   * not turn into a multi-GiB allocation or a minutes-long stall. */
  if (t_cost < 1 || t_cost > AEGIS_ARGON2_T_MAX || m_kib < AEGIS_ARGON2_M_MIN_KIB || m_kib > AEGIS_ARGON2_M_MAX_KIB)
    return AEGIS_EBADLEN;
  rc = argon2id_hash_raw(t_cost, m_kib, 1, pwd, pwdlen, salt, saltlen, out, outlen);
  if (rc != ARGON2_OK) {
    /* argon2_hash leaves random bytes in `out` on failure: never hand them back. */
    sodium_memzero(out, outlen);
    return AEGIS_EFAIL;
  }
  return AEGIS_OK;
}

static int has_leading_zero_bits(const uint8_t *d, uint32_t bits) {
  uint32_t full = bits / 8, rem = bits % 8, i;
  for (i = 0; i < full; i++)
    if (d[i] != 0) return 0;
  return rem == 0 || (d[full] & (uint8_t) (0xFF << (8 - rem))) == 0;
}

int aegis_pow_sha256(uint8_t *nonce, size_t noncelen, const uint8_t *challenge, size_t challen, uint32_t difficulty) {
  static const char hexdigits[] = "0123456789abcdef";
  uint8_t buf[AEGIS_POW_NONCE_LEN + AEGIS_POW_CHALLENGE_MAX];
  uint8_t digest[crypto_hash_sha256_BYTES];
  uint64_t i;
  if (noncelen != AEGIS_POW_NONCE_LEN || nonce == NULL) return AEGIS_EBADLEN;
  if (challen == 0 || challen > AEGIS_POW_CHALLENGE_MAX || challenge == NULL) return AEGIS_EBADLEN;
  if (difficulty > AEGIS_POW_DIFFICULTY_MAX) return AEGIS_EBADLEN;
  memcpy(buf + AEGIS_POW_NONCE_LEN, challenge, challen);
  for (i = 0; i <= 0xFFFFFFFFu; i++) {
    uint32_t v = (uint32_t) i;
    int k;
    for (k = AEGIS_POW_NONCE_LEN - 1; k >= 0; k--) {
      buf[k] = (uint8_t) hexdigits[v & 0xF];
      v >>= 4;
    }
    crypto_hash_sha256(digest, buf, AEGIS_POW_NONCE_LEN + challen);
    if (has_leading_zero_bits(digest, difficulty)) {
      memcpy(nonce, buf, AEGIS_POW_NONCE_LEN);
      return AEGIS_OK;
    }
  }
  return AEGIS_EFAIL;
}

/* dk = dk_PKE (384 * k bytes, k = 3) || ek || H(ek) || z  (FIPS 203 Algorithm 16). */
#define MLKEM768_DK_PKE 1152

int aegis_mlkem768_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen) {
  if (pklen != AEGIS_MLKEM768_PK || sklen != AEGIS_MLKEM768_SK || pk == NULL || sk == NULL) return AEGIS_EBADLEN;
  return crypto_kem_mlkem768_keypair(pk, sk) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_mlkem768_seed_keypair(uint8_t *pk, size_t pklen, uint8_t *sk, size_t sklen, const uint8_t *seed,
                                size_t seedlen) {
  if (pklen != AEGIS_MLKEM768_PK || sklen != AEGIS_MLKEM768_SK || pk == NULL || sk == NULL) return AEGIS_EBADLEN;
  if (seedlen != AEGIS_MLKEM768_SEED || seed == NULL) return AEGIS_EBADLEN;
  return crypto_kem_mlkem768_seed_keypair(pk, sk, seed) == 0 ? AEGIS_OK : AEGIS_EFAIL;
}

int aegis_mlkem768_enc(uint8_t *ct, size_t ctlen, uint8_t *ss, size_t sslen, const uint8_t *pk, size_t pklen) {
  if (ctlen != AEGIS_MLKEM768_CT || sslen != AEGIS_MLKEM768_SS || ct == NULL || ss == NULL) return AEGIS_EBADLEN;
  if (pklen != AEGIS_MLKEM768_PK || pk == NULL) return AEGIS_EBADLEN;
  if (crypto_kem_mlkem768_enc(ct, ss, pk) != 0) {
    sodium_memzero(ss, sslen);
    return AEGIS_EFAIL;
  }
  return AEGIS_OK;
}

int aegis_mlkem768_dec(uint8_t *ss, size_t sslen, const uint8_t *ct, size_t ctlen, const uint8_t *sk, size_t sklen) {
  if (sslen != AEGIS_MLKEM768_SS || ss == NULL) return AEGIS_EBADLEN;
  if (ctlen != AEGIS_MLKEM768_CT || ct == NULL || sklen != AEGIS_MLKEM768_SK || sk == NULL) return AEGIS_EBADLEN;
  /* FIPS 203 decapsulation-key check (as @noble does): the dk embeds ek and
   * H(ek) = SHA3-256(ek); a corrupted key fails here instead of yielding a
   * wrong secret. The hash of a public key needs no constant time, but
   * sodium_memcmp costs nothing. */
  {
    uint8_t h[32];
    const uint8_t *ek = sk + MLKEM768_DK_PKE;
    if (crypto_hash_sha3256(h, ek, AEGIS_MLKEM768_PK) != 0 || sodium_memcmp(h, ek + AEGIS_MLKEM768_PK, sizeof h) != 0) {
      sodium_memzero(ss, sslen);
      return AEGIS_EFAIL;
    }
  }
  if (crypto_kem_mlkem768_dec(ss, ct, sk) != 0) {
    sodium_memzero(ss, sslen);
    return AEGIS_EFAIL;
  }
  return AEGIS_OK;
}
