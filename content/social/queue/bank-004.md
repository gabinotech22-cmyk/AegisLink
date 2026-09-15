# Bank 004 — Evergreen refill #2 (written 2026-09-13)

**Status:** deployed to the automated queues 2026-09-13 — Telegram
(`aegislink-social/social/queue/telegram-queue.json`, ids `bank004-l4-*`) and
Mastodon (`schedule-mastodon-bank-004.ps1`), cadence every 2 days
2026-10-08 → 2026-10-30. Every product claim below was verified against the
codebase before publishing (padding: `mobile/src/crypto/metadata.ts`; sealed
call signaling: `mobile/src/crypto/callSession.ts`; isolated profiles:
`mobile/src/store/profiles.ts`; public threat model: `SECURITY.md` Scope).
The `x:` variants remain a manual human gate.

Extends runway past bank-003 (which ends 2026-10-06). Same rule as bank-003:
deliberately **pillar 2/3/5/6 only** (education, hygiene, differentiation,
manifesto) — no pillar 1 (current events) or pillar 4 (build-in-public),
because both need real, current, checkable material and can't be pre-written
weeks ahead without going stale. Feed those in separately when there's real
news to react to or a real milestone to report.

All 12 angles are **new** — deduped against bank-001/002/003 (no repeats of:
Chat Control, phone-number signup, EXIF, QR-linked-device phishing, embedded
Tor, PQXDH, sealed-sender, contact sync, backups, app lock, link previews,
disappearing messages, self-host relay, anonymity-by-default, group keys,
funding, solo dev, audit meaning).

