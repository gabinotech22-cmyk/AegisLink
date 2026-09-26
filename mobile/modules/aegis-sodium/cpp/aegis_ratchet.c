/*
 * aegis_ratchet — the Double Ratchet (classic, and hybrid X25519 + ML-KEM-768
 * "R1") inside the key vault (F-1b phase 3). See aegis_vault.h and
 * docs/F1B-KEY-VAULT-DESIGN.md.
 *
 * Port of the app's former JavaScript ratchet; its TypeScript twin
 * (jest/ratchetCore.ts) is the reference, and test/ratchet-interop.mjs checks
 * that this port and the twin talk to each other message for message.
 *
 * Every call opens the sealed state into guarded memory (sodium_malloc),
 * steps it, and seals a NEW state; on any error, or a message that does not
 * authenticate, nothing is written and the caller keeps its old state
 * (Signal Double Ratchet spec section 3.4). Secrets on the stack are wiped
 * with sodium_memzero; the working state is wiped by sodium_free.
 */
#include <sodium.h>
#include <string.h>

#include "aegis_sodium.h"
#include "aegis_vault.h"
#include "aegis_vault_internal.h"

#define PQ_PK crypto_kem_mlkem768_PUBLICKEYBYTES     /* 1184 */
#define PQ_SK crypto_kem_mlkem768_SECRETKEYBYTES     /* 2400 */
#define PQ_CT crypto_kem_mlkem768_CIPHERTEXTBYTES    /* 1088 */
#define PQ_SS crypto_kem_mlkem768_SHAREDSECRETBYTES  /* 32 */
#define MAXS AEGIS_RATCHET_MAX_SKIPPED
#define WORK_SKIPPED (2 * MAXS) /* one step adds at most MAXS before the cap applies */
#define NONCE crypto_secretbox_NONCEBYTES
#define MAC crypto_secretbox_MACBYTES

/* State layout v1 (ratchetState.ts). */
#define STATE_VERSION 1
#define O_NS 4
#define O_NR 8
#define O_PN 12
#define O_RK 16
#define O_DHS_PUB 48
#define O_DHS_SEC 80
#define O_DHR 112
#define O_CKS 144
#define O_CKR 176
#define O_PQS_PUB 208
#define O_PQS_SEC (O_PQS_PUB + PQ_PK)
#define O_PQR (O_PQS_SEC + PQ_SK)
#define O_PQCT (O_PQR + PQ_PK)
#define O_SKIPPED (O_PQCT + PQ_CT)
#define SKIPPED_ENTRY 68

#define F_DHR 1u
#define F_CKS 2u
#define F_CKR 4u
#define F_PQS 8u
#define F_PQR 16u
#define F_PQCT 32u
#define F_ALL 63u

/* Header layout: 0 flags (1 = PQ) | 1 n | 5 pn | 9 ratchetKey[32] | 41 pqPub | 41+PQ_PK pqCt. */
#define H_RK 9
#define H_PQPUB 41
#define H_PQCT (H_PQPUB + PQ_PK)

typedef struct {
  uint8_t pub[32];
  uint32_t n;
  uint8_t mk[32];
} skipped_t;

typedef struct {
  unsigned flags;
  uint32_t ns, nr, pn;
  uint8_t rk[32], dhs_pub[32], dhs_sec[32], dhr[32], cks[32], ckr[32];
  uint8_t pqs_pub[PQ_PK], pqs_sec[PQ_SK], pqr[PQ_PK], pqct[PQ_CT];
  size_t nskipped;
  skipped_t sk[WORK_SKIPPED]; /* insertion order: eviction ties break by it */
} rstate;

static const uint8_t ROOT_INFO[] = "AegisLinkRoot";
static const uint8_t ROOT_INFO_PQ[] = "AegisLinkRootPQ";

typedef char state_len_matches[(O_SKIPPED + MAXS * SKIPPED_ENTRY == AEGIS_RATCHET_STATE_LEN) ? 1 : -1];
typedef char header_len_matches[(H_PQCT + PQ_CT == AEGIS_RATCHET_HEADER_LEN) ? 1 : -1];

static void put32(uint8_t *p, uint32_t v) {
  p[0] = (uint8_t) v;
  p[1] = (uint8_t) (v >> 8);
  p[2] = (uint8_t) (v >> 16);
  p[3] = (uint8_t) (v >> 24);
}

