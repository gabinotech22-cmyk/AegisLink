# Bank 002 — Android Closed Testing launch (written 2026-07-06)

Launch-milestone batch for the **Android soft-launch (Closed Testing on Play)**.
See `../STRATEGY.md` for voice rules and `README.md` for the posting/human-gate
workflow. This is a Pillar 4 (build-in-public) moment with a Pillar 6 (values)
angle — the honest-framing rules matter more here than anywhere.

**Honesty guardrails baked into this copy (from `docs/ANDROID-LAUNCH-READINESS.md`,
state 2026-06/07):**

- It's **Closed Testing**, not a public Play Store release. Frame as "early
  testers wanted", never "download it now".
- Crypto is **not yet independently audited** — say so, every time it's relevant.
- Minimum spec is **arm64 + ~3GB RAM** (32-bit dropped). Don't imply it runs on
  anything.
- First person singular, no FUD, no competitor dunking.

**Images:** `prototype/brand/launch/android-closed-testing-1080x1080.svg`
(social square) and `.../android-closed-testing-1200x630.svg` (wide/OG card).
Attach the square to X/Mastodon, the wide one to link previews.

**Coverage:** L2-1..L2-3 are the queue items (X manual, Mastodon/Telegram via
the automated queues — Telegram reuses the `mastodon:` copy as usual). The
**Communities** section below holds the one-shot Reddit/Hacker News posts,
which follow their own ground rules, not the queue workflow. IG: per
`../STRATEGY.md`, launch (pillar 4) doesn't become a carousel.

---

## L2-1: Android Closed Testing is open

- [ ] Posted

**Context:** first installable-by-others Android build, shipped to Play Closed
Testing. App is functional end-to-end (E2EE chat/calls/groups, sealed-sender v2,
embedded Tor, panic mode, SQLCipher). Still pre-audit; min spec arm64 + 3GB.

**x:**
> AegisLink is now in Closed Testing on Android — the first build someone other than me can install, not just me on an emulator. Anonymous signup, E2EE chat/calls/groups, sealed-sender, embedded Tor. Still pre-audit, and I'll keep saying so out loud. Want in as an early tester? Reply.

**mastodon:**
> AegisLink just hit its first real milestone on Android: a Closed Testing build on Play — the first version someone who isn't me can actually install on their own phone, instead of me poking at an emulator.
>
> What's in it: anonymous signup (no email, phone, or name), E2EE 1:1 and group chat, E2EE voice/video calls, sealed-sender by default (the relay has no `from` field to log), embedded Tor for the mailbox path, panic mode, and a fully encrypted local DB (SQLCipher).
>
> What I want to be equally clear about: the crypto has **not** had an independent third-party audit yet — that's a Phase 2 goal, and until then every claim here is something to verify in the open source, not take on faith. Minimum spec is arm64 with ~3GB+ RAM (I dropped 32-bit after a low-end device swapped itself into uselessness — better to say the floor out loud than ship a "supported" build that isn't).
>
> Closed Testing means small, monitored batches on purpose. If you want in as an early tester, reach out.
>
> #buildinpublic #privacy #infosec #android

**Source (internal):** `docs/ANDROID-LAUNCH-READINESS.md`

---

## L2-2: What "soft-launch by batches" actually means

- [ ] Posted

**Context:** values/process angle — why Closed Testing first instead of a splashy
public release. Reinforces the "known, small, monitored risk" philosophy.

**x:**
> Why AegisLink is going to Android in small Closed Testing batches instead of a big public launch: for a privacy app the promise is strong, so the bar is high. There's no "zero risk" — the goal is risk that's known, small, and watched. Slow on purpose.

