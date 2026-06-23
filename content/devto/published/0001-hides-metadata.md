---
title: "Building a messenger that hides metadata, not just messages"
published: false
tags: privacy, cryptography, opensource, security
series: "AegisLog"
canonical_url:
---

Most "encrypted" apps protect *what* you say. They do far less about *who you
talk to, when, and how often* — the metadata. And metadata is often the part
that actually gets people in trouble.

I'm building **AegisLink**, an open-source end-to-end encrypted messenger, with
that as the central obsession. This is the first post in a build-in-public
series. Everything here is **pre-release and has had no independent audit yet**,
so treat it as claims to verify — not promises. That's exactly why the code and
protocol are public.

## The threat I actually care about

End-to-end encryption is table stakes now. The interesting question is what the
*server* learns even when it can't read your messages:

- who is talking to whom
- when, and how often
- from which IP, on which device
- message and attachment sizes

A server that logs those can reconstruct your entire social graph without ever
decrypting a word. So the design rule for AegisLink's relay is simple: **know as
little as possible.**

## How that translates into code

- **No account.** No email, no phone, no name. Identity is generated on-device
  (Ed25519 + X25519); your address is a random ID.
- **Dumb relay.** It forwards opaque ciphertext and keeps no logs of who
  messages whom — no IPs, no access timestamps, no message sizes.
- **Modern crypto.** Double Ratchet + X3DH, with a hybrid post-quantum layer
  (PQXDH). Private keys never leave the device.
- **Sealed signaling for calls.** WebRTC SDP/ICE is sealed with NaCl box before
  it reaches the relay, so the server never sees IPs or DTLS fingerprints.
- **Encrypted at rest.** The local DB is encrypted (SQLCipher); backups use an
  Argon2id-derived key only the user holds.

## What's NOT done yet

Being honest is the whole point of doing this in the open:

- **Transport-level sealed-sender** — hiding the sender from the relay *process
  itself* — is in active development, not shipped.
- **No third-party audit** has happened. The protocol and threat model are in
  the repo precisely so people who know more than me can check the work.

## Follow along / tear it apart

Code, protocol docs and threat model:
https://github.com/gabinotech22-cmyk/AegisLink

Next post I'll go deep on one piece — the X3DH/PQXDH handshake. If there's
something you'd rather I break down, tell me in the comments.
