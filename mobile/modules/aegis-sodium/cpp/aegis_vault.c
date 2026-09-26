/* aegis_vault — see aegis_vault.h and docs/F1B-KEY-VAULT-DESIGN.md. */
#include "aegis_vault.h"

#include <pthread.h>
#include <sodium.h>
#include <string.h>

#include "aegis_sodium.h"

#define MLKEM_EK_OFFSET 1152
#define MLKEM_PK_LEN 1184
#define HANDLE_INDEX_BITS 14 /* index + 1 fits: AEGIS_VAULT_MAX_KEYS = 8192 */

typedef struct {
  int used;
  size_t slotlen;
  uint8_t slot[AEGIS_VAULT_SLOT_MAX];
  uint8_t *kek; /* guarded, no access outside a wrap/unwrap */
} vault_slot;

typedef struct {
  int used;
  int type;
  int slot; /* index into slots[] */
  uint32_t gen;
  uint8_t *secret; /* guarded, no access outside an operation */
} vault_key;

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static vault_slot slots[AEGIS_VAULT_MAX_SLOTS];
static vault_key keys[AEGIS_VAULT_MAX_KEYS];
static uint32_t next_gen = 1;

size_t aegis_vault_key_len(int type) {
  switch (type) {
    case AEGIS_KEY_X25519:
      return crypto_scalarmult_SCALARBYTES;
    case AEGIS_KEY_ED25519:
      return crypto_sign_SECRETKEYBYTES;
    case AEGIS_KEY_MLKEM768:
      return crypto_kem_mlkem768_SECRETKEYBYTES;
    case AEGIS_KEY_SECRET32:
      return 32;
    default:
      return 0;
  }
}

size_t aegis_vault_pub_len(int type) {
  switch (type) {
    case AEGIS_KEY_X25519:
      return crypto_scalarmult_BYTES;
    case AEGIS_KEY_ED25519:
      return crypto_sign_PUBLICKEYBYTES;
    case AEGIS_KEY_MLKEM768:
      return MLKEM_PK_LEN;
    default:
      return 0;
  }
}

/* ── slots ─────────────────────────────────────────────────────────────── */

static int find_slot(const uint8_t *slot, size_t slotlen) {
  int i;
  for (i = 0; i < AEGIS_VAULT_MAX_SLOTS; i++) {
    if (slots[i].used && slots[i].slotlen == slotlen && memcmp(slots[i].slot, slot, slotlen) == 0) return i;
  }
  return -1;
}

static int slot_args_ok(const uint8_t *slot, size_t slotlen) {
  return slot != NULL && slotlen >= 1 && slotlen <= AEGIS_VAULT_SLOT_MAX;
}

int aegis_vault_unlock(const uint8_t *slot, size_t slotlen, const uint8_t *kek, size_t keklen) {
  int i, rc = AEGIS_OK;
  if (!slot_args_ok(slot, slotlen) || kek == NULL || keklen != AEGIS_VAULT_KEK_LEN) return AEGIS_EBADLEN;
  pthread_mutex_lock(&mu);
  i = find_slot(slot, slotlen);
  if (i >= 0) {
    /* Same KEK: idempotent. A different one means a caller mixed profiles up. */
    sodium_mprotect_readonly(slots[i].kek);
    rc = sodium_memcmp(slots[i].kek, kek, AEGIS_VAULT_KEK_LEN) == 0 ? AEGIS_OK : AEGIS_EFAIL;
    sodium_mprotect_noaccess(slots[i].kek);
    pthread_mutex_unlock(&mu);
    return rc;
  }
  for (i = 0; i < AEGIS_VAULT_MAX_SLOTS && slots[i].used; i++) {
  }
  if (i == AEGIS_VAULT_MAX_SLOTS) {
    pthread_mutex_unlock(&mu);
    return AEGIS_EFAIL;
  }
  slots[i].kek = sodium_malloc(AEGIS_VAULT_KEK_LEN);
  if (slots[i].kek == NULL) {
    pthread_mutex_unlock(&mu);
    return AEGIS_EFAIL;
  }
  memcpy(slots[i].kek, kek, AEGIS_VAULT_KEK_LEN);
  sodium_mprotect_noaccess(slots[i].kek);
  memcpy(slots[i].slot, slot, slotlen);
  slots[i].slotlen = slotlen;
  slots[i].used = 1;
  pthread_mutex_unlock(&mu);
  return AEGIS_OK;
}

