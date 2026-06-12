# The AegisLink Protocol

**Version 1.0 — June 2026**

This document describes the cryptographic protocol implemented by AegisLink, an end-to-end encrypted messenger designed around one principle: **the server must learn nothing it could be forced to hand over.** Everything described here is implemented in the open-source clients (`mobile/src/crypto/`, `desktop/src/renderer/crypto/`) and is auditable by anyone.

AegisLink follows the Signal protocol family — X3DH for asynchronous key agreement and the Double Ratchet for ongoing message encryption — built on well-reviewed primitives (TweetNaCl: X25519, Ed25519, XSalsa20-Poly1305; HKDF/HMAC over SHA-256 via `@noble/hashes`). Where we deviate from the Signal specification, the deviation and its rationale are stated explicitly in §7.

---

## 1. Design goals and non-goals

**Goals**

1. **Confidentiality and integrity** of message content against the relay server, network observers, and anyone who compromises the relay.
2. **Forward secrecy and post-compromise security** for established conversations (Double Ratchet).
3. **No identity collection.** Registration requires no phone number, email, or name. An identity is a keypair generated on-device.
4. **Metadata minimization at the protocol layer**, not just by server policy: padded message sizes, stripped client timestamps, allow-listed payload fields.
5. **Keys never leave the device.** Private keys live in the OS secure storage (Keychain / Keystore via `expo-secure-store` on mobile; `safeStorage` on desktop).

**Non-goals (current version)**

- Hiding *that* a given Aegis ID communicates with the relay (no built-in onion routing; users who need network-level anonymity should reach the relay over Tor/VPN).
- Protection against a fully compromised endpoint device.

## 2. Identity

An AegisLink identity is generated entirely on-device (`identity.ts`):

- An **X25519 keypair** (`nacl.box.keyPair()`) — the long-term identity key *IK*, used in Diffie-Hellman operations.
- An **Ed25519 signing keypair**, derived deterministically from the X25519 secret via `nacl.sign.keyPair.fromSeed(secretKey)`. This means a single 32-byte seed (representable as a mnemonic word list) fully restores the identity.
- The public, human-shareable **Aegis ID**: the first 7 bytes of the X25519 public key, Crockford-Base32 encoded as `XXX-XXXX-XXXX`. It is a fingerprint prefix, not an account name — there is nothing to "register" and no namespace the server controls.

Contact verification uses full-key fingerprints (`fingerprint.ts`), comparable out-of-band or via QR code (`qr.ts`).

## 3. Session establishment — X3DH

Asynchronous key agreement follows the X3DH pattern (`signal/x3dh.ts`). Each device publishes to the relay a prekey bundle: identity key, a **signed prekey (SPK)** signed with the Ed25519 identity signing key, and a batch of 100 **one-time prekeys (OPKs)**.

To initiate a session with Bob, Alice:

1. **Verifies the SPK signature first.** The Ed25519 signature over the SPK is checked against Bob's signing key *before any DH operation*. A relay that substitutes the SPK cannot man-in-the-middle the handshake.
2. Generates an ephemeral X25519 keypair *EK*.
3. Computes `DH1 = DH(IK_A, SPK_B)`, `DH2 = DH(EK_A, IK_B)`, `DH3 = DH(EK_A, SPK_B)`, and `DH4 = DH(EK_A, OPK_B)` when a one-time prekey is available.
4. Derives the root key as `HKDF-SHA256(0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4], salt = 0x00×32, info = "AegisLinkX3DH")`.

**Low-order point defense.** `nacl.scalarMult` silently returns an all-zero output when fed a low-order public point — which would let a malicious relay force a known shared secret. Every DH output in X3DH *and* in the ratchet is checked and the handshake aborts on an all-zero result (`assertNonZeroDH`).

**Prekey consistency.** All registration paths obtain the device prekey set through a single serialized entry point (`ensureDevicePreKeys`): secrets are durably persisted and read back *before* the public bundle may be published, and public keys are always re-derived from the stored secrets. The bundle on the relay therefore always corresponds to secrets the device can actually use — eliminating a class of "ghost session" desyncs.

## 4. Message encryption — Double Ratchet

Established sessions use a Double Ratchet (`signal/ratchet.ts`) per the Signal design:

