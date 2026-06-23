---
title: "How AegisLink's handshake survives a quantum computer (X3DH + ML-KEM-768)"
published: false
tags: cryptography, privacy, opensource, security
series: "AegisLog"
canonical_url:
---

In my first post in this series I said the next one would go deep on the
handshake. This is it. If you've ever wondered what actually happens in the
half-second before two strangers can exchange an encrypted message, read on. As
always: this is **pre-release, unaudited** — the point of writing it down is so
you can check it.

## The job of a handshake

Before any messages flow, two devices that have never talked need to agree on a
shared secret — over a relay that sees everything and is assumed hostile. The
relay can drop, reorder, replay, and inject traffic, and it can try to swap the
keys it hands you. The handshake has to produce the same secret on both sides
*and* detect tampering.

AegisLink uses **X3DH** (the Signal construction) for this, then adds a
post-quantum layer on top. Let's take them in order.

## Part 1: classical X3DH

Each user has a long-term **Ed25519** signing key and **X25519** Diffie-Hellman
keys. To receive messages, Bob publishes a *prekey bundle*:

- his identity key,
- a **signed prekey** (X25519, signed with his Ed25519 identity key),
- optionally a **one-time prekey** (consumed once, then gone).

Alice fetches Bob's bundle and does the critical first step: **she verifies the
Ed25519 signature on the signed prekey before doing anything else.** If it
doesn't check out, she aborts. This is what closes the classic
prekey-substitution MITM — a malicious relay can hand Alice a fake prekey, but
it can't forge Bob's signature over it.

Then she runs the Diffie-Hellman ladder:

```
DH1 = DH(IK_A, SPK_B)
DH2 = DH(EK_A, IK_B)
DH3 = DH(EK_A, SPK_B)
DH4 = DH(EK_A, OPK_B)   // only if a one-time prekey was available
```

Every DH output is checked against all-zero and rejected if it matches — that's
the guard against low-order / identity-point injection, where an attacker tries
to force a known shared value.

The results are concatenated and run through a KDF:

```
SK = HKDF-SHA256( IKM = 0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4],
                  info = "AegisLinkX3DH" )
```

Bob, on receipt, mirrors the exact same DH order, the same zero-guards, and the
same HKDF parameters — so both sides land on an identical `SK` without ever
sending it.

## Part 2: making it quantum-resistant

X25519 is great today, but it falls to a large enough quantum computer. And the
threat isn't hypothetical-someday — it's **harvest now, decrypt later**: an
adversary records your encrypted traffic today and decrypts it in 2035. For a
privacy tool, that's the threat that matters.

So handshake **v2** adds **ML-KEM-768** (FIPS 203, the standardized Kyber) *on
top of* X3DH — it does not replace it. Bob publishes one more prekey: a **signed
PQ prekey (PQSPK)**, an ML-KEM-768 public key signed by his identity key, just
like the classical one.

Alice, after finishing classical X3DH:

1. encapsulates against Bob's PQ prekey: `(ct, ss) = ML-KEM-768.encapsulate(PQSPK_B)`
2. appends the 32-byte ML-KEM secret `ss` to the classical material:

   ```
   SK = HKDF-SHA256( IKM = 0xFF×32 ‖ DH1 ‖ DH2 ‖ DH3 [‖ DH4] ‖ ss,
                     info = "AegisLinkPQXDH" )
   ```

3. sends the 1088-byte ML-KEM ciphertext `ct` **inside the sealed message**,
   never as a field the relay can see.

Bob decapsulates `ss = ML-KEM-768.decapsulate(ct, PQSPK_secret_B)` and derives
the identical `SK`.

The payoff is the "hybrid" property: **breaking a v2 session requires breaking
both X25519 and ML-KEM-768.** A future quantum attacker who cracks the elliptic
curve still hits a wall at the lattice, and a classical attacker who finds a flaw
in the (newer, less battle-tested) lattice scheme still hits the curve. You only
lose if both fall.

## One subtle bit: implicit rejection

ML-KEM uses implicit rejection (per FIPS 203): feed it a tampered ciphertext and
it doesn't throw an error — it returns a *different* shared secret. That's by
design. In our handshake it means a tampered `ct` simply yields a different `SK`,
and the first real message fails to decrypt, rather than leaking a
distinguishable "decapsulation failed" signal.

## Where to look

It's all in the open — the X3DH implementation lives in
`mobile/src/crypto/signal/x3dh.ts`, and the full spec (with the threat model and
the parts that are still in progress) is in
[docs/PROTOCOL.md](https://github.com/gabinotech22-cmyk/AegisLink/blob/main/docs/PROTOCOL.md).

Repo: https://github.com/gabinotech22-cmyk/AegisLink

If you spot a mistake in the construction above — wrong, weak, or just unclear —
that's exactly the feedback I'm after. Next in the series: how the Double Ratchet
takes over once this handshake hands off the first key.