static void free_key(int k) {
  sodium_free(keys[k].secret); /* zeroes before unmapping */
  memset(&keys[k], 0, sizeof keys[k]);
}

static void lock_slot_index(int i) {
  int k;
  for (k = 0; k < AEGIS_VAULT_MAX_KEYS; k++) {
    if (keys[k].used && keys[k].slot == i) free_key(k);
  }
  sodium_free(slots[i].kek);
  memset(&slots[i], 0, sizeof slots[i]);
}

int aegis_vault_lock(const uint8_t *slot, size_t slotlen) {
  int i;
  if (!slot_args_ok(slot, slotlen)) return AEGIS_EBADLEN;
  pthread_mutex_lock(&mu);
  i = find_slot(slot, slotlen);
  if (i >= 0) lock_slot_index(i);
  pthread_mutex_unlock(&mu);
  return AEGIS_OK;
}

int aegis_vault_lock_all(void) {
  int i;
  pthread_mutex_lock(&mu);
  for (i = 0; i < AEGIS_VAULT_MAX_SLOTS; i++) {
    if (slots[i].used) lock_slot_index(i);
  }
  pthread_mutex_unlock(&mu);
  return AEGIS_OK;
}

/* ── keys ──────────────────────────────────────────────────────────────── */

static uint32_t make_handle(int k) {
  return (keys[k].gen << HANDLE_INDEX_BITS) | (uint32_t) (k + 1);
}

/* Index of a live key for `handle`, or -1. Caller holds the mutex. */
static int key_index(uint32_t handle) {
  uint32_t idx = handle & ((1u << HANDLE_INDEX_BITS) - 1);
  int k;
  if (idx == 0 || idx > AEGIS_VAULT_MAX_KEYS) return -1;
  k = (int) idx - 1;
  if (!keys[k].used || keys[k].gen != (handle >> HANDLE_INDEX_BITS)) return -1;
  return k;
}

/* Store `len` secret bytes as a new key; returns its index or -1. Caller holds the mutex. */
static int store_key(int slot, int type, const uint8_t *secret, size_t len) {
  int k;
  for (k = 0; k < AEGIS_VAULT_MAX_KEYS && keys[k].used; k++) {
  }
  if (k == AEGIS_VAULT_MAX_KEYS) return -1;
  keys[k].secret = sodium_malloc(len);
  if (keys[k].secret == NULL) return -1;
  memcpy(keys[k].secret, secret, len);
  sodium_mprotect_noaccess(keys[k].secret);
  keys[k].used = 1;
  keys[k].type = type;
  keys[k].slot = slot;
  keys[k].gen = next_gen;
  next_gen = (next_gen + 1) & ((1u << (32 - HANDLE_INDEX_BITS)) - 1);
  if (next_gen == 0) next_gen = 1;
  return k;
}

/* Public key of a secret of `type` (secret readable). */
static int public_of(int type, const uint8_t *secret, uint8_t *pub, size_t publen) {
  size_t want = aegis_vault_pub_len(type);
  if (publen == 0 && pub == NULL) return AEGIS_OK; /* caller does not want it */
  if (publen != want || pub == NULL) return AEGIS_EBADLEN;
  switch (type) {
    case AEGIS_KEY_X25519:
      return crypto_scalarmult_base(pub, secret) == 0 ? AEGIS_OK : AEGIS_EFAIL;
    case AEGIS_KEY_ED25519:
      memcpy(pub, secret + crypto_sign_SEEDBYTES, crypto_sign_PUBLICKEYBYTES);
      return AEGIS_OK;
    case AEGIS_KEY_MLKEM768:
      memcpy(pub, secret + MLKEM_EK_OFFSET, MLKEM_PK_LEN);
      return AEGIS_OK;
    default:
      return AEGIS_EBADLEN;
  }
}