Suggested cadence: every 2 days, 17:00 UTC, starting 2026-10-08 (the slot
after bank-003's last item on 2026-10-06). Telegram reuses the `mastodon:`
copy, per convention.

---

## L4-1 (Pillar 2): forward secrecy — why a stolen key doesn't unlock your past

- [ ] Posted

**x:**
> If someone steals your key today, forward secrecy means they still can't read yesterday's messages. AegisLink's Double Ratchet rotates keys every message — the one that unlocks now is already gone by the next.

**mastodon:**
> A property people rarely ask about but should: forward secrecy. It answers "if my key is compromised today, what happens to everything I sent before?" Without it, one stolen key retroactively unlocks your entire history.
>
> AegisLink uses the Double Ratchet, which derives a fresh key for every single message and throws the old one away. Compromise the current key and you get, at most, the next message — not the archive.
>
> #privacy #infosec #e2ee

---

## L4-2 (Pillar 2): "is it secure?" is the wrong question — against whom?

- [ ] Posted

**x:**
> "Is this app secure?" has no answer without "against whom?" Secure against a stranger on your wifi is not the same as secure against someone who owns the network. A tool that skips the threat model is selling you a feeling.

**mastodon:**
> "Is X secure?" is the wrong question — security is always relative to a threat model. Secure against someone sniffing your coffee-shop wifi is a very different claim from secure against an adversary who controls the network, or who has your unlocked phone.
>
> AegisLink's threat model is public: what it defends against, and what it explicitly doesn't. A privacy tool that won't tell you where its guarantees stop is asking for trust it hasn't earned.
>
> #privacy #infosec #threatmodel

---

## L4-3 (Pillar 3): verify the safety number — it's the step that stops a MITM

- [ ] Posted

**x:**
> Encryption protects the channel. It can't tell you the person on the other end is who you think — that's what verifying a safety number / fingerprint does. Thirty seconds, once per contact, closes the machine-in-the-middle gap.

**mastodon:**
> The one manual step worth doing in any E2EE app: verify the safety number (fingerprint) with important contacts. Encryption guarantees nobody in the middle can read the channel — it does not, on its own, prove the key you're encrypting to belongs to your friend and not an impostor.
>
> Comparing that short code once, over a channel an attacker doesn't control, closes the machine-in-the-middle gap. Boring, quick, and the thing most people skip.
>
> #privacy #opsec #infosec

---

## L4-4 (Pillar 3): keep sensitive conversations in a separate, isolated profile

- [ ] Posted

**x:**
> Compartmentalize. Mixing your most sensitive contacts into the same profile as everything else means one glance at your screen exposes all of it. AegisLink supports fully isolated profiles — separate keys, separate data, no crossover.

**mastodon:**
> An opsec habit worth building: compartmentalize. If your most sensitive conversations live in the same place as your everyday ones, a single shoulder-surf or a borrowed phone exposes everything at once.
>
> AegisLink supports fully isolated profiles — each with its own keys and its own encrypted data, no crossover between them. The sensitive stuff doesn't have to share a screen with the mundane.
>
> #privacy #opsec

---

## L4-5 (Pillar 5): no phone number means no SIM-swap takeover

- [ ] Posted

**x:**
> If your messenger account is tied to a phone number, a SIM-swap can take it over — attackers do this to hijack accounts every week. AegisLink has no phone number to swap. There's no SMS recovery path because there's no phone number, full stop.

**mastodon:**
> A whole class of account takeover disappears when there's no phone number attached: the SIM-swap. Convince a carrier to move someone's number to a new SIM, and any account that trusts SMS for recovery is suddenly yours. It happens constantly.
>
> AegisLink accounts aren't tied to a phone number, so there's nothing to swap and no SMS recovery path to abuse. Your identity is a key on your device, not a number a carrier can be tricked into moving.
>
> #privacy #infosec #security

---

## L4-6 (Pillar 5): push notifications are a quiet metadata leak — unless the payload is sealed

- [ ] Posted

**x:**
> Push notifications route through Apple/Google. In most apps the payload tells them who's messaging whom and when. AegisLink's push is an encrypted wake-up only — no sender, no content, nothing for the push network to log about your conversations.

**mastodon:**
> Push notifications are an underappreciated metadata leak. To wake your phone, nearly every app hands a payload to Apple's or Google's push service — and in many apps that payload reveals who's contacting you and when, to a third party you never chose.
>
> AegisLink's push is a contentless, encrypted wake-up: it tells the device "check the relay," nothing more. No sender, no message, nothing the push network can log about who you talk to.
>
> #privacy #metadata #infosec

---

## L4-7 (Pillar 5): your calls shouldn't ride through a third party either

- [ ] Posted

**x:**
> A lot of "encrypted" call features still route audio through a third-party provider that sees who called whom. AegisLink calls are E2EE (DTLS-SRTP) and the signaling is sealed — the relay helps connect the call without learning who's on it.

**mastodon:**
> Voice and video are where "encrypted messenger" claims sometimes quietly outsource: the call audio, or the signaling that sets it up, routes through a third-party provider that ends up knowing who called whom, and for how long.
>
> AegisLink's calls are end-to-end encrypted (DTLS-SRTP), and the signaling is sealed against the relay — it helps two people connect without learning either identity or that the call happened. Same zero-metadata bar as text.
>
> #privacy #infosec #webrtc

---

## L4-8 (Pillar 6): the tradeoff of real E2EE — lose the key, lose the account

- [ ] Posted

**x:**
> Honest tradeoff: because your key never leaves your device and we can't read it, if you lose the device and your backup, we cannot recover your account for you. That's not a gap — it's the same property that means we can't be compelled to hand over your messages.

**mastodon:**
> The honest cost of real end-to-end encryption: if your private key only lived on your device and you lose it — no device, no backup — I can't recover your account. There's no "forgot password" that reaches into your messages, because nothing on the server can read them.
>
> That's the same property that means there's nothing decryptable for anyone to compel out of us. Convenience and this kind of privacy genuinely trade off here — so keep your backup.
>
> #privacy #e2ee #infosec

---

## L4-9 (Pillar 6): nothing to hand over — no accounts, no logs, no plaintext

- [ ] Posted

**x:**
> The strongest answer to a data request is "we don't have it." No email, no phone, no real name, no access logs, no readable message store. You can't hand over what you never collected — that's a design decision, not a legal strategy.

**mastodon:**
> The most durable protection against a data request isn't a policy that could change — it's not holding the data. No email, no phone number, no real name, no IP or access logs, no server-readable message store.
>
> You can't be compelled to produce what you never collected. For AegisLink that's an architectural decision made up front, not a promise layered on top that could quietly erode later.
>
> #privacy #metadata #infosec

---

## L4-10 (Pillar 6): open source only counts if you can check the binary matches

- [ ] Posted

**x:**
> "Open source" is worth less if the app you install can't be checked against the code. The goal for AegisLink is reproducible builds — so a third party can confirm the binary on your phone is built from the public source, not something else.

**mastodon:**
> Open source is necessary for trust but not sufficient: it only helps if the app you install can be shown to come from that public code, not something quietly different.
>
> That's why reproducible builds matter — they let an independent party rebuild from source and confirm, bit for bit, that the binary you're running is the code you can read. Being honest: that's a goal we're working toward, not a box already ticked.
>
> #opensource #infosec #privacy

---

## L4-11 (Pillar 2): metadata is the shape of your life, even with content encrypted

- [ ] Posted

**x:**
> Even if nobody can read a word you send, who you talk to, how often, and when draws a shockingly complete picture — your job, your health, your relationships. Encrypting content and leaking metadata is like sealing the letter but publishing the envelope.

**mastodon:**
> Encrypting message content and leaking metadata is like sealing every letter perfectly and then publishing the envelopes: who, to whom, when, how often. That pattern alone reveals your employer, your doctor, a relationship, a crisis — no message body required.
>
> This is why AegisLink treats metadata as the thing to protect, not an afterthought. "We can't read your messages" is table stakes; "we don't know who you're talking to" is the harder, more important claim.
>
> #privacy #metadata #infosec

---

## L4-12 (Pillar 3): message padding — why message size is a leak worth hiding

- [ ] Posted

**x:**
> Even encrypted, the *size* of a message leaks: a one-word "yes" and a long confession look different on the wire. AegisLink pads every message to a fixed bucket size before encrypting, so a network observer can't read that signal either. Small detail, real difference.

**mastodon:**
> A detail that survives encryption: message size. An observer who can't read anything can still tell a terse "yes" from a long, anxious paragraph — timing and size are metadata too.
>
> AegisLink pads every plaintext up to a fixed bucket size before it's encrypted, so the length on the wire doesn't track what you typed. The unglamorous kind of defense that separates "content is encrypted" from "the conversation is actually private."
>
> #privacy #metadata #infosec
