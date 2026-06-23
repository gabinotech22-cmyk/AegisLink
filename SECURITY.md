# Security Policy

AegisLink's value rests entirely on its security properties. If you believe
you have found a vulnerability, we want to know — and we will treat your
report seriously and credit you if you wish.

## Reporting a vulnerability

- **Email:** gabinotech22+security@gmail.com
- Please include: affected component (`mobile/`, `server/`, protocol design),
  steps to reproduce or a proof of concept, and the impact as you understand it.
- You will receive an acknowledgement within **72 hours**.

Please use **coordinated disclosure**: give us up to **90 days** to ship a fix
before publishing details. We will keep you informed of progress and agree on
a publication date together.

You can also report privately via GitHub's **"Report a vulnerability"** button
on the Security tab. Our internal handling process (triage, SLAs, fix, CVE/GHSA)
is documented in [`docs/SECURITY-RESPONSE.md`](docs/SECURITY-RESPONSE.md).

## Scope

In scope:

- Cryptographic design and implementation (Double Ratchet, X3DH, sealed
  signaling, encrypted backups, attachment encryption).
- The relay server: anything that lets the server learn message content,
  social-graph metadata, or impersonate users.
- The mobile app: key extraction, lock-screen bypass, panic-mode bypass,
  message disclosure.

Out of scope:

- Denial of service against the public relay.
- Attacks requiring a rooted/jailbroken device or physical access to an
  unlocked phone.
- Social engineering.

## No warranty — pre-release software

AegisLink has **not yet undergone an independent security audit**. The code is
published precisely so it can be reviewed. Until a formal audit is completed,
treat the software accordingly.