/* blob = "AV" | 1 | type | nonce | secretbox(slotlen | slot | secret). Slot and KEK readable by caller. */
static int wrap(uint8_t *blob, size_t bloblen, int slot, int type, const uint8_t *secret, size_t len) {
  size_t slotlen = slots[slot].slotlen, plen = 1 + slotlen + len;
  uint8_t *plain;
  int rc;
  if (bloblen != AEGIS_VAULT_BLOB_LEN(slotlen, len) || blob == NULL) return AEGIS_EBADLEN;
  plain = sodium_malloc(plen);
  if (plain == NULL) return AEGIS_EFAIL;
  plain[0] = (uint8_t) slotlen;
  memcpy(plain + 1, slots[slot].slot, slotlen);
  memcpy(plain + 1 + slotlen, secret, len);
  blob[0] = 'A';
  blob[1] = 'V';
  blob[2] = 1;
  blob[3] = (uint8_t) type;
  randombytes_buf(blob + 4, crypto_secretbox_NONCEBYTES);
  sodium_mprotect_readonly(slots[slot].kek);
  rc = crypto_secretbox_easy(blob + AEGIS_VAULT_BLOB_HEADER, plain, plen, blob + 4, slots[slot].kek) == 0
           ? AEGIS_OK
           : AEGIS_EFAIL;
  sodium_mprotect_noaccess(slots[slot].kek);
  sodium_free(plain);
  return rc;
}

/* Store + wrap + public key for a fresh secret; releases on any failure. Caller holds the mutex. */
static int add_key(uint32_t *handle, uint8_t *blob, size_t bloblen, uint8_t *pub, size_t publen, int slot,
                   int type, const uint8_t *secret) {
  size_t len = aegis_vault_key_len(type);
  int rc, k;
  rc = public_of(type, secret, pub, publen);
  if (rc != AEGIS_OK) return rc;
  rc = wrap(blob, bloblen, slot, type, secret, len);
  if (rc != AEGIS_OK) return rc;
  k = store_key(slot, type, secret, len);
  if (k < 0) {
    sodium_memzero(blob, bloblen);
    return AEGIS_EFAIL;
  }
  *handle = make_handle(k);
  return AEGIS_OK;
}

static int random_secret(int type, uint8_t *secret) {
  uint8_t pk[crypto_kem_mlkem768_PUBLICKEYBYTES];
  uint8_t sign_pk[crypto_sign_PUBLICKEYBYTES];
  switch (type) {
    case AEGIS_KEY_X25519:
    case AEGIS_KEY_SECRET32:
      randombytes_buf(secret, 32);
      return AEGIS_OK;
    case AEGIS_KEY_ED25519:
      return crypto_sign_keypair(sign_pk, secret) == 0 ? AEGIS_OK : AEGIS_EFAIL;
    case AEGIS_KEY_MLKEM768:
      return crypto_kem_mlkem768_keypair(pk, secret) == 0 ? AEGIS_OK : AEGIS_EFAIL;
    default:
      return AEGIS_EBADLEN;
  }
}

int aegis_vault_generate(uint32_t *handle, uint8_t *blob, size_t bloblen, uint8_t *pub, size_t publen,
                         const uint8_t *slot, size_t slotlen, int type) {
  size_t len = aegis_vault_key_len(type);
  uint8_t *secret;
  int s, rc;
  if (handle == NULL || len == 0 || !slot_args_ok(slot, slotlen)) return AEGIS_EBADLEN;
  secret = sodium_malloc(len);
  if (secret == NULL) return AEGIS_EFAIL;
  pthread_mutex_lock(&mu);
  s = find_slot(slot, slotlen);
  rc = s < 0 ? AEGIS_ENOKEY : random_secret(type, secret);
  if (rc == AEGIS_OK) rc = add_key(handle, blob, bloblen, pub, publen, s, type, secret);
  pthread_mutex_unlock(&mu);
  sodium_free(secret);
  return rc;
}

/* A raw key is well formed for its type (Ed25519: pub half matches the seed; ML-KEM: FIPS 203 H(ek) check). */
static int raw_ok(int type, const uint8_t *raw) {
  uint8_t pk[crypto_sign_PUBLICKEYBYTES], sk[crypto_sign_SECRETKEYBYTES], h[32];
  int ok;
  switch (type) {
    case AEGIS_KEY_ED25519:
      ok = crypto_sign_seed_keypair(pk, sk, raw) == 0 && sodium_memcmp(pk, raw + 32, 32) == 0;
      sodium_memzero(sk, sizeof sk);
      return ok;
    case AEGIS_KEY_MLKEM768:
      return crypto_hash_sha3256(h, raw + MLKEM_EK_OFFSET, MLKEM_PK_LEN) == 0 &&
             sodium_memcmp(h, raw + MLKEM_EK_OFFSET + MLKEM_PK_LEN, 32) == 0;
    default:
      return 1;
  }
}