static uint32_t get32(const uint8_t *p) {
  return (uint32_t) p[0] | ((uint32_t) p[1] << 8) | ((uint32_t) p[2] << 16) | ((uint32_t) p[3] << 24);
}

static rstate *st_new(void) {
  rstate *s = sodium_malloc(sizeof(rstate));
  if (s != NULL) memset(s, 0, sizeof(rstate)); /* sodium_malloc fills with garbage */
  return s;
}

static void st_free(rstate *s) {
  if (s != NULL) sodium_free(s); /* zeroes before unmapping */
}

/* ── state codec ─────────────────────────────────────────────────────────── */

static int decode(rstate *s, const uint8_t *b) {
  size_t i;
  if (b[0] != STATE_VERSION || (b[1] & ~F_ALL) != 0 || b[2] > MAXS || b[3] != 0) return AEGIS_ERATCHET_STATE;
  s->flags = b[1];
  s->ns = get32(b + O_NS);
  s->nr = get32(b + O_NR);
  s->pn = get32(b + O_PN);
  memcpy(s->rk, b + O_RK, 32);
  memcpy(s->dhs_pub, b + O_DHS_PUB, 32);
  memcpy(s->dhs_sec, b + O_DHS_SEC, 32);
  memcpy(s->dhr, b + O_DHR, 32);
  memcpy(s->cks, b + O_CKS, 32);
  memcpy(s->ckr, b + O_CKR, 32);
  memcpy(s->pqs_pub, b + O_PQS_PUB, PQ_PK);
  memcpy(s->pqs_sec, b + O_PQS_SEC, PQ_SK);
  memcpy(s->pqr, b + O_PQR, PQ_PK);
  memcpy(s->pqct, b + O_PQCT, PQ_CT);
  s->nskipped = b[2];
  for (i = 0; i < s->nskipped; i++) {
    const uint8_t *e = b + O_SKIPPED + i * SKIPPED_ENTRY;
    memcpy(s->sk[i].pub, e, 32);
    s->sk[i].n = get32(e + 32);
    memcpy(s->sk[i].mk, e + 36, 32);
  }
  return AEGIS_OK;
}

static void encode(uint8_t *b, const rstate *s) {
  size_t i;
  memset(b, 0, AEGIS_RATCHET_STATE_LEN);
  b[0] = STATE_VERSION;
  b[1] = (uint8_t) s->flags;
  b[2] = (uint8_t) s->nskipped;
  put32(b + O_NS, s->ns);
  put32(b + O_NR, s->nr);
  put32(b + O_PN, s->pn);
  memcpy(b + O_RK, s->rk, 32);
  memcpy(b + O_DHS_PUB, s->dhs_pub, 32);
  memcpy(b + O_DHS_SEC, s->dhs_sec, 32);
  if (s->flags & F_DHR) memcpy(b + O_DHR, s->dhr, 32);
  if (s->flags & F_CKS) memcpy(b + O_CKS, s->cks, 32);
  if (s->flags & F_CKR) memcpy(b + O_CKR, s->ckr, 32);
  if (s->flags & F_PQS) {
    memcpy(b + O_PQS_PUB, s->pqs_pub, PQ_PK);
    memcpy(b + O_PQS_SEC, s->pqs_sec, PQ_SK);
  }
  if (s->flags & F_PQR) memcpy(b + O_PQR, s->pqr, PQ_PK);
  if (s->flags & F_PQCT) memcpy(b + O_PQCT, s->pqct, PQ_CT);
  for (i = 0; i < s->nskipped; i++) {
    uint8_t *e = b + O_SKIPPED + i * SKIPPED_ENTRY;
    memcpy(e, s->sk[i].pub, 32);
    put32(e + 32, s->sk[i].n);
    memcpy(e + 36, s->sk[i].mk, 32);
  }
}

static void write_info(uint8_t *info, const rstate *s) {
  memset(info, 0, AEGIS_RATCHET_INFO_LEN);
  put32(info, s->ns);
  put32(info + 4, s->nr);
  put32(info + 8, s->pn);
  info[12] = (uint8_t) (((s->flags & F_PQS) ? 1 : 0) | ((s->flags & F_CKS) ? 2 : 0) | ((s->flags & F_CKR) ? 4 : 0) |
                        ((s->flags & F_DHR) ? 8 : 0));
  memcpy(info + 13, s->dhs_pub, 32);
  if (s->flags & F_DHR) memcpy(info + 45, s->dhr, 32);
}