**mastodon:**
> AegisLink is reaching Android as a soft-launch — Closed Testing, small batches, widening only after each one looks clean. Not because the app isn't ready, but because "ready" for a privacy tool isn't a feeling, it's evidence.
>
> The honest framing I keep coming back to: there's no such thing as zero risk in shipping software. The goal isn't to pretend otherwise — it's to make the risk *known, small, and monitored*. A staged rollout means if something breaks, it breaks for a handful of testers I can talk to, not for everyone at once, and I can halt it in minutes.
>
> A splashy "we're live!" launch optimizes for reach. A privacy app should optimize for not breaking the one promise it exists to keep. Different job.
>
> #buildinpublic #privacy

**Source (internal):** `docs/ANDROID-LAUNCH-READINESS.md` (rollback plan + residual risks)

---

## L2-3: The Data Safety form is a feature, not a chore

- [ ] Posted

**Context:** differentiation + values. Play's Data Safety form usually reads like
a confession; for a zero-metadata app it's the opposite — "no data collected /
no data shared" is the honest answer.

**x:**
> Filling out Play's Data Safety form for AegisLink was the easiest paperwork I've done — "no data collected, no data shared" is just... true. For most apps that section is damage control. For a zero-metadata one it's the pitch. The form doesn't lie either way.

**mastodon:**
> A small thing that made me smile while prepping the Android launch: Google Play's Data Safety form. For most apps it's an exercise in phrasing data collection as gently as possible. For AegisLink the honest answer to almost every row is "no data collected, no data shared" — because there's genuinely nothing on the server to declare.
>
> No IP logs, no access timestamps, no message sizes, no contact-frequency data, no analytics SDK. The relay forwards opaque blobs and keeps nothing decryptable. That's not a marketing claim I'm bolting onto the form — it's what the form *forces* you to state precisely, under a policy that treats lying there as a violation.
>
> Zero metadata stops being a slogan the moment a platform makes you enumerate exactly what you keep. Nice when the paperwork and the principle point the same direction.
>
> #privacy #infosec #buildinpublic

**Source (internal):** `docs/ANDROID-LAUNCH-READINESS.md` (Data Safety form), `docs/PLAY-STORE-LISTING.md`

---

# Communities — Reddit / Hacker News (manual, one-shot)

These do **not** follow the `x:`/`mastodon:` queue workflow. Each is a one-shot
post to a community with its own culture and self-promotion rules. Ground rules:

1. **Read the community's self-promo rules the day you post** (they change).
   Use the required flair/disclosure ("I'm the developer") everywhere.
