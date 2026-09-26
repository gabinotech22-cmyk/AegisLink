/*
 * aegis_vault — private keys that never reach JavaScript (F-1b,
 * docs/F1B-KEY-VAULT-DESIGN.md).
 *
 * Keys live in libsodium guarded memory (sodium_malloc, no access outside an
 * operation) and are named by opaque handles. A key leaves the vault only
 * WRAPPED: crypto_secretbox under the profile's key-encryption key (KEK), with
 * the key type and the profile slot authenticated inside the box, so a blob of
 * one profile or type never loads as another (blob v2; v1 kept the type only
 * in the unauthenticated header and never shipped in a release). The KEK itself is kept by the OS
 * (Keychain / Keystore) and handed to the vault by the platform binding.
 *
 * Thread safety: every function takes the vault mutex.
 * Return codes: those of aegis_sodium.h (AEGIS_OK, AEGIS_EVERIFY,
 * AEGIS_EBADLEN, AEGIS_EFAIL), plus AEGIS_ENOKEY for a locked profile or an
 * unknown / released handle.
 */
#ifndef AEGIS_VAULT_H
#define AEGIS_VAULT_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define AEGIS_ENOKEY -3

#define AEGIS_VAULT_KEK_LEN 32
#define AEGIS_VAULT_SLOT_MAX 64
#define AEGIS_VAULT_MAX_SLOTS 16
#define AEGIS_VAULT_MAX_KEYS 8192

/* Key types and their secret sizes. */
#define AEGIS_KEY_X25519 1   /* 32-byte X25519 secret (box / scalarmult) */
#define AEGIS_KEY_ED25519 2  /* 64-byte Ed25519 secret (seed || public key) */
#define AEGIS_KEY_MLKEM768 3 /* 2400-byte ML-KEM-768 decapsulation key */
#define AEGIS_KEY_SECRET32 4 /* 32-byte symmetric secret (ratchet chain/root keys) */
/* 32-byte X25519 PREKEY secret (SPK / OPK): the same operations as
 * AEGIS_KEY_X25519, but a distinct type so a platform can apply a lighter
 * export policy to prekeys than to the identity key (the desktop syncs its SPK
 * to linked devices without asking the user; the identity key needs consent).
 * Types are authenticated inside the blob, so one cannot pass for the other. */
#define AEGIS_KEY_X25519_PREKEY 5

/* Blob v2 = "AV" | 2 | type | nonce(24) | secretbox(type | slotlen | slot | key).
 * The type is authenticated inside the box (a header type that disagrees with
 * the boxed one is rejected), and so is the profile slot. */
#define AEGIS_VAULT_BLOB_VERSION 2
#define AEGIS_VAULT_BLOB_HEADER 28
#define AEGIS_VAULT_BLOB_LEN(slotlen, keylen) (AEGIS_VAULT_BLOB_HEADER + 16 + 2 + (slotlen) + (keylen))

/* Secret length of a key type; 0 for an unknown type. */
size_t aegis_vault_key_len(int type);
/* Public-key length a type exposes (X25519 32, Ed25519 32, ML-KEM 1184, secret 0). */
size_t aegis_vault_pub_len(int type);

/* Make a profile usable with its KEK (copied into guarded memory). Idempotent
 * for the same KEK; a different KEK for an unlocked slot is AEGIS_EFAIL. */
int aegis_vault_unlock(const uint8_t *slot, size_t slotlen, const uint8_t *kek, size_t keklen);
/* Forget the profile's KEK and destroy every key of that profile. */
int aegis_vault_lock(const uint8_t *slot, size_t slotlen);
/* Lock every profile (panic wipe, logout). */
int aegis_vault_lock_all(void);

/* New random key of `type` in `slot`: writes its handle, its wrapped blob and
 * its public key (pub may be NULL/0 for AEGIS_KEY_SECRET32). */
int aegis_vault_generate(uint32_t *handle, uint8_t *blob, size_t bloblen, uint8_t *pub, size_t publen,
                         const uint8_t *slot, size_t slotlen, int type);
/* Import raw key bytes (one-time migration of keys stored before F-1b). */
int aegis_vault_import(uint32_t *handle, uint8_t *blob, size_t bloblen, uint8_t *pub, size_t publen,
                       const uint8_t *slot, size_t slotlen, int type, const uint8_t *raw, size_t rawlen);
/* Unwrap a blob of `slot` into a new handle; writes its type and public key. */
int aegis_vault_load(uint32_t *handle, int *type, uint8_t *pub, size_t publen, const uint8_t *slot,
                     size_t slotlen, const uint8_t *blob, size_t bloblen);
/* Ed25519 key whose seed is the X25519 secret of `x_handle` (the identity
 * derivation: sign.keyPair.fromSeed(boxSecret)). New handle, blob and pub. */
int aegis_vault_derive_ed25519(uint32_t *handle, uint8_t *blob, size_t bloblen, uint8_t *pub, size_t publen,
                               uint32_t x_handle);
/* The key of `src` as a new key of profile `slot` (both unlocked): new handle
 * and a blob of `slot`. Used when a profile's identity is minted before its
 * slot name is known (the slot is the identity's own AegisID). */
int aegis_vault_copy(uint32_t *handle, uint8_t *blob, size_t bloblen, uint32_t src, const uint8_t *slot,
                     size_t slotlen);
/* Destroy one key. */
int aegis_vault_release(uint32_t handle);

/* Operations by handle. */
int aegis_vault_sign(uint32_t handle, uint8_t *sig, size_t siglen, const uint8_t *m, size_t mlen);
int aegis_vault_scalarmult(uint32_t handle, uint8_t *q, size_t qlen, const uint8_t *p, size_t plen);
int aegis_vault_box(uint32_t handle, uint8_t *c, size_t clen, const uint8_t *m, size_t mlen, const uint8_t *n,
                    size_t nlen, const uint8_t *pk, size_t pklen);