static int out_args_ok(const uint8_t *blob, size_t bloblen, const uint8_t *info, size_t infolen, const uint8_t *slot,
                       size_t slotlen) {
  return slot != NULL && slotlen >= 1 && slotlen <= AEGIS_VAULT_SLOT_MAX && blob != NULL &&
         bloblen == AEGIS_RATCHET_BLOB_LEN(slotlen) && info != NULL && infolen == AEGIS_RATCHET_INFO_LEN;
}

/* Seal `s` into `blob` and write its info. */
static int emit(uint8_t *blob, size_t bloblen, uint8_t *info, const uint8_t *slot, size_t slotlen, const rstate *s) {
  uint8_t *plain;
  int rc;
  if (s->nskipped > MAXS) return AEGIS_EFAIL;
  plain = sodium_malloc(AEGIS_RATCHET_STATE_LEN);
  if (plain == NULL) return AEGIS_EFAIL;
  encode(plain, s);
  rc = aegis_vault_seal_payload(blob, bloblen, slot, slotlen, AEGIS_KEY_RATCHET, plain, AEGIS_RATCHET_STATE_LEN);
  sodium_free(plain);
  if (rc == AEGIS_OK) write_info(info, s);
  return rc;
}

/* Open a sealed state of `slot` into a new working state (*out), or an error code. */
static int load(rstate **out, const uint8_t *slot, size_t slotlen, const uint8_t *blob, size_t bloblen) {
  uint8_t *plain;
  rstate *s;
  int rc;
  *out = NULL;
  if (blob == NULL || bloblen != AEGIS_RATCHET_BLOB_LEN(slotlen)) return AEGIS_EBADLEN;
  plain = sodium_malloc(AEGIS_RATCHET_STATE_LEN);
  s = st_new();
  if (plain == NULL || s == NULL) {
    if (plain != NULL) sodium_free(plain);
    st_free(s);
    return AEGIS_EFAIL;
  }
  rc = aegis_vault_open_payload(plain, AEGIS_RATCHET_STATE_LEN, slot, slotlen, AEGIS_KEY_RATCHET, blob, bloblen);
  if (rc == AEGIS_EVERIFY || rc == AEGIS_EBADLEN) rc = AEGIS_ERATCHET_STATE;
  if (rc == AEGIS_OK) rc = decode(s, plain);
  sodium_free(plain);
  if (rc != AEGIS_OK) {
    st_free(s);
    return rc;
  }
  *out = s;
  return AEGIS_OK;
}

/* ── primitives ──────────────────────────────────────────────────────────── */

static void x25519_keypair(uint8_t pub[32], uint8_t sec[32]) {
  randombytes_buf(sec, 32);
  crypto_scalarmult_base(pub, sec);
}

static int dh(uint8_t out[32], const uint8_t sec[32], const uint8_t pub[32]) {
  return crypto_scalarmult(out, sec, pub) == 0 ? AEGIS_OK : AEGIS_ERATCHET_LOW_ORDER;
}

static int nonzero32(const uint8_t *b) {
  uint8_t acc = 0;
  size_t i;
  for (i = 0; i < 32; i++) acc |= b[i];
  return acc != 0;
}

/* (rk, ck) = HKDF(ikm = dh [|| pq], salt = rk, info = "AegisLinkRoot[PQ]"), 64 bytes. */
static int kdf_root(uint8_t rk[32], uint8_t ck[32], const uint8_t dh_out[32], const uint8_t *pq) {
  uint8_t ikm[64], d[64];
  size_t ikmlen = 32;
  int rc;
  memcpy(ikm, dh_out, 32);
  if (pq != NULL) {
    memcpy(ikm + 32, pq, 32);
    ikmlen = 64;
  }
  rc = pq != NULL ? aegis_hkdf_sha256(d, 64, ikm, ikmlen, rk, 32, ROOT_INFO_PQ, sizeof ROOT_INFO_PQ - 1)
                  : aegis_hkdf_sha256(d, 64, ikm, ikmlen, rk, 32, ROOT_INFO, sizeof ROOT_INFO - 1);
  if (rc == AEGIS_OK) {
    memcpy(rk, d, 32);
    memcpy(ck, d + 32, 32);
  }
  sodium_memzero(ikm, sizeof ikm);
  sodium_memzero(d, sizeof d);
  return rc == AEGIS_OK ? AEGIS_OK : AEGIS_EFAIL;
}

