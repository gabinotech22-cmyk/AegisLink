# AegisLink Protocol Specification

> **Status: pre-release, NOT independently audited.** This document describes the
> cryptographic protocol as implemented in this repository. It is written for
> reviewers, auditors and grant evaluators. It deliberately discloses the
> protocol's limitations and its deviations from the Signal specification.
> Independent review is openly invited — see [`SECURITY.md`](../SECURITY.md).
>
> This spec reflects the code, not aspirations. Where the implementation is
> partial or differs from common practice, it is marked **⚠ Disclosure**.

---

## 1. Goals and non-goals

AegisLink is a free/open-source end-to-end encrypted messenger whose defining
property is **metadata minimization enforced at the protocol layer, not by
server policy**.

**Goals**

- Confidentiality, integrity and authenticity of message content (E2EE).
- Forward secrecy and post-compromise security via the Double Ratchet.
- Registration with **no phone number, email or name** — an identity is a
  keypair generated on-device.
- A relay that **cannot log what it never receives**: payloads are
  field-allow-listed, stripped of client timestamps, length-normalized by
  padding, and carry no plaintext sender field on the wire.
- Fully self-hostable relay under AGPL-3.0.

**Non-goals (honestly stated)**

- **Anonymity against a global passive adversary / traffic analysis.** AegisLink
  reduces metadata; it does not defeat an adversary who can observe network
  flows in and out of the relay (timing/volume correlation). See §8.
- **Hiding the sender↔recipient relationship from the relay operator in real
  time.** Sealed sender (§7.3) removes the sender from the payload and from the
  at-rest queue, but the authenticated live socket still reveals the sender to
  an actively-correlating relay. This is the same limitation Signal documents
  for its sealed-sender feature.
- **Post-quantum security against a fully PQ-only fleet.** A hybrid X25519 +
  ML-KEM-768 handshake (PQXDH-style) **is implemented** (§4.4, handshake v2) and
  provides store-now-decrypt-later resistance for v2↔v2 sessions. It is still
  rollout-gated: while not-yet-upgraded (v1) clients exist, sessions with them
  fall back to classical X25519, and the desktop client is pending the same
  wiring (§10).

---

## 2. Cryptographic primitives

| Purpose | Primitive | Library |
|---|---|---|
| DH key agreement | X25519 (`nacl.scalarMult` / `nacl.box`) | TweetNaCl |
| Post-quantum KEM (hybrid handshake, v2) | ML-KEM-768 (FIPS 203) | `@noble/post-quantum` |
| Authenticated encryption (outer envelope) | `crypto_box` = X25519 + XSalsa20-Poly1305 (`nacl.box`) | TweetNaCl |
| Authenticated encryption (message) | `crypto_secretbox` = XSalsa20-Poly1305 (`nacl.secretbox`) | TweetNaCl |
| Signatures | Ed25519 (`nacl.sign`) | TweetNaCl |
| Key derivation | HKDF-SHA256 | `@noble/hashes` |
| Chain KDF / MAC | HMAC-SHA256 | `@noble/hashes` |
| Fingerprints | SHA-256 | `@noble/hashes` |

No primitive is hand-rolled; all symmetric/asymmetric operations route through
TweetNaCl and `@noble/hashes`. The protocol layer that composes them
(X3DH, Double Ratchet, envelope, metadata padding) is the project's own code and
is the primary surface for which an independent audit is sought.

### 2.1 Implementation posture — side channels and the JavaScript crypto core

A reviewer's first and most legitimate question about a React Native messenger is:
*"the cryptography runs in JavaScript — isn't that vulnerable to timing
side-channels?"* This section answers it without hand-waving, and states plainly
what we do and do not claim.

**What actually runs.** The cryptographic primitives execute in **pure
JavaScript** on the client's JS engine — Hermes on the mobile client, V8 (via
Electron) on desktop. There is **no native libsodium/Rust/C++ binding** in the
build; `tweetnacl`, `@noble/hashes` and `@noble/post-quantum` are JS packages
(see `mobile/package.json`). We say this explicitly because the opposite claim —
"constant-time native bindings" — would be trivially falsifiable by anyone who
opens the manifest, and a falsifiable security claim is worse than an honest
limitation.

