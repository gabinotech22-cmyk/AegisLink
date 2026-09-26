/*
 * Vault internals shared with other C modules of the core (aegis_ratchet.c).
 * Not part of the binding: nothing here is reachable from JavaScript.
 */
#ifndef AEGIS_VAULT_INTERNAL_H
#define AEGIS_VAULT_INTERNAL_H

#include <stddef.h>
#include <stdint.h>

/* Seal `len` bytes as a v2 blob of `type` under the KEK of `slot` (bloblen = AEGIS_VAULT_BLOB_LEN(slotlen, len)). */
int aegis_vault_seal_payload(uint8_t *blob, size_t bloblen, const uint8_t *slot, size_t slotlen, int type,
                             const uint8_t *plain, size_t len);
/* Open a blob of `type` sealed for `slot` into `out` (exactly `len` bytes). EVERIFY: tampered or not this profile's. */
int aegis_vault_open_payload(uint8_t *out, size_t len, const uint8_t *slot, size_t slotlen, int type,
                             const uint8_t *blob, size_t bloblen);
/* Copy the secret of `handle` if it serves `want_type` and belongs to `slot`; ENOKEY otherwise. */
int aegis_vault_read_secret(uint32_t handle, int want_type, const uint8_t *slot, size_t slotlen, uint8_t *out,
                            size_t outlen);

#endif
