/*
 * Line-oriented driver for the aegis_sodium C core (host test harness only).
 *
 * Input, one call per line:  <op> <arg>...
 *   <arg> is lowercase hex bytes, "_" (empty buffer), "NULL" (NULL pointer,
 *   length 0), "NULL:<n>" (NULL pointer claiming <n> bytes) or "#<n>" (an
 *   output buffer of <n> bytes). argon2id's t and m are 4-byte little-endian
 *   buffers, and so are pow_sha256's difficulty and
 *   pbkdf2_sha256's iteration count. "#<n>=<name>" also remembers that output
 *   under <name>, and "$<name>" passes it as an input later (vault handles,
 *   which are 4-byte little-endian, and blobs).
 * Output, one line per call:  <return code> <hex of each output buffer>...
 */
#define _POSIX_C_SOURCE 200809L /* strtok_r */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "aegis_sodium.h"
#include "aegis_vault.h"

#define MAX_ARGS 8
#define MAX_LINE (1 << 22)

typedef struct {
  uint8_t *p;
  size_t len;
  int out;
  char name[16]; /* "#N=name": remember this output under `name` */
} arg_t;

/* Named outputs ("#4=h1") reused as inputs ("$h1") by later lines: vault handles and blobs. */
#define MAX_VARS 256
static struct {
  char name[16];
  uint8_t *p;
  size_t len;
} vars[MAX_VARS];

static void set_var(const char *name, const uint8_t *p, size_t len) {
  int i, free_i = -1;
  for (i = 0; i < MAX_VARS; i++) {
    if (vars[i].p && strcmp(vars[i].name, name) == 0) break;
    if (!vars[i].p && free_i < 0) free_i = i;
  }
  if (i == MAX_VARS) i = free_i;
  if (i < 0) return;
  free(vars[i].p);
  vars[i].p = malloc(len ? len : 1);
  if (!vars[i].p) return;
  memcpy(vars[i].p, p, len);
  vars[i].len = len;
  snprintf(vars[i].name, sizeof vars[i].name, "%s", name);
}

static int parse_arg(const char *tok, arg_t *a) {
  size_t n, i;
  memset(a, 0, sizeof *a);
  if (strcmp(tok, "NULL") == 0) return 0;
  if (strncmp(tok, "NULL:", 5) == 0) {
    a->len = (size_t) strtoull(tok + 5, NULL, 10);
    return 0;
  }
  if (tok[0] == '#') {
    char *end;
    a->len = (size_t) strtoull(tok + 1, &end, 10);
    if (*end == '=') snprintf(a->name, sizeof a->name, "%s", end + 1);
    a->p = calloc(a->len ? a->len : 1, 1);
    a->out = 1;
    return a->p ? 0 : -1;
  }
  if (tok[0] == '$') {
    for (i = 0; i < MAX_VARS; i++) {
      if (vars[i].p && strcmp(vars[i].name, tok + 1) == 0) {
        a->len = vars[i].len;
        a->p = malloc(a->len ? a->len : 1);
        if (!a->p) return -1;
        memcpy(a->p, vars[i].p, a->len);
        return 0;
      }
    }
    return -1;
  }
  if (strcmp(tok, "_") == 0) {
    a->p = calloc(1, 1);
    return a->p ? 0 : -1;
  }
  n = strlen(tok);
  if (n % 2) return -1;
  a->len = n / 2;
  a->p = malloc(a->len ? a->len : 1);
  if (!a->p) return -1;
  for (i = 0; i < a->len; i++) {
    unsigned int byte;
    if (sscanf(tok + 2 * i, "%2x", &byte) != 1) return -1;
    a->p[i] = (uint8_t) byte;
  }
  return 0;
}

#define A(i) args[i].p, args[i].len

/* A handle output (#4): write it little-endian. */
static uint32_t *h32(arg_t *a) {
  return (a->len == 4 && a->p) ? (uint32_t *) (void *) a->p : NULL;
}

/* A 4-byte little-endian argument as uint32 (argon2id's cost parameters). */
static uint32_t u32(const arg_t *a) {
  if (a->len != 4 || a->p == NULL) return 0xFFFFFFFFu; /* out of every accepted range */
  return (uint32_t) a->p[0] | (uint32_t) a->p[1] << 8 | (uint32_t) a->p[2] << 16 | (uint32_t) a->p[3] << 24;
}

/* Test-only: out = src with byte `idx` set to `val` (a tampered copy of a named blob). */
static int poke(arg_t *out, const arg_t *src, uint32_t idx, uint32_t val) {
  if (out->len != src->len || idx >= src->len || val > 255) return -1;
  memcpy(out->p, src->p, src->len);
  out->p[idx] = (uint8_t) val;
  return 0;
}

