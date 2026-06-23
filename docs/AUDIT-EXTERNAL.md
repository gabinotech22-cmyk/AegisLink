# External security audit — application package

Draft request materials for a **professional, fund-sponsored** security audit of
AegisLink. Two complementary sponsors are targeted (apply to both — they fund
different things and review on different cadences):

- **OTF Security Lab** (Open Technology Fund) — Red Team Lab / security audit
  service for public-interest tech. Rolling intake.
  <https://www.opentech.fund/labs/security-lab/>
- **OSTIF** (Open Source Technology Improvement Fund) — managed audits with
  vetted firms (e.g. Trail of Bits, X41, 7ASecurity, Quarkslab).
  <https://ostif.org/>

> **Status / what's blocking submission.** Everything in this document is
> complete and current **except two fields that are the maintainer's to fill**:
> the **budget figure** (§7) and the **applicant signature / contact of record**
> (§9). The technical spec, threat model, and the in-tree evidence (SAST,
> fuzzing) referenced below are already live. This is not a code task.

---

## 1. One-paragraph summary

AegisLink is an open-source, end-to-end-encrypted, **metadata-minimizing**
messenger (mobile + desktop) built on the Signal protocol family — X3DH +
Double Ratchet, hardened with a **hybrid post-quantum** key agreement (PQXDH,
X25519 + ML-KEM) — with **sealed-sender** transport so the relay never sees who
talks to whom. Registration is anonymous (no email, no phone, no real name).
The cryptography is fully in-repo and auditable; no proprietary backend. We are
requesting an independent audit of the cryptographic core, the client↔relay
protocol, and the at-rest storage model.

## 2. What we want audited (scope)

Priority order, highest first:

1. **Double Ratchet + X3DH/PQXDH implementation** — `mobile/src/crypto/signal/`,
   PQ hybrid in `mobile/src/crypto/` and the desktop port. Focus: ratchet state
   transactionality (no desync on forged ciphertext), constant-time secret
   comparisons, zeroization of DH/ephemeral/shared secrets, downgrade
   resistance of the v1↔v2 (PQ) negotiation.
2. **Sealed-sender transport & relay** — `server/`, `docs/SEALED-SENDER-ARCHITECTURE.md`.
   Focus: no `from` leakage to the relay, signaling (SDP/ICE) encrypted to the
   recipient pubkey, challenge-response socket auth, server-derived trust
   identifiers (no client-supplied `voterHash`/dedup keys).
3. **At-rest storage** — SQLCipher full-DB encryption, key derivation, fail-closed
   behavior in packaged builds (no `plain:` fallback), panic-wipe.
4. **Untrusted-input parsers** — already fuzzed (see §5); audit for logic flaws
   beyond crashes.
5. **Mobile↔desktop parity** — same locks/guards/fallbacks on both clients.

Out of scope (for this round): marketing site, Web3/DID optional identity, CI.

## 3. Threat model (summary)

- **Adversary:** a malicious or compromised relay + a network global passive
  observer + a malicious authenticated peer. Not in scope: a fully compromised
  endpoint with root (we document, not defend, that case).
- **Non-negotiable invariants** (each has bitten us once and is now a project
  golden rule — see `CLAUDE.md` and `docs/SECURITY-ROADMAP-2026-06.md`):
  encryption never degrades silently; zero key material on the wire; crypto auth
  on every sensitive endpoint; sealed-sender everywhere incl. calls; production
  fails closed; trust derived server-side; constant-time secret compares;
  intermediate key zeroization; at-rest metadata minimization.

## 4. Project facts (for the application form)

| Field | Value |
|-------|-------|
| Repository | <https://github.com/gabinotech22-cmyk/AegisLink> (public) |
| License | GPL / AGPL (copyleft, fully open) |
| Language / stack | TypeScript (strict). Expo SDK 54 + React Native (mobile), Electron (desktop), Node/Bun relay |
| Crypto libs | TweetNaCl, @noble/hashes, @noble/post-quantum |
| Protocol spec | `docs/PROTOCOL.md` (current, incl. PQXDH) |
| Architecture | `docs/SEALED-SENDER-ARCHITECTURE.md` |
| LOC (approx, fill before submit) | _TODO: `cloc mobile/src server/src desktop/src`_ |
| Patent posture | Member of the Open Invention Network (royalty-free cross-license) |
| Prior audit | None external yet (this is the first) |
| Maintainer | solo maintainer, AI-assisted, all crypto human-reviewed |

## 5. Evidence we already have (strengthens the application)

A funded audit goes further when the cheap, automatable assurance is already in
place. It is:

- **SAST in CI** — CodeQL (`security-extended`) + Semgrep, with our golden rules
  encoded as custom Semgrep rules. Caught 4 real bugs pre-production
  (silent `plain:` DB key, QR `URIError` crash, contact→`<img src>` XSS/IP-leak).
- **Continuous fuzzing** — structure-aware parser fuzz campaign as an always-on
  CI gate (`mobile/src/fuzz/`), plus **OSS-Fuzz integration** (`infra/oss-fuzz/`)
  for coverage-guided fuzzing of every untrusted-input parser and the ratchet
  inner-payload deserializer.
- **Regression discipline** — one regression test per security fix (project rule).
- **Reference designs** — we track Signal and SimpleX for privacy/crypto
  decisions and cite them in commits.

## 6. References for the reviewers

- `docs/PROTOCOL.md`, `docs/SEALED-SENDER-ARCHITECTURE.md`,
  `docs/SECURITY-ROADMAP-2026-06.md`
- `CLAUDE.md` → the two non-negotiable security golden-rule sections
- `SECURITY.md` (disclosure policy + contact)

## 7. Budget — **MAINTAINER TO FILL**

> _OTF Security Lab is a service (you request hours, not cash). OSTIF manages a
> firm and a fixed engagement budget. Provide:_
>
> - Requested engagement size / hours or USD figure: **_TODO_**
> - Justification (scope §2, ~LOC, dual-platform crypto): **_TODO_**

## 8. Suggested timeline

| Milestone | When |
|-----------|------|
| Submit OTF Security Lab request | _TODO_ |
| Submit OSTIF intake | _TODO_ |
| Freeze a tagged commit for audit | on acceptance |
| Remediation + public report | per sponsor process |

## 9. Applicant of record — **MAINTAINER TO FILL**

- Name / handle: **_TODO_**
- Contact email: gabinotech22+security@gmail.com (or per `SECURITY.md`)
- Confirmation we'll publish the full report: **_yes / no — TODO_**

---

_This is a working draft kept in-tree. Update §4 LOC, §7 budget, §8 dates, and
§9 before submitting to either sponsor._