int aegis_vault_box_open(uint32_t handle, uint8_t *m, size_t mlen, const uint8_t *c, size_t clen,
                         const uint8_t *n, size_t nlen, const uint8_t *pk, size_t pklen);
int aegis_vault_mlkem768_dec(uint32_t handle, uint8_t *ss, size_t sslen, const uint8_t *ct, size_t ctlen);

/* The raw key of `handle` (which must be of `type`), for the explicit exports
 * only: backup, device link and the recovery phrase (design doc section 5). */
int aegis_vault_export(uint32_t handle, int type, uint8_t *out, size_t outlen);

/* Number of live handles (tests / leak checks). */
size_t aegis_vault_live_keys(void);

/*
 * ── Double Ratchet in the vault (F-1b phase 3, aegis_ratchet.c) ─────────────
 *
 * The ratchet state (root, chain and message keys, our DH and ML-KEM pairs)
 * lives only here while a step runs; it leaves the core sealed under the
 * profile KEK as a blob of type AEGIS_KEY_RATCHET, which never loads as a key
 * (and no key blob opens as a state). Every step reads a sealed state and
 * writes a NEW one: the old one is untouched, so a message that does not
 * authenticate leaves the session as it was. The algorithm and the wire are
 * those of the app's former JavaScript ratchet (its TypeScript twin:
 * jest/ratchetCore.ts; state layout: ratchetState.ts).
 *
 * Buffers: blob = AEGIS_RATCHET_BLOB_LEN(slotlen); info (non-secret view:
 * counters and public keys) = AEGIS_RATCHET_INFO_LEN; hdr (packed message
 * header) = AEGIS_RATCHET_HEADER_LEN; box = nonce(24) | secretbox ciphertext.
 */
#define AEGIS_KEY_RATCHET 6
#define AEGIS_RATCHET_MAX_SKIPPED 50
#define AEGIS_RATCHET_STATE_LEN 9464
#define AEGIS_RATCHET_HEADER_LEN 2313
#define AEGIS_RATCHET_INFO_LEN 77
#define AEGIS_RATCHET_BLOB_LEN(slotlen) AEGIS_VAULT_BLOB_LEN(slotlen, AEGIS_RATCHET_STATE_LEN)

/* Ratchet return codes (besides OK, EVERIFY = message does not authenticate, EBADLEN, EFAIL, ENOKEY). */
#define AEGIS_ERATCHET_STATE -10            /* sealed state does not open / malformed */
#define AEGIS_ERATCHET_NO_CHAIN -11         /* no sending (encrypt) or receiving (decrypt) chain */
#define AEGIS_ERATCHET_TOO_MANY_SKIPPED -12 /* more than AEGIS_RATCHET_MAX_SKIPPED skipped in one jump */
#define AEGIS_ERATCHET_LOW_ORDER -13        /* all-zero X25519 output */
#define AEGIS_ERATCHET_DOWNGRADE -14        /* hybrid chain turn without its ML-KEM material */
#define AEGIS_ERATCHET_PQ -15               /* bad / all-zero ML-KEM material */

/* Alice: a fresh sending chain toward Bob's SPK `dhr` (32) and, hybrid, his PQSPK `pqr` (1184; empty = classic). */
int aegis_ratchet_init_alice(uint8_t *blob, size_t bloblen, uint8_t *info, size_t infolen, const uint8_t *slot,
                             size_t slotlen, const uint8_t *rk, size_t rklen, const uint8_t *dhr, size_t dhrlen,
                             const uint8_t *pqr, size_t pqrlen);
/* Bob: his SPK handle (X25519 prekey of `slot`) and, hybrid, PQSPK handle (0 = classic) are his initial pair. */
int aegis_ratchet_init_bob(uint8_t *blob, size_t bloblen, uint8_t *info, size_t infolen, const uint8_t *slot,
                           size_t slotlen, const uint8_t *rk, size_t rklen, uint32_t spk, uint32_t pqspk);
int aegis_ratchet_encrypt(uint8_t *blob_out, size_t bloblen, uint8_t *info, size_t infolen, uint8_t *hdr,
                          size_t hdrlen, uint8_t *box, size_t boxlen, const uint8_t *slot, size_t slotlen,
                          const uint8_t *blob, size_t blobinlen, const uint8_t *m, size_t mlen);
/* EVERIFY: the message does not authenticate; nothing is written. */
int aegis_ratchet_decrypt(uint8_t *blob_out, size_t bloblen, uint8_t *info, size_t infolen, uint8_t *m, size_t mlen,
                          const uint8_t *slot, size_t slotlen, const uint8_t *blob, size_t blobinlen,
                          const uint8_t *hdr, size_t hdrlen, const uint8_t *box, size_t boxlen);
/* Drop skipped message keys older than Nr - max_age. */
int aegis_ratchet_trim(uint8_t *blob_out, size_t bloblen, uint8_t *info, size_t infolen, const uint8_t *slot,
                       size_t slotlen, const uint8_t *blob, size_t blobinlen, uint32_t max_age);
/* One-time migration of a pre-F-1b session: a raw state (AEGIS_RATCHET_STATE_LEN, ratchetState.ts layout). */
int aegis_ratchet_import(uint8_t *blob_out, size_t bloblen, uint8_t *info, size_t infolen, const uint8_t *slot,
                         size_t slotlen, const uint8_t *raw, size_t rawlen);

#ifdef __cplusplus
}
#endif

#endif