**Constant-time posture (what is in our favor).**

- TweetNaCl is a direct port of Bernstein's NaCl and was **written to be
  constant-time at the source level** — XSalsa20, Poly1305, X25519 scalar
  multiplication and Ed25519 avoid secret-dependent branches and table lookups by
  design. `@noble/*` follows the same constant-time discipline and is widely
  audited.
- All **secret/key-material comparisons in this codebase are constant-time**
  (XOR-accumulated, no early return) rather than relying on `===` or a
  short-circuiting `Array.every` — e.g. the ratchet MAC/equality check
  (`mobile/src/crypto/signal/ratchet.ts`). This was a deliberate hardening pass.
- Intermediate key material (DH outputs, ephemeral secrets, shared secrets,
  derived buffers) is **zeroized in `try/finally`** after use, shrinking the
  window in which a secret sits in a recoverable heap object.

**The honest caveat (the real concern, stated precisely).** Source-level
constant-time is a necessary but **not sufficient** condition once a JIT and a
garbage collector sit underneath. We do **not** control the bytecode the JS
engine ultimately emits: Hermes/V8 may, in principle, introduce
data-dependent optimizations, and GC pauses are non-deterministic. So the
constant-time *intent* of the libraries is **not machine-checked end-to-end** in
our runtime. This is the legitimate residual concern, and we do not paper over
it.

**Why this is a bounded risk for this threat model (not a catastrophe).** A
timing side-channel is only exploitable through an **oracle the attacker can
measure**. In a server (TLS terminator, smartcard) the attacker submits millions
of queries and times the response. AegisLink has no such remote oracle for its
secret-key operations:

- All secret-key operations (DH, ratchet, decrypt) run **on the user's own
  device**; only opaque, length-normalized ciphertext (§7.2) crosses the wire. A
  network or relay adversary cannot time a local `nacl.box`/`secretbox.open`.
- The realistic exploitation path is therefore **local, co-resident measurement
  on an already-compromised device** — which is already declared out of scope
  under endpoint compromise (§8.3). An attacker who can run timing-measurement
  code inside the victim's process has strictly more powerful attacks available
  (it can read the keystore once unsealed).

In short: the JS crypto core is a **known, defensible engineering trade-off of
the React Native platform**, not an oversight. The mitigation is identified and
bounded — see below — not open-ended.

**Roadmap — migrate the hot path to a native binding.** The battle-tested
references all run their crypto core in native code (Signal's `libsignal` in
Rust; Session and SimpleX over native libsodium). That is the correct end state
and the honest gap. The planned hardening is to move the hot-path primitives
(X25519, XSalsa20-Poly1305, Ed25519, HKDF/HMAC) behind a **native libsodium
binding** (e.g. an Expo module wrapping libsodium, or `react-native-quick-crypto`)
while keeping the protocol-composition layer in TypeScript and the same public
interface. This is implementation-substitution behind a stable API, not a
protocol change. Tracked in
[`SECURITY-ROADMAP-2026-06.md`](SECURITY-ROADMAP-2026-06.md) (post-audit
follow-up F-1). Until then, the constant-time guarantee is **source-level, not
runtime-verified**, as stated above.

---

## 3. Identity

### 3.1 Key material

A device identity (`mobile/src/crypto/identity.ts`) consists of:

- An **X25519 key pair** (`nacl.box.keyPair`) — the long-term identity/DH key.
- An **Ed25519 signing key pair** used to sign Signed PreKeys.

```
identity.secretKey         // 32-byte X25519 secret
identity.publicKey         // 32-byte X25519 public
identity.signingSecretKey  // 64-byte Ed25519 secret (seed‖pub)
identity.signingPublicKey  // 32-byte Ed25519 public
```

