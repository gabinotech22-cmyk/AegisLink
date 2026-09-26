/*
 * JNI glue: Kotlin passes each JS Uint8Array as a direct ByteBuffer over the
 * array's own memory (expo-modules-core `toDirectBuffer()`, byteOffset already
 * applied), or null when it is empty. This file only turns buffers into
 * (pointer, length) pairs; aegis_sodium.c validates every length.
 */
#include <jni.h>
#include <stddef.h>
#include <stdint.h>

#include "aegis_sodium.h"

typedef struct {
  uint8_t *p;
  size_t len;
} span_t;

/* 0 on success; -1 if `b` is not a direct buffer. */
static int span(JNIEnv *env, jobject b, span_t *out) {
  void *addr;
  jlong cap;
  out->p = NULL;
  out->len = 0;
  if (b == NULL) return 0;
  addr = (*env)->GetDirectBufferAddress(env, b);
  cap = (*env)->GetDirectBufferCapacity(env, b);
  if (cap < 0 || (addr == NULL && cap != 0)) return -1;
  out->p = (uint8_t *) addr;
  out->len = (size_t) cap;
  return 0;
}

#define FN(name) JNIEXPORT jint JNICALL Java_expo_modules_aegissodium_AegisSodiumNative_##name
#define S(i) s[i].p, s[i].len
#define SPANS(n, ...)                                                                                                \
  span_t s[n];                                                                                                       \
  jobject in[n] = {__VA_ARGS__};                                                                                     \
  for (int i = 0; i < (n); i++)                                                                                      \
    if (span(env, in[i], &s[i]) != 0) return AEGIS_EBADLEN;

FN(nativeInit)(JNIEnv *env, jclass cls) {
  (void) env;
  (void) cls;
  return aegis_init();
}

FN(randombytes)(JNIEnv *env, jclass cls, jobject buf) {
  (void) cls;
  SPANS(1, buf)
  return aegis_randombytes(S(0));
}

FN(memcmp)(JNIEnv *env, jclass cls, jobject a, jobject b) {
  (void) cls;
  SPANS(2, a, b)
  return aegis_memcmp(S(0), S(1));
}

FN(boxKeypair)(JNIEnv *env, jclass cls, jobject pk, jobject sk) {
  (void) cls;
  SPANS(2, pk, sk)
  return aegis_box_keypair(S(0), S(1));
}

FN(boxEasy)(JNIEnv *env, jclass cls, jobject c, jobject m, jobject n, jobject pk, jobject sk) {
  (void) cls;
  SPANS(5, c, m, n, pk, sk)
  return aegis_box_easy(S(0), S(1), S(2), S(3), S(4));
}

FN(boxOpenEasy)(JNIEnv *env, jclass cls, jobject m, jobject c, jobject n, jobject pk, jobject sk) {
  (void) cls;
  SPANS(5, m, c, n, pk, sk)
  return aegis_box_open_easy(S(0), S(1), S(2), S(3), S(4));
}

FN(boxBeforenm)(JNIEnv *env, jclass cls, jobject k, jobject pk, jobject sk) {
  (void) cls;
  SPANS(3, k, pk, sk)
  return aegis_box_beforenm(S(0), S(1), S(2));
}

FN(secretboxEasy)(JNIEnv *env, jclass cls, jobject c, jobject m, jobject n, jobject k) {
  (void) cls;
  SPANS(4, c, m, n, k)
  return aegis_secretbox_easy(S(0), S(1), S(2), S(3));
}

FN(secretboxOpenEasy)(JNIEnv *env, jclass cls, jobject m, jobject c, jobject n, jobject k) {
  (void) cls;
  SPANS(4, m, c, n, k)
  return aegis_secretbox_open_easy(S(0), S(1), S(2), S(3));
}

FN(scalarmult)(JNIEnv *env, jclass cls, jobject q, jobject n, jobject p) {
  (void) cls;
  SPANS(3, q, n, p)
  return aegis_scalarmult(S(0), S(1), S(2));
}