/* mk = HMAC(ck, 0x01); ck = HMAC(ck, 0x02). */
static int kdf_chain(uint8_t ck[32], uint8_t mk[32]) {
  static const uint8_t MK_C = 0x01, CK_C = 0x02;
  uint8_t next[32];
  int rc = aegis_hmacsha256(mk, 32, &MK_C, 1, ck, 32);
  if (rc == AEGIS_OK) rc = aegis_hmacsha256(next, 32, &CK_C, 1, ck, 32);
  if (rc == AEGIS_OK) memcpy(ck, next, 32);
  sodium_memzero(next, sizeof next);
  return rc == AEGIS_OK ? AEGIS_OK : AEGIS_EFAIL;
}

/* ── skipped message keys ────────────────────────────────────────────────── */

static long find_skipped(const rstate *s, const uint8_t pub[32], uint32_t n) {
  size_t i;
  for (i = 0; i < s->nskipped; i++) {
    if (s->sk[i].n == n && sodium_memcmp(s->sk[i].pub, pub, 32) == 0) return (long) i;
  }
  return -1;
}

static void remove_skipped(rstate *s, size_t i) {
  sodium_memzero(s->sk[i].mk, 32);
  memmove(&s->sk[i], &s->sk[i + 1], (s->nskipped - i - 1) * sizeof(skipped_t));
  s->nskipped--;
  sodium_memzero(&s->sk[s->nskipped], sizeof(skipped_t));
}

/* Keep at most MAXS: evict the lowest n first (ties: the oldest first). */
static void enforce_limit(rstate *s) {
  while (s->nskipped > MAXS) {
    size_t i, min = 0;
    for (i = 1; i < s->nskipped; i++) {
      if (s->sk[i].n < s->sk[min].n) min = i;
    }
    remove_skipped(s, min);
  }
}

static int skip_until(rstate *s, uint32_t until) {
  uint8_t mk[32];
  long i;
  int rc;
  if ((uint64_t) s->nr + MAXS < (uint64_t) until) return AEGIS_ERATCHET_TOO_MANY_SKIPPED;
  while (s->nr < until) {
    if (!(s->flags & F_CKR) || !(s->flags & F_DHR)) return AEGIS_ERATCHET_NO_CHAIN;
    rc = kdf_chain(s->ckr, mk);
    if (rc != AEGIS_OK) return rc;
    i = find_skipped(s, s->dhr, s->nr);
    if (i >= 0) {
      memcpy(s->sk[i].mk, mk, 32); /* same (pub, n): replace in place, keep its position */
    } else {
      if (s->nskipped >= WORK_SKIPPED) {
        sodium_memzero(mk, sizeof mk);
        return AEGIS_EFAIL;
      }
      memcpy(s->sk[s->nskipped].pub, s->dhr, 32);
      s->sk[s->nskipped].n = s->nr;
      memcpy(s->sk[s->nskipped].mk, mk, 32);
      s->nskipped++;
    }
    s->nr++;
  }
  sodium_memzero(mk, sizeof mk);
  enforce_limit(s);
  return AEGIS_OK;
}

/* ── the ratchet ─────────────────────────────────────────────────────────── */