static int dispatch(const char *op, arg_t *args, int n) {
#define OP(name, nargs, call)                                                                                        \
  if (strcmp(op, name) == 0) return n == (nargs) ? (call) : -100;
  OP("init", 0, aegis_init())
  OP("poke", 4, poke(&args[0], &args[1], u32(&args[2]), u32(&args[3])))
  OP("randombytes", 1, aegis_randombytes(A(0)))
  OP("memcmp", 2, aegis_memcmp(A(0), A(1)))
  OP("box_keypair", 2, aegis_box_keypair(A(0), A(1)))
  OP("box_easy", 5, aegis_box_easy(A(0), A(1), A(2), A(3), A(4)))
  OP("box_open_easy", 5, aegis_box_open_easy(A(0), A(1), A(2), A(3), A(4)))
  OP("box_beforenm", 3, aegis_box_beforenm(A(0), A(1), A(2)))
  OP("secretbox_easy", 4, aegis_secretbox_easy(A(0), A(1), A(2), A(3)))
  OP("secretbox_open_easy", 4, aegis_secretbox_open_easy(A(0), A(1), A(2), A(3)))
  OP("scalarmult", 3, aegis_scalarmult(A(0), A(1), A(2)))
  OP("scalarmult_base", 2, aegis_scalarmult_base(A(0), A(1)))
  OP("sign_keypair", 2, aegis_sign_keypair(A(0), A(1)))
  OP("sign_seed_keypair", 3, aegis_sign_seed_keypair(A(0), A(1), A(2)))
  OP("sign_detached", 3, aegis_sign_detached(A(0), A(1), A(2)))
  OP("sign_verify_detached", 3, aegis_sign_verify_detached(A(0), A(1), A(2)))
  OP("hmacsha256", 3, aegis_hmacsha256(A(0), A(1), A(2)))
  OP("hkdf_sha256", 4, aegis_hkdf_sha256(A(0), A(1), A(2), A(3)))
  OP("argon2id", 5, aegis_argon2id(A(0), A(1), A(2), u32(&args[3]), u32(&args[4])))
  OP("pow_sha256", 3, aegis_pow_sha256(A(0), A(1), u32(&args[2])))
  OP("vault_unlock", 2, aegis_vault_unlock(A(0), A(1)))
  OP("vault_lock", 1, aegis_vault_lock(A(0)))
  OP("vault_lock_all", 0, aegis_vault_lock_all())
  OP("vault_generate", 5, aegis_vault_generate(h32(&args[0]), A(1), A(2), A(3), (int) u32(&args[4])))
  OP("vault_import", 6, aegis_vault_import(h32(&args[0]), A(1), A(2), A(3), (int) u32(&args[4]), A(5)))
  OP("vault_load", 5, aegis_vault_load(h32(&args[0]), (int *) (void *) h32(&args[1]), A(2), A(3), A(4)))
  OP("vault_derive_ed25519", 4, aegis_vault_derive_ed25519(h32(&args[0]), A(1), A(2), u32(&args[3])))
  OP("vault_copy", 4, aegis_vault_copy(h32(&args[0]), A(1), u32(&args[2]), A(3)))
  OP("vault_release", 1, aegis_vault_release(u32(&args[0])))
  OP("vault_sign", 3, aegis_vault_sign(u32(&args[0]), A(1), A(2)))
  OP("vault_scalarmult", 3, aegis_vault_scalarmult(u32(&args[0]), A(1), A(2)))
  OP("vault_box", 5, aegis_vault_box(u32(&args[0]), A(1), A(2), A(3), A(4)))
  OP("vault_box_open", 5, aegis_vault_box_open(u32(&args[0]), A(1), A(2), A(3), A(4)))
  OP("vault_mlkem768_dec", 3, aegis_vault_mlkem768_dec(u32(&args[0]), A(1), A(2)))
  OP("vault_export", 3, aegis_vault_export(u32(&args[0]), (int) u32(&args[1]), A(2)))
  OP("vault_live", 0, (int) aegis_vault_live_keys())
  OP("ratchet_init_alice", 6, aegis_ratchet_init_alice(A(0), A(1), A(2), A(3), A(4), A(5)))
  OP("ratchet_init_bob", 6, aegis_ratchet_init_bob(A(0), A(1), A(2), A(3), u32(&args[4]), u32(&args[5])))
  OP("ratchet_encrypt", 7, aegis_ratchet_encrypt(A(0), A(1), A(2), A(3), A(4), A(5), A(6)))
  OP("ratchet_decrypt", 7, aegis_ratchet_decrypt(A(0), A(1), A(2), A(3), A(4), A(5), A(6)))
  OP("ratchet_trim", 5, aegis_ratchet_trim(A(0), A(1), A(2), A(3), u32(&args[4])))
  OP("ratchet_import", 4, aegis_ratchet_import(A(0), A(1), A(2), A(3)))
  OP("pbkdf2_sha256", 4, aegis_pbkdf2_sha256(A(0), A(1), A(2), u32(&args[3])))
  OP("mlkem768_keypair", 2, aegis_mlkem768_keypair(A(0), A(1)))
  OP("mlkem768_seed_keypair", 3, aegis_mlkem768_seed_keypair(A(0), A(1), A(2)))
  OP("mlkem768_enc", 3, aegis_mlkem768_enc(A(0), A(1), A(2)))
  OP("mlkem768_dec", 3, aegis_mlkem768_dec(A(0), A(1), A(2)))
#undef OP
  return -101;
}

int main(void) {
  static char line[MAX_LINE];
  if (aegis_init() != AEGIS_OK) return 1;
  while (fgets(line, sizeof line, stdin)) {
    arg_t args[MAX_ARGS];
    int n = 0, rc, i;
    char *save = NULL;
    char *op = strtok_r(line, " \r\n", &save), *tok;
    if (!op) continue;
    while ((tok = strtok_r(NULL, " \r\n", &save)) != NULL) {
      if (n == MAX_ARGS || parse_arg(tok, &args[n]) != 0) return 2;
      n++;
    }
    rc = dispatch(op, args, n);
    for (i = 0; i < n; i++) {
      if (args[i].out && args[i].name[0]) set_var(args[i].name, args[i].p, args[i].len);
    }
    printf("%d", rc);
    for (i = 0; i < n; i++) {
      if (args[i].out) {
        size_t j;
        putchar(' ');
        if (args[i].len == 0) putchar('_');
        for (j = 0; j < args[i].len; j++) printf("%02x", args[i].p[j]);
      }
      free(args[i].p);
    }
    putchar('\n');
    fflush(stdout);
  }
  return 0;
}