The Ed25519 key is derived deterministically from the X25519 secret key so that
a single 32-byte secret (and therefore a single mnemonic) fully restores the
identity:

```ts
const { publicKey, secretKey } = nacl.box.keyPair();        // X25519
const signKeys = nacl.sign.keyPair.fromSeed(secretKey);     // Ed25519 seeded by the X25519 secret
```

> **⚠ Disclosure — shared secret scalar across X25519 and Ed25519.**
> The same 32 bytes serve as the X25519 DH secret *and* as the Ed25519 seed.
> This buys single-secret recovery (one mnemonic restores both keys) at the cost
> of cross-domain key separation. The two algorithms clamp/use the scalar
> differently and there is no known practical attack from this construction on
> these primitives, but it is a deliberate deviation from the key-separation
> principle and is flagged here for auditor attention. A future version may use
> a domain-separated KDF (e.g. HKDF with distinct `info` labels) to derive
> independent X25519 and Ed25519 secrets from one seed.

Private keys are stored on-device in `expo-secure-store` (hardware-backed
keystore / Keychain where available) and **never leave the device**.

### 3.2 Aegis ID

The human-facing address is the **Aegis ID**: the first 7 bytes of the X25519
public key, Crockford-base32 encoded into 11 characters, grouped `XXX-XXXX-XXXX`.

```
deriveAegisId(publicKey) → e.g.  "K3M-7QPA-9WZX"
```

> **⚠ Disclosure — the Aegis ID is NOT a trust anchor.**
> Eleven Crockford-base32 characters encode ~55 bits (the 56-bit, 7-byte head is
> reduced to 55 bits by the encoder). It is a routing/display handle only.
> ~55 bits is **not** sufficient collision/second-preimage resistance to bind a
> conversation to a key — an attacker who can choose X25519 key pairs could
> search for a colliding Aegis ID. **Identity verification MUST use the
> fingerprint (§3.3), not the Aegis ID.**

### 3.3 Identity verification (fingerprints)

`mobile/src/crypto/fingerprint.ts` derives a verifiable fingerprint from
`SHA-256(publicKey)`:

- **Hex fingerprint** — first 16 bytes (128 bits) shown as 8 groups of 4 hex
  chars. This is the strong comparison.
- **Word fingerprint** — first 8 bytes (64 bits) mapped to 8 words from a
  256-word list, for easier out-of-band reading.

> **⚠ Disclosure — fingerprint design notes for auditors.**
> 1. The word fingerprint encodes only **64 bits**; the 128-bit hex fingerprint
>    is the comparison to use under a serious threat model. The UI should treat
>    the word list as a convenience, not the authoritative check.
> 2. Fingerprints are computed over **one party's** public key (a per-identity
>    fingerprint), unlike Signal's "safety number" which hashes the *pair* of
>    identity keys. Mutual verification therefore requires each side to confirm
>    the other's fingerprint, rather than comparing a single shared number.

---

## 4. Session establishment — X3DH