static int dh_ratchet(rstate *s, const uint8_t *hdr) {
  uint8_t dh1[32], dh2[32], ss1[PQ_SS], ss2[PQ_SS];
  const uint8_t *rkey = hdr + H_RK;
  int hybrid = (s->flags & F_PQS) != 0, has_pq = (hdr[0] & 1) != 0, rc;

  /* Validate the DH and the PQ material BEFORE touching any counter or key. */
  rc = dh(dh1, s->dhs_sec, rkey);
  if (rc != AEGIS_OK) return rc;
  if (hybrid && !has_pq) {
    rc = AEGIS_ERATCHET_DOWNGRADE;
    goto out;
  }
  if (hybrid) {
    if (crypto_kem_mlkem768_dec(ss1, hdr + H_PQCT, s->pqs_sec) != 0 || !nonzero32(ss1)) {
      rc = AEGIS_ERATCHET_PQ;
      goto out;
    }
  }

  s->pn = s->ns;
  s->ns = 0;
  s->nr = 0;
  memcpy(s->dhr, rkey, 32);
  s->flags |= F_DHR;
  if (hybrid) {
    memcpy(s->pqr, hdr + H_PQPUB, PQ_PK);
    s->flags |= F_PQR;
  }
  rc = kdf_root(s->rk, s->ckr, dh1, hybrid ? ss1 : NULL);
  if (rc != AEGIS_OK) goto out;
  s->flags |= F_CKR;

  /* Our next pair (and ML-KEM pair), then the sending chain toward the peer's new keys. */
  x25519_keypair(s->dhs_pub, s->dhs_sec);
  if (hybrid && crypto_kem_mlkem768_keypair(s->pqs_pub, s->pqs_sec) != 0) {
    rc = AEGIS_EFAIL;
    goto out;
  }
  rc = dh(dh2, s->dhs_sec, s->dhr);
  if (rc != AEGIS_OK) goto out;
  if (hybrid) {
    if (crypto_kem_mlkem768_enc(s->pqct, ss2, s->pqr) != 0 || !nonzero32(ss2)) {
      rc = AEGIS_ERATCHET_PQ;
      goto out;
    }
    s->flags |= F_PQCT;
  }
  rc = kdf_root(s->rk, s->cks, dh2, hybrid ? ss2 : NULL);
  if (rc == AEGIS_OK) s->flags |= F_CKS;
out:
  sodium_memzero(dh1, sizeof dh1);
  sodium_memzero(dh2, sizeof dh2);
  sodium_memzero(ss1, sizeof ss1);
  sodium_memzero(ss2, sizeof ss2);
  return rc;
}

int aegis_ratchet_init_alice(uint8_t *blob, size_t bloblen, uint8_t *info, size_t infolen, const uint8_t *slot,
                             size_t slotlen, const uint8_t *rk, size_t rklen, const uint8_t *dhr, size_t dhrlen,
                             const uint8_t *pqr, size_t pqrlen) {
  uint8_t dh_out[32], ss[PQ_SS];
  rstate *s;
  int rc;
  if (!out_args_ok(blob, bloblen, info, infolen, slot, slotlen) || rk == NULL || rklen != 32 || dhr == NULL ||
      dhrlen != 32 || (pqrlen != 0 && pqrlen != PQ_PK) || (pqrlen != 0 && pqr == NULL))
    return AEGIS_EBADLEN;
  s = st_new();
  if (s == NULL) return AEGIS_EFAIL;
  x25519_keypair(s->dhs_pub, s->dhs_sec);
  memcpy(s->dhr, dhr, 32);
  memcpy(s->rk, rk, 32);
  s->flags = F_DHR;
  rc = dh(dh_out, s->dhs_sec, dhr);
  if (rc == AEGIS_OK && pqrlen != 0) {
    /* Alice's own PQ pair for this sending chain; she encapsulates to Bob's
     * PQSPK so Bob recovers the same secret with his PQSPK. */
    memcpy(s->pqr, pqr, PQ_PK);
    s->flags |= F_PQR;
    if (crypto_kem_mlkem768_keypair(s->pqs_pub, s->pqs_sec) != 0) {
      rc = AEGIS_EFAIL;
    } else {
      s->flags |= F_PQS;
      rc = crypto_kem_mlkem768_enc(s->pqct, ss, pqr) == 0 && nonzero32(ss) ? AEGIS_OK : AEGIS_ERATCHET_PQ;
      if (rc == AEGIS_OK) s->flags |= F_PQCT;
    }
  }
  if (rc == AEGIS_OK) rc = kdf_root(s->rk, s->cks, dh_out, pqrlen != 0 ? ss : NULL);
  if (rc == AEGIS_OK) {
    s->flags |= F_CKS;
    rc = emit(blob, bloblen, info, slot, slotlen, s);
  }
  sodium_memzero(dh_out, sizeof dh_out);
  sodium_memzero(ss, sizeof ss);
  st_free(s);
  return rc;
}

