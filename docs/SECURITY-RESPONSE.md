# Internal vulnerability response runbook

This is the **internal** process for handling a security report from intake to
public disclosure. The **external-facing** policy (how to report, scope, what
reporters can expect) lives in [`SECURITY.md`](../SECURITY.md). This document
exists so response is a repeatable process, not an improvisation — OSTIF
best-practices step 3 ("internal vulnerability response policies").

## Designated handler

The maintainer is the sole designated security handler. Reports arrive through
two channels, both monitored:

1. **GitHub Private Vulnerability Reporting** (Security tab → Report a
   vulnerability) — preferred; keeps the report and discussion private in a
   GitHub Security Advisory (GHSA) draft.
2. **Email:** `gabinotech22+security@gmail.com` (per `SECURITY.md`).

## Service levels

| Stage | Target |
|-------|--------|
| Acknowledge receipt | within **72 hours** |
| Initial severity triage | within **5 days** of acknowledgement |
| Fix for Critical/High | prioritized over feature work; aim ≤ **30 days** |
| Coordinated disclosure window | up to **90 days** before public details |

## Severity rubric

Severity follows impact against the project's threat model
(`docs/AUDIT-EXTERNAL.md` §3): a malicious/compromised relay, a global passive
network observer, and a malicious authenticated peer.

- 🔴 **Critical** — breaks a non-negotiable invariant: plaintext/key material
  exposed to the relay or on the wire, silent crypto downgrade, ratchet desync
  on forged ciphertext, at-rest key written in clear, auth bypass on a
  sensitive endpoint.
- 🟠 **High** — metadata deanonymization (sender/recipient correlation beyond
  the documented limitation), panic-mode/lock-screen bypass, key extraction
  needing only logical (non-root) access.
- 🟡 **Medium** — DoS of a single session, information leak not covered by the
  threat model, weakening that requires an unlikely precondition.
- 🔵 **Low** — defense-in-depth gaps, hardening, issues already out of scope in
  `SECURITY.md` (DoS on the public relay, rooted device, social engineering).

## Response flow

1. **Acknowledge** the reporter (≤ 72 h) and open a private GHSA draft if the
   report came by email.
2. **Reproduce** and write a **failing regression test first** — project golden
   rule: every security fix ships with a regression test. The test encodes the
   vulnerability and must fail before the fix.
3. **Assess severity** with the rubric above. For Critical/High, treat any
   public push as blocked until fixed (the security roadmap already treats
   criticals as push-blockers).
4. **Fix on a private branch.** Port the fix to **both** clients in the same
   change if it touches crypto/session/ratchet — mobile↔desktop parity is a
   golden rule. Keep the same locks, guards, and fail-closed behavior.
5. **Verify:** the new regression test passes; the existing SAST (CodeQL +
   Semgrep golden-rule pack) and parser-fuzz gates are green; relevant
   crypto/IPC/serialization suites pass on both platforms.
6. **Coordinate disclosure** with the reporter — agree a publication date
   within the 90-day window; credit them unless they decline.
7. **Release** the fix, then **publish the GHSA** and request a **CVE** through
   GitHub's advisory flow for Medium+ severity. Reference the advisory in the
   fixing commit/PR.
8. **Backfill the knowledgebase:** record the finding and remediation in the
   security roadmap, and add/refresh any golden rule if the class of bug was
   new (the existing rules each exist because that failure was injected once).

## What we publish

We publish full advisories after a fix ships. AegisLink is open source and its
value rests on auditability — we disclose limitations openly (see
`docs/PROTOCOL.md` and its "⚠ Disclosure" sections) rather than hide them.