Implemented in `mobile/src/crypto/signal/x3dh.ts`, following the
[X3DH](https://signal.org/docs/specifications/x3dh/) construction.

### 4.1 PreKey bundle

The recipient (Bob) publishes to the relay:

- `identityKeyB64` — X25519 identity public key.
- `signingPublicKeyB64` — Ed25519 public key (to verify the SPK signature).
- `signedPreKey` — `{ keyId, publicKeyB64, signatureB64 }`, an X25519 prekey
  signed by Bob's Ed25519 key.
- `oneTimePreKey` — optional `{ keyId, publicKeyB64 }`, consumed once.

A device maintains a single durably-persisted prekey set (`ensureDevicePreKeys`)
so the public bundle published to the relay always matches the secrets stored on
device; concurrent registration paths are serialized to prevent publishing
divergent sets.

### 4.2 Sender (Alice) computation

1. **Mandatory signature check first.** Alice verifies `Ed25519.verify(SPK_pub,
   sig, Bob_signing_pub)` **before any DH operation involving the SPK**. A
   missing signing key, wrong key length, wrong signature length, or invalid
   signature aborts the handshake. This closes the SPK-substitution MITM.
2. Alice generates an ephemeral X25519 key `EK`.
3. DH chain (Signal order):
   ```
   DH1 = DH(IK_A, SPK_B)
   DH2 = DH(EK_A, IK_B)
   DH3 = DH(EK_A, SPK_B)
   DH4 = DH(EK_A, OPK_B)   // only if a one-time prekey is present
   ```
4. **Low-order point guard.** Every DH output (`DH1..DH4`) is rejected if it is
   all-zero (`assertNonZeroDH`), aborting before any key is derived. This blocks
   a malicious relay/peer from forcing a known shared secret by substituting a
   low-order/identity point. Note: the Signed PreKey is signature-checked; the
   peer identity key, ephemeral key and OPK are **not** signed, so the non-zero
   guard is the defense for those inputs.
5. Root key:
   ```
   SK = HKDF-SHA256(
          IKM  = 0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4],
          salt = 0x00×32,
          info = "AegisLinkX3DH",
          L    = 32 )
   ```
   The `0xFF×32` prefix is the Signal-specified domain separator (`F`).

### 4.3 Receiver (Bob) computation

`performX3DHReceiver` mirrors the DH order exactly so both sides derive the same
`SK`, applies the same non-zero guards, and uses the same HKDF parameters.

### 4.4 Hybrid post-quantum handshake (PQXDH, v2)

Handshake **v2** adds an ML-KEM-768 (FIPS 203) encapsulation on top of the
classical X3DH above — it does **not** replace it. Breaking a v2 session requires
breaking *both* X25519 and ML-KEM-768.

1. Bob additionally publishes a **signed PQ prekey (PQSPK)**: an ML-KEM-768
   public key (1184 B) signed with his Ed25519 identity key (64-B detached sig).
   The relay verifies this signature server-side as defence in depth.
2. Alice runs the full classical X3DH (§4.2) to obtain `dhOut`, verifies the
   PQSPK signature **before** using it, then encapsulates:
   `(ct, ss) = ML-KEM-768.encapsulate(PQSPK_B)`.
3. The 32-byte ML-KEM shared secret `ss` is concatenated to the end of `dhOut`,
   and the root key uses a v2-specific domain-separation label:
   ```
   SK = HKDF-SHA256( IKM = 0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4] ‖ ss,
                     salt = 0x00×32, info = "AegisLinkPQXDH", L = 32 )
   ```
4. Alice sends the 1088-B ML-KEM ciphertext `ct` **inside the sealed message**
   (`x3dh.pqCtB64`), never as a relay-visible field. Bob decapsulates
   `ss = ML-KEM-768.decapsulate(ct, PQSPK_secret_B)` and derives the identical
   `SK`. The downstream Double Ratchet inherits the hybrid guarantee unchanged.

ML-KEM uses implicit rejection (FIPS 203): a tampered `ct` does not error, it
yields a different pseudo-random `ss`, so the two sides derive different root keys
and the session fails closed.

> **⚠ Disclosure — version negotiation and downgrade.**
> A v2 sender fetching a bundle **without** a PQSPK falls back to v1 (interop with
> not-yet-upgraded clients). On the receiver side, a legitimate v1 sender is
> indistinguishable from an attacker who stripped the ML-KEM ciphertext, because
> there is no signed version commitment in the bundle. The current implementation
> takes the **strict** stance: a receiver that advertised a PQSPK aborts the
> handshake when the initial message carries no ML-KEM ciphertext. This is safe
> only once every client is v2 — against a mixed fleet it would reject legitimate
> v1 senders (including the still-v1 desktop client). **The planned rollout fix is
> to relax the gate to fall back to v1 during the mixed-version window** (logging
> the downgrade for telemetry) and reserve the strict mode for a fully-v2 fleet;
> this is tracked as a release blocker. Until then the hybrid guarantee holds for
> v2↔v2 sessions only. The PQSPK secret (2400 B) is persisted with the same
> write-then-readback invariant as the SPK and is covered by the panic wipe.

---

## 5. Double Ratchet

Implemented in `mobile/src/crypto/signal/ratchet.ts`, following the
[Double Ratchet](https://signal.org/docs/specifications/doubleratchet/) spec.

### 5.1 KDFs

```
kdfRoot(RK, dhOut):
    derived = HKDF-SHA256(IKM=dhOut, salt=RK, info="AegisLinkRoot", L=64)
    RK'  = derived[0:32]
    CK   = derived[32:64]          // derived buffer zeroized after split

kdfChain(CK):
    MK   = HMAC-SHA256(CK, 0x01)
    CK'  = HMAC-SHA256(CK, 0x02)
```

Messages are encrypted with the per-message key `MK` using `nacl.secretbox`
(XSalsa20-Poly1305) under a fresh random 24-byte nonce.

### 5.2 Headers

Each message carries `{ ratchetKey (DH pub), n, pn }`. A DH-ratchet step occurs
when an inbound `ratchetKey` differs from the stored `DHr`.

### 5.3 Forward secrecy bound

> **⚠ Disclosure — deviation from Signal defaults (intentional).**
> `MAX_SKIPPED_KEYS = 50` (Signal's default is 2000). Skipped message keys are
> capped per chain and evicted lowest-`n`-first, and `trimOldSkippedKeys` can
> shrink the window further on app background. **Rationale:** a smaller retained
> set shrinks the post-hoc decryption window if the encrypted DB is ever
> recovered. **Cost:** a client that misses more than 50 messages on a single
> chain loses those messages. This is a deliberate forward-secrecy/deliverability
> trade-off.

All message keys and chain keys are **zeroized** in place after use
(`zeroize`), including on eviction and on discarded speculative state.

### 5.4 Transactional decryption (anti-desync)

`ratchetDecrypt` performs the (possibly DH-ratcheting) state mutation on a
**clone** of the ratchet state, attempts authentication, and only commits the
advanced state back if `secretbox.open` succeeds:

- **Forged/corrupt ciphertext** → clone discarded (and zeroized); live state is
  untouched. A malicious relay therefore cannot desynchronize a session by
  injecting a message with a valid-looking header but a bad MAC
  (Double Ratchet spec §3.4).
- **Skipped-key path** → a stored skipped key is only consumed/deleted if the
  message actually authenticates, so a forgery cannot burn a real key.
- Low-order point guard (`assertNonZeroDH`) is applied to each ratchet DH before
  any chain key is derived.

---

## 6. Message envelope

A sent message has **two cryptographic layers** (`mobile/src/crypto/messaging.ts`):

```
inner  = stripAndPad({ v:2, from: senderAegisId, ratchet:{…}, x3dh?:{…} })
         └─ ratchet.ciphertext = secretbox(plaintext, nonce, MK)   ← Double Ratchet (forward-secret)
outer  = nacl.box(inner, outerNonce, recipientPub, senderSecret)   ← X25519 box (sealed-sender wrapper)
wire   = { id, to, ciphertext=outer, nonce=outerNonce, init? }
```

- The **inner** layer provides forward secrecy and post-compromise security via
  the Double Ratchet message key `MK`.
- The **outer** `nacl.box` binds the message to the sender↔recipient long-term
  X25519 keys (authenticates the sender to the recipient) and hides the inner
  payload — including the `from` field — from the relay.

> **⚠ Disclosure — the outer layer is not forward-secret.**
> The outer `nacl.box` uses the parties' **long-term** identity X25519 keys, so
> that layer alone has no forward secrecy. This is acceptable because it only
> wraps already-ratcheted ciphertext: compromise of a long-term key lets an
> attacker strip the outer wrapper but still leaves the inner Double Ratchet
> message key protecting the plaintext. Forward secrecy is a property of the
> inner layer.

The protocol version is `2`. `openEnvelope` rejects any payload whose `v` ≠ 2,
whose `from` is not a string, or which lacks a `ratchet` field.

---

## 7. Metadata minimization and at-rest protection

### 7.1 Field allow-list

`mobile/src/crypto/metadata.ts` strips every top-level field not in a strict
allow-list before encryption:

```
ALLOWED_INNER_FIELDS = { v, from, senderPubB64, ratchet, x3dh, pad }
```

Anything else a caller attaches is dropped, so accidental metadata cannot leak
into the encrypted body. There are **no client timestamps or counters** in the
payload.

### 7.2 Length normalization (padding)

Every plaintext is padded to a fixed bucket before encryption so ciphertext
length reveals nothing about content length:

```
buckets = 256, 512, 1024, 2048, 4096, 8192, 16384, 32768, 65536,
          262144, 1048576, 4194304   (bytes)
```

The smallest bucket ≥ payload size is chosen; a random `pad` field (inside the
ciphertext) fills the remainder, with a whitespace-filler fallback to land
exactly on the bucket boundary. Attachments use the 256 KB / 1 MB / 4 MB tiers.

> **⚠ Disclosure — bucket granularity leaks a coarse size class.**
> Padding hides exact length but not the bucket. An observer of ciphertext size
> learns which power-of-two band a message falls in (e.g. "< 256 B" vs
> "256 KB–1 MB"). This is a deliberate size/overhead trade-off, not perfect
> length-hiding.

### 7.3 Sealed sender

The wire envelope the relay validates (`server/src/relay/handler.ts`,
`EnvelopeIn`) contains **no `from` field**:

```
{ id, to, ciphertext, nonce, init? }
```

- The sender's Aegis ID lives **inside** the encrypted body, not on the wire.
- The **offline queue intentionally does not store the sender** (FND-05). On a
  queue drain the recipient receives no sender hint except on first-contact
  (`init`) messages, where the relay attaches `senderPublicKeyB64` so the
  recipient can decrypt a first message it otherwise could not identify.
- On **online** delivery the relay injects `senderPublicKeyB64` (a public,
  non-secret value also available via `GET /identity/:aegisId`) as a convenience
  so the recipient avoids an extra HTTP round-trip. Without this hint the
  recipient **trial-decrypts** the outer box against each known contact's public
  key to learn the sender.

> **⚠ Disclosure — what sealed sender does and does not protect.**
> **Protects:** there is no plaintext sender field on the wire or in the at-rest
> message queue; ciphertext size is normalized (§7.2).
> **Does NOT protect:** the client socket is authenticated to the relay via
> challenge-response (§9), so a malicious or compelled relay that correlates the
> authenticated live connection with the `to` field can still observe the
> sender→recipient relationship at send time. Sealed sender here primarily
> protects metadata **at rest** and removes `from` from the payload; it is not a
> defense against an actively-correlating relay or a network-level observer.
> This matches the limitation Signal documents for its own sealed sender.

### 7.4 Encrypted attachments

Attachments (`mobile/src/crypto/media.ts`) never reach the relay in plaintext:

- Each file is encrypted client-side under a **fresh random per-file key**
  (32-byte key, 24-byte nonce) with `nacl.secretbox` (XSalsa20-Poly1305).
- Only the **ciphertext blob** is uploaded to the relay's generic blob store,
  which holds opaque bytes with a 24-hour TTL.
- The per-file key and nonce are **not** sent to the relay. They travel inside
  the E2EE message as a reference string `blob:<id>:<keyB64>:<nonceB64>`, which
  is itself carried by the Double Ratchet — so the relay sees an opaque blob and
  never the key that decrypts it.
- Plaintext is decrypted **on demand** into a purgeable cache directory; at-rest
  media is always the secretbox ciphertext, and the cache is purged on
  panic/logout and after time in background (`purgeCachedDecryptedMedia`).
- A strict MIME allow-list and a 50 MB size cap are enforced before upload.

### 7.5 Encrypted backups

Backups (`mobile/src/crypto/backup.ts`, `.aegisbak`) are encrypted client-side
with a key derived from a user passphrase the relay never sees:

- **Current format (v3): Argon2id**, m = 64 MiB, t = 3, p = 1, 32-byte key
  (RFC 9106 §4 memory-constrained profile). Argon2id's memory-hardness collapses
  GPU/ASIC parallelism — important because the backup contains the user's
  **private identity key**.
- Symmetric cipher: `nacl.secretbox` (XSalsa20-Poly1305), authenticated, so a
  wrong passphrase fails with an explicit MAC error rather than garbage output.
- Only salt, nonce and ciphertext are stored; the passphrase never touches disk.
  Minimum passphrase length 12.
- Legacy envelopes (v1/v2, PBKDF2-HMAC-SHA256 at 100k/600k iterations) remain
  *decryptable* for restore, but all new backups are written as v3.

> **⚠ Disclosure — KDF parameters are implied by version, not stored.**
> The v3 Argon2id parameters are fixed by the envelope version rather than
> embedded, so they cannot be tuned without a version bump (changing them would
> break decryption of existing v3 backups). On Hermes (no JIT) a v3 derivation
> takes on the order of minutes; the UI runs it async behind a progress
> indicator. This is a deliberate cost choice, not an accident.

### 7.6 Panic wipe and profile isolation

- **Panic mode** performs an instant local wipe, with an optional **decoy
  profile** for coerced-unlock scenarios.
- **Multiple profiles** are cryptographically isolated: each has its own
  identity and its own SecureStore slot, and a non-primary profile never reads
  the primary's keys (`signSecretKeySlot` per-profile derivation).

> These are coercion/forensic mitigations, **not** cryptographic guarantees
> against a fully compromised, unlocked endpoint (see §8.3).

---

## 8. Threat model

### 8.1 Adversary capabilities assumed

- **Malicious relay (honest-but-curious or actively malicious).** Can read,
  drop, reorder, replay and inject anything on the wire; can substitute prekey
  bundles and ratchet public keys; knows the recipient `to` of every envelope
  and the authenticated identity of every connected socket.

### 8.2 What the protocol defends against

| Attack | Defense |
|---|---|
| Reading message content | E2EE: inner Double Ratchet + outer box; relay holds only opaque ciphertext |
| SPK substitution / handshake MITM | Mandatory Ed25519 verification of the Signed PreKey before any DH |
| Low-order / identity point injection (forced known key) | All-zero DH rejection at every X3DH and ratchet DH step |
| Ratchet desynchronization via forged ciphertext | Transactional clone→commit/discard decryption; keys consumed only on auth |
| Skipped-key exhaustion | `MAX_SKIPPED_KEYS = 50` cap with lowest-`n` eviction |
| Content-length leakage | Fixed-bucket padding before encryption |
| Plaintext sender metadata on the wire / in the queue | No `from` on the wire; sender not stored in offline queue (§7.3) |
| Key recovery from device memory | Zeroization of message/chain/root keys and discarded clones |
| Registration-time PII collection | No phone/email/name; identity is an on-device keypair |

### 8.3 What the protocol does NOT defend against (explicit)

- **Traffic analysis / global passive adversary.** Timing and volume correlation
  across the relay are out of scope.
- **Real-time sender↔recipient correlation by the relay** (§7.3).
- **Endpoint compromise.** Malware or a physically compromised, unlocked device
  with the keystore unsealed can read plaintext. Panic-wipe and decoy modes
  mitigate coercion scenarios but are not cryptographic defenses.
- **Post-quantum adversaries in mixed-version sessions.** v2↔v2 sessions are
  hybrid-protected (§4.4); a session that falls back to v1 (peer not yet upgraded,
  or desktop) is classical X25519 only and remains store-now-decrypt-later
  exposed until both ends are v2 — see §10.
- **Cross-domain key-separation concerns** from the shared X25519/Ed25519 secret
  (§3.1).
- **Runtime-level timing side-channels in the JS crypto core.** Constant-time is
  guaranteed at the source level (TweetNaCl/`@noble`) but not machine-verified
  through the Hermes/V8 JIT+GC (§2.1). Practical exploitation requires a local
  co-resident oracle, which already implies endpoint compromise. Mitigation
  (native libsodium binding) is on the roadmap (§10, F-1).

---

## 9. Transport and authentication (summary)

- Clients connect to the relay over a Socket.IO channel.
- Sockets authenticate by **challenge-response over the identity key** (relay
  issues a challenge, client signs; see `server/src/auth/challenge.ts`), so the
  relay binds a live connection to an Aegis ID without the client ever
  transmitting a secret.
- Envelopes are validated against strict Zod schemas (length-bounded fields,
  Aegis-ID regex routing addresses); oversize or malformed envelopes are
  rejected.
- The relay is AGPL-3.0 and self-hostable; it is designed to store the minimum
  needed to route and queue ciphertext and to hold no plaintext sender or
  content.

> A full write-up of the relay's storage model, push wake-up (encrypted payload
> only), WebRTC signaling relay and rate limiting is maintained separately; this
> section summarizes only the parts that bear on the cryptographic threat model.

---

## 10. Known limitations and roadmap

The following are **not implemented** and are honestly out of scope of the
current protocol:

1. **Post-quantum hybrid handshake** (PQXDH-style, X25519 + ML-KEM-768) —
   **implemented** for the mobile client and relay (§4.4, handshake v2).
   Remaining: (a) wire the **desktop** client to v2 (it is still v1), (b) extend
   v2 to the multi-device self-copy path, and (c) flip the receiver gate to
   strict "PQ-mandatory" once the whole fleet is v2.
2. **Domain-separated identity keys** to remove the shared X25519/Ed25519 secret
   scalar (§3.1).
3. **Stronger sender anonymity** against an actively-correlating relay (e.g.
   decoupling the authenticated transport identity from message routing).
4. **Independent third-party cryptographic audit** of this protocol and its
   implementation, with full public disclosure of findings. **No independent
   audit has been performed.** This is the project's top funding priority.
5. **Native crypto core** (post-audit follow-up **F-1**). Move the hot-path
   primitives behind a native libsodium binding so the constant-time guarantee is
   enforced in native code rather than source-level JS on Hermes/V8 (§2.1). This
   is implementation substitution behind a stable TypeScript interface, not a
   protocol change.

---

## 11. Source map

All cryptography is implemented in the clients and mirrored across platforms:
the mobile client under `mobile/src/crypto/` and the desktop client under
`desktop/src/renderer/crypto/` share the same protocol so the two interoperate.
File references below are to the mobile client.

| Component | File |
|---|---|
| Identity, Aegis ID, key derivation | `mobile/src/crypto/identity.ts` |
| Fingerprint verification | `mobile/src/crypto/fingerprint.ts` |
| QR contact exchange | `mobile/src/crypto/qr.ts` |
| X3DH | `mobile/src/crypto/signal/x3dh.ts` |
| Double Ratchet | `mobile/src/crypto/signal/ratchet.ts` |
| KDF / HMAC wrappers | `mobile/src/crypto/signal/kdf.ts` |
| Message envelope (two layers) | `mobile/src/crypto/messaging.ts` |
| Metadata strip + padding | `mobile/src/crypto/metadata.ts` |
| Encrypted attachments | `mobile/src/crypto/media.ts` |
| Encrypted backups (Argon2id) | `mobile/src/crypto/backup.ts` |
| Desktop client crypto (parity) | `desktop/src/renderer/crypto/` |
| Relay envelope / sealed-sender wire format | `server/src/relay/handler.ts` |
| Challenge-response auth | `server/src/auth/challenge.ts` |

---

*This document is part of the AegisLink open-source project (clients GPL-3.0,
relay AGPL-3.0). Corrections and audit findings are welcome via the channels in
[`SECURITY.md`](../SECURITY.md).*