int aegis_vault_import(uint32_t *handle, uint8_t *blob, size_t bloblen, uint8_t *pub, size_t publen,
                       const uint8_t *slot, size_t slotlen, int type, const uint8_t *raw, size_t rawlen) {
  size_t len = aegis_vault_key_len(type);
  int s, rc;
  if (handle == NULL || len == 0 || rawlen != len || raw == NULL || !slot_args_ok(slot, slotlen))
    return AEGIS_EBADLEN;
  if (!raw_ok(type, raw)) return AEGIS_EFAIL;
  pthread_mutex_lock(&mu);
  s = find_slot(slot, slotlen);
  rc = s < 0 ? AEGIS_ENOKEY : add_key(handle, blob, bloblen, pub, publen, s, type, raw);
  pthread_mutex_unlock(&mu);
  return rc;
}

int aegis_vault_load(uint32_t *handle, int *type, uint8_t *pub, size_t publen, const uint8_t *slot,
                     size_t slotlen, const uint8_t *blob, size_t bloblen) {
  uint8_t *plain;
  size_t plen, len;
  int s, t, k, rc;
  if (handle == NULL || type == NULL || blob == NULL || !slot_args_ok(slot, slotlen)) return AEGIS_EBADLEN;
  if (bloblen < AEGIS_VAULT_BLOB_HEADER + crypto_secretbox_MACBYTES + 1 || blob[0] != 'A' || blob[1] != 'V' ||
      blob[2] != 1)
    return AEGIS_EBADLEN;
  t = blob[3];
  len = aegis_vault_key_len(t);
  if (len == 0 || bloblen != AEGIS_VAULT_BLOB_LEN(slotlen, len)) return AEGIS_EBADLEN;
  plen = 1 + slotlen + len;
  plain = sodium_malloc(plen);
  if (plain == NULL) return AEGIS_EFAIL;
  pthread_mutex_lock(&mu);
  s = find_slot(slot, slotlen);
  if (s < 0) {
    rc = AEGIS_ENOKEY;
  } else {
    sodium_mprotect_readonly(slots[s].kek);
    rc = crypto_secretbox_open_easy(plain, blob + AEGIS_VAULT_BLOB_HEADER, bloblen - AEGIS_VAULT_BLOB_HEADER,
                                    blob + 4, slots[s].kek) == 0
             ? AEGIS_OK
             : AEGIS_EVERIFY;
    sodium_mprotect_noaccess(slots[s].kek);
    /* The slot inside the box must be this one: a blob of another profile never loads here. */
    if (rc == AEGIS_OK && (plain[0] != slotlen || sodium_memcmp(plain + 1, slot, slotlen) != 0)) rc = AEGIS_EVERIFY;
    if (rc == AEGIS_OK) rc = public_of(t, plain + 1 + slotlen, pub, publen);
    if (rc == AEGIS_OK) {
      k = store_key(s, t, plain + 1 + slotlen, len);
      if (k < 0) {
        rc = AEGIS_EFAIL;
      } else {
        *handle = make_handle(k);
        *type = t;
      }
    }
  }
  pthread_mutex_unlock(&mu);
  sodium_free(plain);
  return rc;
}

int aegis_vault_derive_ed25519(uint32_t *handle, uint8_t *blob, size_t bloblen, uint8_t *pub, size_t publen,
                               uint32_t x_handle) {
  uint8_t pk[crypto_sign_PUBLICKEYBYTES];
  uint8_t *sk;
  int k, rc;
  if (handle == NULL) return AEGIS_EBADLEN;
  sk = sodium_malloc(crypto_sign_SECRETKEYBYTES);
  if (sk == NULL) return AEGIS_EFAIL;
  pthread_mutex_lock(&mu);
  k = key_index(x_handle);
  if (k < 0 || keys[k].type != AEGIS_KEY_X25519) {
    rc = AEGIS_ENOKEY;
  } else {
    sodium_mprotect_readonly(keys[k].secret);
    rc = crypto_sign_seed_keypair(pk, sk, keys[k].secret) == 0 ? AEGIS_OK : AEGIS_EFAIL;
    sodium_mprotect_noaccess(keys[k].secret);
    if (rc == AEGIS_OK) rc = add_key(handle, blob, bloblen, pub, publen, keys[k].slot, AEGIS_KEY_ED25519, sk);
  }
  pthread_mutex_unlock(&mu);
  sodium_free(sk);
  return rc;
}