2. **Don't post until the tester opt-in path is live.** Replace
   `<TESTER-OPT-IN>` with the real Closed Testing opt-in link (or "comment/DM
   and I'll add you") before posting. Same for `<REPO>` →
   `https://github.com/gabinotech22-cmyk/AegisLink` if the repo is public by
   then; if it isn't, cut the code links and don't claim "go verify it" without
   a URL.
3. **Space them out** — one community per day at most. Identical text blasted
   across subreddits the same afternoon reads as spam, and mods check.
4. **Stay in the comments for the first few hours.** These communities judge
   the dev by the answers more than the post. The pre-audit honesty rule
   applies double here: concede limitations before anyone digs for them.
5. Lemmy equivalents (`!opensource`, `!fossdroid`, etc.) can reuse the
   r/opensource body as-is if we're present there — same voice rules.

---

## L2-C1: r/fossdroid — dev post

- [ ] Posted

**Context:** FOSS Android community; self-promo is accepted with clear dev
disclosure. Full-detail technical angle.

**title:**
> [Dev] AegisLink — anonymous, zero-metadata E2EE messenger — first Android build is in Closed Testing

**body:**
> I'm the developer. AegisLink just reached its first installable milestone: a Closed Testing build on Google Play — the first version someone who isn't me can put on their own phone.
>
> The design goal is that metadata, not just message content, is the threat:
>
> - Anonymous signup — no email, no phone number, no name
> - E2EE 1:1 and group chat, plus E2EE voice/video calls (WebRTC + DTLS-SRTP)
> - Double Ratchet + X3DH, with a hybrid post-quantum handshake (PQXDH)
> - Sealed sender by default — the relay has no `from` field to log
> - Embedded Tor for the mailbox path
> - Panic mode: instant local wipe behind a duress PIN, with a decoy profile
> - Local DB fully encrypted (SQLCipher)
> - Self-hosted relay, no analytics SDKs. FCM is used only as a content-free wake-up ping; the payload is always encrypted.
>
> Honest limitations, so nobody has to dig for them:
>
> - The crypto has **not** had an independent third-party audit yet. That's planned (grants route), and until it happens every claim above is something to verify in the source, not take on faith. Code: <REPO>
> - The crypto runs in JS (Hermes). It works, but it's a known performance ceiling on low-end hardware.
> - Minimum spec is arm64 with ~3GB RAM — I dropped 32-bit after testing on a 2GB device that swapped itself into uselessness.
> - One more honest wrinkle: Play's Closed Testing requires a Google account email to allow-list testers. That's a Play mechanism, not an AegisLink signup — the app itself never asks for it.
>
> If you want in as an early tester: <TESTER-OPT-IN>. Happy to answer anything about the architecture.

**Source (internal):** `docs/ANDROID-LAUNCH-READINESS.md`

---

## L2-C2: r/opensource — project share + review ask

- [ ] Posted

**Context:** sharing your own project is fine with disclosure. Angle: the code
is the point — explicitly invite review instead of just announcing.

**title:**
> I've been building an open-source E2EE messenger designed around zero metadata — it just hit Closed Testing on Android, and I'd genuinely like more eyes on the crypto

**body:**
> Solo dev here. AegisLink is an end-to-end encrypted messenger whose main design constraint is that the server should learn as close to nothing as possible: no accounts tied to email/phone, sealed sender (the relay never sees who a message is from), an embedded Tor path, and a relay that forwards opaque blobs and keeps no decryptable data.
>
> Stack: React Native/Expo + TypeScript on mobile, a self-hosted Node relay, TweetNaCl + @noble for the primitives, Double Ratchet + X3DH with a hybrid PQ handshake (PQXDH), SQLCipher at rest.
>
> The part where I need the open-source ethos to do its job: **the crypto has not been independently audited yet.** A formal audit is the plan (grants), but audits take months, and in the meantime the honest move is to ask for adversarial readers, not applause. If you enjoy picking apart ratchet state handling, sealed-sender envelopes, or key zeroization, the code is at <REPO> and I'll take criticism gladly — the security roadmap doc in the repo lists the classes of bugs already found and fixed, so you can see what the bar has been.
>
> Android Closed Testing is open if you'd rather poke at the running app: <TESTER-OPT-IN>.

**Source (internal):** `docs/ANDROID-LAUNCH-READINESS.md`, `docs/SECURITY-ROADMAP-2026-06.md`

---

## L2-C3: r/androidapps — testers wanted (DEV flair)

- [ ] Posted

**Context:** app-user audience, not crypto people. Shorter, plainer, feature-
first; min-spec stated up front to avoid 1★-by-mismatch.

**title:**
> [DEV] AegisLink — private messenger with no signup (no email/phone/name) — looking for Closed Testing testers

**body:**
> I'm the developer of AegisLink, a messaging app where creating an account asks you for nothing: no phone number, no email, no name. Identity is a keypair generated on your device.
>
> It does the things you'd expect — 1:1 and group chats, voice and video calls, photos/audio/files, disappearing messages — with everything end-to-end encrypted, plus a panic mode that instantly wipes the app and shows a decoy profile if you're ever forced to unlock it.
>
> It just entered Closed Testing on Google Play and I'm looking for early testers. Fair warnings before you sign up:
>
> - It needs a 64-bit phone with ~3GB+ RAM (most phones from the last few years are fine).
> - It's an early build from a solo dev — expect rough edges, and tell me about them; that's the point of the test.
> - The encryption hasn't been independently audited yet, so if your safety depends on your messenger today, keep using your current one while you kick the tires on this.
>
> Opt-in: <TESTER-OPT-IN>

**Source (internal):** `docs/ANDROID-LAUNCH-READINESS.md`, `docs/PLAY-STORE-LISTING.md`

---

## L2-C4: r/privacy — GATED, verify rules first

- [ ] Posted

**Context:** ⚠️ r/privacy historically **removes product promotion posts**.
Before even considering this one: read their current rules; if there's a weekly
"what are you working on" / product thread, this goes **there**, not as a
standalone post. If neither is allowed, skip — do NOT force it. The draft is
deliberately a discussion post about a design decision, not an announcement,
but mods decide what it is, not us.

**title:**
> Shipping a zero-metadata messenger through Google Play forces some ironies — notes from filling in the Data Safety form for an app whose whole point is "no data"

**body:**
> I build an E2EE messenger designed around metadata minimization (no email/phone signup, sealed sender, relay keeps nothing decryptable), and it just went through Play's Closed Testing setup. Two things from that process seem worth discussing here beyond my app:
>
> **The Data Safety form is a surprisingly good forcing function.** For most apps it's damage-control phrasing. But it makes you enumerate, row by row, exactly what your server retains — under a policy where lying is a violation. "No data collected, no data shared" stops being marketing the moment a platform makes you state it precisely. I'd honestly like more platforms to force this.
>
> **Distribution itself is the metadata leak.** Play's Closed Testing allow-lists testers by Google account email. So the app asks for nothing, but the *channel* you get it through knows exactly who installed it. APK sideloading and (eventually) F-Droid-style distribution avoid that, at the cost of Play's update path and reach. There's no clean answer — curious how people here weigh "reach normal users where they already are" against "the store is itself a surveillance layer".
>
> (Disclosure: I'm the dev; not linking the app here unless mods say it's fine — the two points stand on their own.)

**Source (internal):** `docs/ANDROID-LAUNCH-READINESS.md` (Data Safety form)

---

## L2-HN: Show HN

- [ ] Posted

**Context:** HN convention: Show HN is for something people can actually try.
The open repo qualifies; the Closed Testing link strengthens it. URL of the
submission = repo. If the repo is not public yet, **hold this one** until it
is — a Show HN people can't try gets flagged. Expect blunt crypto criticism in
comments; answer it straight, concede fast, never spin.

**title:**
> Show HN: AegisLink – anonymous E2EE messenger with sealed sender and embedded Tor

**first comment (post immediately after submitting):**
> Solo dev here. AegisLink is an E2EE messenger built around the idea that metadata is the real prize: signup asks for no email/phone/name (identity is an on-device keypair), the relay never sees a `from` field (sealed sender), the mailbox path can run over an embedded Tor client, and the server stores nothing it can decrypt.
>
> Crypto: Double Ratchet + X3DH with a hybrid post-quantum handshake (PQXDH), TweetNaCl/@noble primitives, SQLCipher for everything at rest. Stack is React Native/Expo + TypeScript with a self-hosted Node relay — yes, the crypto runs in JS/Hermes; that's a deliberate trade-off for auditability of a single codebase over raw KDF speed, and it's the first thing I'd expect this crowd to push on.
>
> The other thing to push on: **no independent audit yet.** It's planned via the OSS grants route, but today the claims are only as good as the code, which is why the repo is the submission link. The security roadmap doc inside lists the bug classes already found and fixed internally.
>
> Android just entered Closed Testing on Play (<TESTER-OPT-IN>) — desktop exists too. Happy to go as deep as anyone wants on the ratchet, sealed-sender envelope format, or the panic/duress design.

**Source (internal):** `docs/ANDROID-LAUNCH-READINESS.md`, `docs/SECURITY-ROADMAP-2026-06.md`