int aegis_ratchet_init_bob(uint8_t *blob, size_t bloblen, uint8_t *info, size_t infolen, const uint8_t *slot,
                           size_t slotlen, const uint8_t *rk, size_t rklen, uint32_t spk, uint32_t pqspk) {
  rstate *s;
  int rc;
  if (!out_args_ok(blob, bloblen, info, infolen, slot, slotlen) || rk == NULL || rklen != 32) return AEGIS_EBADLEN;
  s = st_new();
  if (s == NULL) return AEGIS_EFAIL;
  /* His SPK (an X25519 prekey of this profile) is his initial pair, so his
   * first step matches Alice's: DH(spk.sec, alice.pub) == DH(alice.sec, spk.pub). */
  rc = aegis_vault_read_secret(spk, AEGIS_KEY_X25519, slot, slotlen, s->dhs_sec, 32);
  if (rc == AEGIS_OK) rc = crypto_scalarmult_base(s->dhs_pub, s->dhs_sec) == 0 ? AEGIS_OK : AEGIS_EFAIL;
  if (rc == AEGIS_OK && pqspk != 0) {
    rc = aegis_vault_read_secret(pqspk, AEGIS_KEY_MLKEM768, slot, slotlen, s->pqs_sec, PQ_SK);
    if (rc == AEGIS_OK) {
      /* The encapsulation key sits inside the FIPS 203 decapsulation key. */
      memcpy(s->pqs_pub, s->pqs_sec + 1152, PQ_PK);
      s->flags |= F_PQS;
    }
  }
  if (rc == AEGIS_OK) {
    memcpy(s->rk, rk, 32);
    rc = emit(blob, bloblen, info, slot, slotlen, s);
  }
  st_free(s);
  return rc;
}

int aegis_ratchet_encrypt(uint8_t *blob_out, size_t bloblen, uint8_t *info, size_t infolen, uint8_t *hdr,
                          size_t hdrlen, uint8_t *box, size_t boxlen, const uint8_t *slot, size_t slotlen,
                          const uint8_t *blob, size_t blobinlen, const uint8_t *m, size_t mlen) {
  uint8_t mk[32];
  rstate *s;
  int rc;
  if (!out_args_ok(blob_out, bloblen, info, infolen, slot, slotlen) || hdr == NULL ||
      hdrlen != AEGIS_RATCHET_HEADER_LEN || box == NULL || (m == NULL && mlen != 0) ||
      mlen > SIZE_MAX - NONCE - MAC || boxlen != NONCE + MAC + mlen)
    return AEGIS_EBADLEN;
  rc = load(&s, slot, slotlen, blob, blobinlen);
  if (rc != AEGIS_OK) return rc;
  if (!(s->flags & F_CKS)) {
    rc = AEGIS_ERATCHET_NO_CHAIN;
  } else if (s->ns == UINT32_MAX) {
    rc = AEGIS_EFAIL;
  } else {
    rc = kdf_chain(s->cks, mk);
  }
  if (rc == AEGIS_OK) {
    randombytes_buf(box, NONCE);
    rc = crypto_secretbox_easy(box + NONCE, m, mlen, box, mk) == 0 ? AEGIS_OK : AEGIS_EFAIL;
  }
  sodium_memzero(mk, sizeof mk);
  if (rc == AEGIS_OK) {
    memset(hdr, 0, AEGIS_RATCHET_HEADER_LEN);
    put32(hdr + 1, s->ns);
    put32(hdr + 5, s->pn);
    memcpy(hdr + H_RK, s->dhs_pub, 32);
    /* The chain's PQ material rides on EVERY message of it, so a lost chain
     * head does not strand the chain. */
    if ((s->flags & F_PQS) && (s->flags & F_PQCT)) {
      hdr[0] = 1;
      memcpy(hdr + H_PQPUB, s->pqs_pub, PQ_PK);
      memcpy(hdr + H_PQCT, s->pqct, PQ_CT);
    }
    s->ns++;
    rc = emit(blob_out, bloblen, info, slot, slotlen, s);
  }
  st_free(s);
  return rc;
}

