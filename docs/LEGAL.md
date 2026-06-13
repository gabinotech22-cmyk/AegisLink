# Legal Requests & Transparency

**What AegisLink can — and cannot — produce in response to a legal order.**

This page exists so that users, journalists and authorities all know the answer *before* anyone asks. It is written from the system's architecture, which is open source and independently verifiable: the honest answer to most requests is that **the data does not exist**, not that we refuse to hand it over.

## The short version

AegisLink is designed so that the operator holds as close to nothing as possible. We cannot decrypt messages, we do not know users' names, phone numbers or email addresses (we never collect them), and we do not keep logs of who talks to whom, when, or how often. A subpoena cannot compel us to produce records that were never created.

## What we do NOT have

| Commonly requested | Our answer |
|---|---|
| User's real name, phone number, email | **Never collected.** Registration creates a keypair on the user's device; no personal data is requested at any point. |
| Message content | **Cannot decrypt.** All messages are end-to-end encrypted (X3DH + Double Ratchet); private keys exist only on user devices. |
| Attachments, voice/video call content | **Cannot decrypt.** Attachments are encrypted client-side; calls are peer-to-peer with DTLS-SRTP, and call signaling is sealed before it reaches the relay. |
| Contact lists / social graph | **Not stored.** Contacts live only on the user's device. The relay routes individual encrypted envelopes and keeps no record of relationships. |
| Message history | **Not stored.** The relay queues an encrypted message only until it is delivered, then deletes it. |
| Access logs, IP logs, login timestamps | **Not logged**, by configuration and by design (`access_log off`; the application keeps no per-user access records). |
| Message frequency / traffic analysis records | **Not stored.** Additionally, messages are padded to fixed size buckets, so even stored ciphertexts leak minimal information. |
| Location data | **Never collected.** The app does not request location permissions. |
| Payment information | **Not applicable.** No accounts, no billing data tied to identities. |

## What we DO have (complete list)

Being honest about the residue matters more than a clean marketing claim:

1. **Public key material**: identity public keys, signed prekeys and one-time prekeys published by devices so others can initiate encrypted sessions. This is public-by-design cryptographic material.
2. **Undelivered encrypted envelopes**: opaque ciphertexts queued for offline recipients, deleted on delivery. We cannot read them.
3. **Push tokens**: an FCM/APNs token per device that wants wake-up notifications. The push payload never contains content or sender identity — it is a generic "wake up". The token is held by Google/Apple infrastructure as with any app that uses push.
4. **Transient connection data**: like any Internet server, the relay sees the IP address of a connected client *at the moment of connection*. We do not log it or associate it with identities. Users whose threat model includes network-level observation should connect through Tor or a VPN.

## Our commitments

- We will never add a backdoor, key escrow, or client-side scanning. The clients are GPL-3.0 and the relay is AGPL-3.0 — a modified server must publish its source, and the protocol treats the server as untrusted anyway: even a fully malicious relay cannot read messages or forge identities (see [PROTOCOL.md](PROTOCOL.md), threat model).
- We will respond to valid legal process with what exists — which is the list above — and will not fabricate capabilities we do not have.
- Where legally permitted, we will notify affected users of requests concerning them and publish aggregate statistics about requests received.
- If we are ever legally compelled to change any of the above, we will say so to the maximum extent the law allows. The strongest guarantee, however, is structural: **anyone can self-host the relay** and be subject to no operator at all.

## Verify, don't trust

Every claim on this page is checkable in the source code: the relay (`server/`), the metadata-stripping and padding layer (`mobile/src/crypto/metadata.ts`), and the protocol document ([PROTOCOL.md](PROTOCOL.md)). If you find a discrepancy between this page and the code, that is a security issue — please report it via [SECURITY.md](../SECURITY.md).

*Contact for legal process: gabinotech22@gmail.com*