- **DH ratchet** on X25519, advancing the root key (`HKDF`, info = `"AegisLinkRoot"`) whenever the peer's ratchet key changes. Ratchet public keys arrive unsigned off the wire, so the same all-zero-DH guard applies at every step.
- **Symmetric-key ratchet**: message keys and next chain keys derived via HMAC-SHA256 with distinct constants (0x01 / 0x02).
- **Out-of-order delivery** is handled with skipped-message keys, hard-capped at **50 retained keys** (vs. Signal's default 2000) to shrink the window of past messages decryptable if the device database were ever recovered. Evicted and consumed keys are zeroized in memory. An additional age-based trim (`trimOldSkippedKeys`) actively shrinks this window during inactivity.
- Ratchet state updates are applied **transactionally** with message persistence, so a crash cannot leave the chain key ahead of (or behind) the stored conversation.

The first messages of a session carry the X3DH initialization data (Alice's ephemeral key, SPK/OPK ids) so Bob can derive the same root key on first contact. A session-creation grace period prevents a stale in-flight message on a previous session from tearing down a freshly negotiated one (desync recovery).

## 5. Metadata protection

The relay is designed to be *unable* to log what it never receives (`metadata.ts`):

- **Field allow-list.** Outgoing encrypted payloads may contain only `v, from, senderPubB64, ratchet, x3dh, pad`. Anything else — including client-side timestamps and counters — is stripped before encryption.
- **Length bucketing.** Every plaintext is padded with random bytes to a fixed bucket size (powers of two from 256 B to 64 KB, plus 256 KB / 1 MB / 4 MB tiers for attachments). On the wire, a "hi" and a paragraph are indistinguishable.
- **Encrypted attachments** (`media.ts`) are encrypted client-side before upload; the relay stores opaque blobs.
- The relay holds messages only until delivery, authenticates devices via an Ed25519 challenge-response (no passwords, no recoverable credentials), and keeps no message-frequency or social-graph records by design.

## 6. Key storage, backup, and panic

- Private keys are stored in platform secure storage; the message database is local (SQLite).
- **Backups** are encrypted client-side with a key derived from a user passphrase via a memory-hard KDF (Argon2id); the backup is useless without the passphrase, which AegisLink never sees.
- **Panic mode** performs instant local wipe with an optional decoy profile; multiple profiles are cryptographically isolated (separate identities, separate storage slots).

## 7. Deviations from the Signal specification

Honest disclosure of where we differ, and why:

| Deviation | Rationale / trade-off |
|---|---|
| Ed25519 signing key derived from the X25519 identity secret (single seed) | Enables full identity recovery from one mnemonic. Trade-off: the two long-term keys are not independent; compromise of the seed compromises both (as it would in practice anyway, since both live in the same secure store). |
| `MAX_SKIPPED_KEYS = 50` (Signal: 2000) | Smaller post-compromise decryption window. Cost: >50 missed messages on one chain are unrecoverable. |
| One prekey-bundle fetch per contact establishment; sessions are per-identity rather than per-device-session-id | Simpler relay with less addressable metadata. |
| JSON + Base64 wire encoding instead of protobuf | Auditability and debuggability; size overhead is absorbed by padding buckets anyway. |

## 8. Threat model summary

| Adversary | Outcome |
|---|---|
| Passive network observer | Sees TLS to the relay; padded, uniform ciphertext sizes; no plaintext metadata. |
| Malicious / compromised relay | Cannot read content, cannot MITM (SPK signatures + zero-DH guards), cannot learn message lengths beyond bucket tier; learns delivery timing and which queue IDs talk to it. |
| Legal compulsion of the operator | Nothing to produce beyond undelivered opaque ciphertexts: no names, emails, phone numbers, IP logs, or social graph. |
| Seizure of an unlocked device | Out of scope (as for all messengers); panic wipe and decoy profiles mitigate coerced-unlock scenarios. |
| Quantum adversary (future) | X25519 is not post-quantum; a PQ hybrid (à la PQXDH) is on the roadmap. |

## 9. Open questions and roadmap

- Post-quantum hybrid key agreement (PQXDH-style) for X3DH.
- Sealed-sender-style hiding of the `from` field from the relay.
- Reproducible builds (in progress for F-Droid submission).
- **Independent audit**: we are seeking funding for a third-party cryptographic audit. Findings will be published in full.

*Questions, analysis, and attacks on this design are welcome — open an issue or see [SECURITY.md](../SECURITY.md) for responsible disclosure.*