int aegis_vault_release(uint32_t handle) {
  int k;
  pthread_mutex_lock(&mu);
  k = key_index(handle);
  if (k >= 0) free_key(k);
  pthread_mutex_unlock(&mu);
  return k >= 0 ? AEGIS_OK : AEGIS_ENOKEY;
}

/* Run `op` with the key of `handle` readable; ENOKEY if the handle is dead or not of `type`. */
#define WITH_KEY(handle, want_type, body)                                                                            \
  do {                                                                                                               \
    int k_;                                                                                                          \
    pthread_mutex_lock(&mu);                                                                                         \
    k_ = key_index(handle);                                                                                          \
    if (k_ < 0 || keys[k_].type != (want_type)) {                                                                    \
      rc = AEGIS_ENOKEY;                                                                                             \
    } else {                                                                                                         \
      const uint8_t *key = keys[k_].secret;                                                                          \
      sodium_mprotect_readonly(keys[k_].secret);                                                                     \
      body;                                                                                                          \
      sodium_mprotect_noaccess(keys[k_].secret);                                                                     \
    }                                                                                                                \
    pthread_mutex_unlock(&mu);                                                                                       \
  } while (0)

int aegis_vault_sign(uint32_t handle, uint8_t *sig, size_t siglen, const uint8_t *m, size_t mlen) {
  int rc = AEGIS_OK;
  if (siglen != crypto_sign_BYTES || sig == NULL || (m == NULL && mlen != 0)) return AEGIS_EBADLEN;
  WITH_KEY(handle, AEGIS_KEY_ED25519, rc = aegis_sign_detached(sig, siglen, m, mlen, key, crypto_sign_SECRETKEYBYTES));
  return rc;
}

int aegis_vault_scalarmult(uint32_t handle, uint8_t *q, size_t qlen, const uint8_t *p, size_t plen) {
  int rc = AEGIS_OK;
  if (q == NULL || qlen != crypto_scalarmult_BYTES) return AEGIS_EBADLEN;
  WITH_KEY(handle, AEGIS_KEY_X25519, rc = aegis_scalarmult(q, qlen, key, crypto_scalarmult_SCALARBYTES, p, plen));
  return rc;
}

int aegis_vault_box(uint32_t handle, uint8_t *c, size_t clen, const uint8_t *m, size_t mlen, const uint8_t *n,
                    size_t nlen, const uint8_t *pk, size_t pklen) {
  int rc = AEGIS_OK;
  WITH_KEY(handle, AEGIS_KEY_X25519,
           rc = aegis_box_easy(c, clen, m, mlen, n, nlen, pk, pklen, key, crypto_box_SECRETKEYBYTES));
  return rc;
}

int aegis_vault_box_open(uint32_t handle, uint8_t *m, size_t mlen, const uint8_t *c, size_t clen,
                         const uint8_t *n, size_t nlen, const uint8_t *pk, size_t pklen) {
  int rc = AEGIS_OK;
  WITH_KEY(handle, AEGIS_KEY_X25519,
           rc = aegis_box_open_easy(m, mlen, c, clen, n, nlen, pk, pklen, key, crypto_box_SECRETKEYBYTES));
  return rc;
}

int aegis_vault_mlkem768_dec(uint32_t handle, uint8_t *ss, size_t sslen, const uint8_t *ct, size_t ctlen) {
  int rc = AEGIS_OK;
  WITH_KEY(handle, AEGIS_KEY_MLKEM768,
           rc = aegis_mlkem768_dec(ss, sslen, ct, ctlen, key, crypto_kem_mlkem768_SECRETKEYBYTES));
  return rc;
}

size_t aegis_vault_live_keys(void) {
  size_t n = 0;
  int k;
  pthread_mutex_lock(&mu);
  for (k = 0; k < AEGIS_VAULT_MAX_KEYS; k++) n += keys[k].used ? 1 : 0;
  pthread_mutex_unlock(&mu);
  return n;
}