int aegis_ratchet_decrypt(uint8_t *blob_out, size_t bloblen, uint8_t *info, size_t infolen, uint8_t *m, size_t mlen,
                          const uint8_t *slot, size_t slotlen, const uint8_t *blob, size_t blobinlen,
                          const uint8_t *hdr, size_t hdrlen, const uint8_t *box, size_t boxlen) {
  uint8_t mk[32];
  const uint8_t *rkey;
  uint32_t n, pn;
  rstate *s;
  long hit;
  int rc;
  if (!out_args_ok(blob_out, bloblen, info, infolen, slot, slotlen) || hdr == NULL ||
      hdrlen != AEGIS_RATCHET_HEADER_LEN || (hdr[0] & ~1u) != 0 || box == NULL || boxlen < NONCE + MAC ||
      m == NULL || mlen != boxlen - NONCE - MAC)
    return AEGIS_EBADLEN;
  rkey = hdr + H_RK;
  n = get32(hdr + 1);
  pn = get32(hdr + 5);
  rc = load(&s, slot, slotlen, blob, blobinlen);
  if (rc != AEGIS_OK) return rc;

  hit = find_skipped(s, rkey, n);
  if (hit >= 0) {
    /* A stored key is consumed only by a message that authenticates: a forgery does not burn it. */
    if (crypto_secretbox_open_easy(m, box + NONCE, boxlen - NONCE, box, s->sk[hit].mk) != 0) {
      rc = AEGIS_EVERIFY;
    } else {
      remove_skipped(s, (size_t) hit);
      rc = emit(blob_out, bloblen, info, slot, slotlen, s);
    }
    if (rc != AEGIS_OK) sodium_memzero(m, mlen);
    st_free(s);
    return rc;
  }

  if (!(s->flags & F_DHR) || sodium_memcmp(rkey, s->dhr, 32) != 0) {
    rc = skip_until(s, pn);
    if (rc == AEGIS_OK) rc = dh_ratchet(s, hdr);
  }
  if (rc == AEGIS_OK) rc = skip_until(s, n);
  if (rc == AEGIS_OK && !(s->flags & F_CKR)) rc = AEGIS_ERATCHET_NO_CHAIN;
  if (rc == AEGIS_OK && s->nr == UINT32_MAX) rc = AEGIS_EFAIL;
  if (rc == AEGIS_OK) rc = kdf_chain(s->ckr, mk);
  if (rc == AEGIS_OK) {
    s->nr++;
    rc = crypto_secretbox_open_easy(m, box + NONCE, boxlen - NONCE, box, mk) == 0 ? AEGIS_OK : AEGIS_EVERIFY;
  }
  sodium_memzero(mk, sizeof mk);
  if (rc == AEGIS_OK) rc = emit(blob_out, bloblen, info, slot, slotlen, s);
  if (rc != AEGIS_OK) sodium_memzero(m, mlen);
  st_free(s);
  return rc;
}

int aegis_ratchet_trim(uint8_t *blob_out, size_t bloblen, uint8_t *info, size_t infolen, const uint8_t *slot,
                       size_t slotlen, const uint8_t *blob, size_t blobinlen, uint32_t max_age) {
  rstate *s;
  int64_t cutoff;
  size_t i;
  int rc;
  if (!out_args_ok(blob_out, bloblen, info, infolen, slot, slotlen)) return AEGIS_EBADLEN;
  rc = load(&s, slot, slotlen, blob, blobinlen);
  if (rc != AEGIS_OK) return rc;
  cutoff = (int64_t) s->nr - (int64_t) max_age;
  for (i = 0; i < s->nskipped;) {
    if ((int64_t) s->sk[i].n < cutoff) {
      remove_skipped(s, i);
    } else {
      i++;
    }
  }
  rc = emit(blob_out, bloblen, info, slot, slotlen, s);
  st_free(s);
  return rc;
}

int aegis_ratchet_import(uint8_t *blob_out, size_t bloblen, uint8_t *info, size_t infolen, const uint8_t *slot,
                         size_t slotlen, const uint8_t *raw, size_t rawlen) {
  rstate *s;
  int rc;
  if (!out_args_ok(blob_out, bloblen, info, infolen, slot, slotlen) || raw == NULL ||
      rawlen != AEGIS_RATCHET_STATE_LEN)
    return AEGIS_EBADLEN;
  s = st_new();
  if (s == NULL) return AEGIS_EFAIL;
  rc = decode(s, raw);
  if (rc == AEGIS_OK) rc = emit(blob_out, bloblen, info, slot, slotlen, s);
  st_free(s);
  return rc;
}