FN(scalarmultBase)(JNIEnv *env, jclass cls, jobject q, jobject n) {
  (void) cls;
  SPANS(2, q, n)
  return aegis_scalarmult_base(S(0), S(1));
}

FN(signKeypair)(JNIEnv *env, jclass cls, jobject pk, jobject sk) {
  (void) cls;
  SPANS(2, pk, sk)
  return aegis_sign_keypair(S(0), S(1));
}

FN(signSeedKeypair)(JNIEnv *env, jclass cls, jobject pk, jobject sk, jobject seed) {
  (void) cls;
  SPANS(3, pk, sk, seed)
  return aegis_sign_seed_keypair(S(0), S(1), S(2));
}

FN(signDetached)(JNIEnv *env, jclass cls, jobject sig, jobject m, jobject sk) {
  (void) cls;
  SPANS(3, sig, m, sk)
  return aegis_sign_detached(S(0), S(1), S(2));
}

FN(signVerifyDetached)(JNIEnv *env, jclass cls, jobject sig, jobject m, jobject pk) {
  (void) cls;
  SPANS(3, sig, m, pk)
  return aegis_sign_verify_detached(S(0), S(1), S(2));
}

FN(hmacsha256)(JNIEnv *env, jclass cls, jobject out, jobject m, jobject k) {
  (void) cls;
  SPANS(3, out, m, k)
  return aegis_hmacsha256(S(0), S(1), S(2));
}

FN(hkdfSha256)(JNIEnv *env, jclass cls, jobject out, jobject ikm, jobject salt, jobject info) {
  (void) cls;
  SPANS(4, out, ikm, salt, info)
  return aegis_hkdf_sha256(S(0), S(1), S(2), S(3));
}

/* Called from a background thread (Kotlin AsyncFunction) with direct buffers
 * Kotlin allocated and owns — not views of JS memory. */
FN(argon2id)(JNIEnv *env, jclass cls, jobject out, jobject pwd, jobject salt, jint t, jint m) {
  (void) cls;
  SPANS(3, out, pwd, salt)
  if (t < 0 || m < 0) return AEGIS_EBADLEN;
  return aegis_argon2id(S(0), S(1), S(2), (uint32_t) t, (uint32_t) m);
}

FN(powSha256)(JNIEnv *env, jclass cls, jobject nonce, jobject challenge, jint difficulty) {
  (void) cls;
  SPANS(2, nonce, challenge)
  if (difficulty < 0) return AEGIS_EBADLEN;
  return aegis_pow_sha256(S(0), S(1), (uint32_t) difficulty);
}

FN(mlkem768Keypair)(JNIEnv *env, jclass cls, jobject pk, jobject sk) {
  (void) cls;
  SPANS(2, pk, sk)
  return aegis_mlkem768_keypair(S(0), S(1));
}

FN(mlkem768SeedKeypair)(JNIEnv *env, jclass cls, jobject pk, jobject sk, jobject seed) {
  (void) cls;
  SPANS(3, pk, sk, seed)
  return aegis_mlkem768_seed_keypair(S(0), S(1), S(2));
}

FN(mlkem768Enc)(JNIEnv *env, jclass cls, jobject ct, jobject ss, jobject pk) {
  (void) cls;
  SPANS(3, ct, ss, pk)
  return aegis_mlkem768_enc(S(0), S(1), S(2));
}

FN(mlkem768Dec)(JNIEnv *env, jclass cls, jobject ss, jobject ct, jobject sk) {
  (void) cls;
  SPANS(3, ss, ct, sk)
  return aegis_mlkem768_dec(S(0), S(1), S(2));
}

FN(pbkdf2Sha256)(JNIEnv *env, jclass cls, jobject out, jobject pwd, jobject salt, jint iterations) {
  (void) cls;
  SPANS(3, out, pwd, salt)
  if (iterations < 0) return AEGIS_EBADLEN;
  return aegis_pbkdf2_sha256(S(0), S(1), S(2), (uint32_t) iterations);
}
