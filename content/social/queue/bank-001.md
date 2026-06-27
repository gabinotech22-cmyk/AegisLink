# Bank 001 — first diversification batch (written 2026-06-25)

18 posts, 3 per pillar. See `../STRATEGY.md` for the pillar definitions and
voice rules, and `README.md` for how to post and check these off.

---

## Pillar 1 — Current events

### P1-1: EU Chat Control — final trilogue this week

- [ ] Posted

**Context:** the trilogue on the EU's "Chat Control" CSAM-scanning regulation
is scheduled for 2026-06-29. Parliament's position excludes E2EE
communications from scanning; the Council has resisted that exclusion. Time
-sensitive — verify the trilogue outcome before posting if more than a few
days have passed.

**x:**
> The EU's final "Chat Control" trilogue is this Monday (6/29). Parliament wants E2EE chats excluded from scanning; the Council doesn't. This is the actual fight — not "encryption vs. safety," but "does a law get to mandate scanning content before it's encrypted." Watching closely.

**mastodon:**
> The EU's "Chat Control" regulation reaches its final trilogue on 2026-06-29. The Parliament's position would exclude end-to-end encrypted communications from mandatory scanning; several Council governments are pushing to keep broader scanning powers.
>
> Worth being precise about what's actually at stake: client-side scanning before encryption defeats E2EE as a guarantee, regardless of what happens to the ciphertext afterward. That's the technical reality the law has to reckon with.
>
> #infosec #privacy

**Source:** [EU Perspectives — MEPs vote to extend Chat Control rules, limit scanning](https://euperspectives.eu/2026/03/meps-extend-chat-control-limit-scanning/)

---

### P1-2: WhatsApp's Meta AI privacy walk-back

- [ ] Posted

**Context:** WhatsApp's Meta AI integration personalizes ads/content from AI
chat interactions with no opt-out; Meta shipped an "incognito" mode in May
2026 as a partial fix, but only for AI conversations — not for the
underlying data-use default.

**x:**
> WhatsApp added an "incognito" mode for chats with Meta AI. Good that it exists. The part that didn't change: talk to Meta AI outside incognito and there's still no opt-out from using that for ad personalization. A privacy mode that has to be turned on is a feature, not a default.

**mastodon:**
> Meta shipped an "incognito" mode for WhatsApp's Meta AI chats this May — messages processed in a separate environment, not saved by default. That's a real improvement for that one mode.
>
> What it doesn't touch: outside incognito, anything you tell Meta AI on WhatsApp still feeds ad/content personalization across Meta's apps, with no opt-out. The lesson isn't "WhatsApp bad" — it's that *default* matters more than *available*. A privacy posture you have to switch on, conversation by conversation, isn't privacy by default. It's an escape hatch.
>
> #privacy

**Source:** [Help Net Security — Meta AI in WhatsApp reopens privacy issues](https://www.helpnetsecurity.com/2026/03/02/whatsapp-chats-meta-ai-user-privacy/), [TechXplore — Meta launches WhatsApp incognito mode](https://techxplore.com/news/2026-05-meta-whatsapp-incognito-mode-privacy.html)

---

### P1-3: Tchap breach — what gets stolen when metadata isn't minimized

- [ ] Posted

**Context:** Tchap (the French government's messaging app) was breached in
June 2026: ~13.5GB exfiltrated, including 643k+ messages, 876 rooms with
history, and 59k+ media files.

**x:**
> A government messaging app got breached this month — not "some metadata," but ~643k messages, room history, and 59k media files in one dump. That's what's at risk when a server stores more than it needs to. The right amount of data for a relay to hold on you is zero.

**mastodon:**
> Tchap, the French government's messaging app, was breached in June: attackers claim ~13.5GB exfiltrated — over 643,000 messages, 876 rooms with full history, ~59,000 media files, plus account records.
>
> Whatever the transport encryption looked like, a breach of that size means the server was sitting on plaintext-adjacent history at rest. That's the actual threat model question for any messenger: not just "is it encrypted in transit" but "what does the server retain, and for how long, such that a single breach turns into a history dump." Minimize what's stored, not just what's exposed.
>
> #infosec #privacy

**Source:** [Privacy Guides — Data Breach Roundup, June 5–11 2026](https://www.privacyguides.org/news/2026/06/12/data-breach-roundup-june-5-11-2026/)

---

## Pillar 2 — Education / myth-busting

### P2-1: "Encrypted" is not "private"

- [ ] Posted

**x:**
> "End-to-end encrypted" tells you the *content* of your message is protected. It tells you nothing about who can see that you talked to someone, when, how often, or from where. That second list is metadata — and for most threat models, it's the part that actually matters.

**mastodon:**
> A clarification worth repeating: "end-to-end encrypted" is a claim about message *content*. It says nothing about who you talked to, when, how often, from what IP, or on what device — the metadata.
>
> A server that can't read a single message but logs all of that can still reconstruct your entire social graph. For journalists, abuse survivors, organizers — anyone whose risk is "someone learns who I talk to," not "someone reads what I said" — metadata is the actual attack surface. Content encryption alone doesn't close it.
>
> #privacy #infosec

---

### P2-2: A phone number is an identity

- [ ] Posted

**x:**
> Requiring a phone number to sign up means the messaging app — and anyone who breaches it, subpoenas it, or buys its data — can link "this account" to "this real person" instantly. "Anonymous" and "phone-number-required" are contradictory claims.

**mastodon:**
> If a messenger requires a phone number to create an account, it cannot also be anonymous — the phone number is a real-world identity key, full stop. It doesn't matter how strong the message encryption is afterward.
>
> This is why identity generation that happens entirely on-device, with no phone/email/name ever transmitted, is a different category of design decision than "encrypt the messages." One protects content; the other protects the fact that you're using the app at all.
>
> #privacy

---

### P2-3: What a "dumb" relay actually means

- [ ] Posted

**x:**
> A relay server that "just forwards messages" can still log: every IP that connects, when, how often, and how big each message was. None of that requires reading content — and all of it builds a usable picture of who you talk to. Encrypted content + logged metadata = a server that knows your social graph anyway.

**mastodon:**
> "The server can't read your messages" is often presented as the whole privacy story. It isn't. A relay that forwards opaque ciphertext can *still* log connecting IPs, access timestamps, message sizes, and frequency — and that's enough to map a social graph without decrypting a single byte.
>
> The design question that actually matters: does the relay keep those logs at all? "Zero metadata" has to mean the server doesn't retain that data, not just that it can't read content.
>
> #infosec #privacy

---

## Pillar 3 — Practical hygiene

### P3-1: Strip photo metadata before sharing

- [ ] Posted

**x:**
> Photos carry EXIF metadata by default — often GPS coordinates of where they were taken, device model, timestamp. Sharing a photo "privately" through an E2EE app doesn't strip that. Check your app's send settings, or strip EXIF before sending if you're not sure.

**mastodon:**
> Quick practical one: photos taken on a phone usually embed EXIF metadata — GPS coordinates, device model, exact timestamp — inside the file itself. Sending that photo through an end-to-end encrypted chat protects it in transit, but if the app doesn't strip EXIF before sending (or the recipient re-shares the raw file), that metadata travels with it.
>
> Worth checking whether your messenger strips this automatically, and stripping it yourself before sending anything sensitive if you're not sure.
>
> #privacy #infosec

---

### P3-2: "E2EE" on a label isn't a guarantee

- [ ] Posted

**x:**
> "End-to-end encrypted" on a marketing page isn't verifiable by reading the marketing page. Closed-source crypto means you're trusting the vendor's claim, not checking it. Open protocol + open code is what makes "E2EE" a checkable fact instead of a slogan.

**mastodon:**
> A practical filter for evaluating any "encrypted" app: can someone who isn't you actually verify the encryption claim? If the crypto code and protocol spec aren't public, "end-to-end encrypted" is a claim you're trusting, not a fact you can check.
>
> This is also why an audit matters more than a feature list — and why it's worth being upfront when something *hasn't* been audited yet rather than implying otherwise.
>
> #infosec

---

### P3-3: Verify device-linking out of band

- [ ] Posted

**Context:** ties to the March 2026 wave of Signal account compromises via
device-linking social engineering (FBI/CISA warning) — frame as a general
lesson about an attack class, not a dig at Signal specifically.

**x:**
> A real attack pattern this year: tricking someone into scanning a "linked device" QR code that actually links the attacker's device to the victim's account. The crypto wasn't broken — the human step was. If an app supports linking a new device, treat that QR code like a password: verify the context before you scan it.

**mastodon:**
> Earlier this year, multiple commercial messaging apps saw account compromises through a non-cryptographic vector: social-engineering someone into scanning a "link a device" QR code that actually granted the attacker a linked session — full read access, no protocol break required.
>
> The lesson generalizes: any app with device-linking has a phishing surface that lives outside the crypto entirely. Verify the *context* of a linking request (did you initiate it, right now, on a device you're holding) before scanning anything — the strongest E2EE doesn't help if the second device belongs to someone else.
>
> #infosec #privacy

**Source:** [Fox News — FBI warns Russian hackers targeting Americans on Signal](https://www.foxnews.com/politics/fbi-warns-russian-hackers-targeting-americans-signal-thousands-accounts-compromised)

---

## Pillar 4 — Build-in-public

### P4-1: AegisLog teaser

- [ ] Posted

**x:**
> This week's AegisLog drops Friday: what shipped, what broke, what's next. If you want the unfiltered version of building a privacy-first messenger — including the parts that didn't work the first time — that's where it lives.

**mastodon:**
> Friday's AegisLog is the unfiltered build-in-public log for the week — what shipped, what I had to redo, what's queued next. No polish, no pretending a redesign was the plan from day one.
>
> #buildinpublic

---

### P4-2: Embedded Tor, no Orbot dependency

- [ ] Posted

**x:**
> Just landed: the mailbox path now rides an embedded Tor client by default — no separate Orbot app required. One less thing a privacy-conscious user has to install and trust to get network-layer protection, not just message-layer.

**mastodon:**
> Shipped this week: the mailbox transport now routes through an embedded Tor client built into the app itself, rather than depending on a separate Orbot install. That removes a real adoption barrier — most people aren't going to install a second app just to get IP-layer protection for their messenger.
>
> Still mid-rollout (runtime validation across two real devices is the next gate before this is the default for everyone) — flagging it now because "what shipped" should include "what's still being tested," not just the finished parts.
>
> #buildinpublic #infosec

---

### P4-3: Dropping 32-bit, being honest about the minimum spec

- [ ] Posted

**x:**
> Decided this week: AegisLink's minimum spec is arm64 + 3GB RAM. Tested it on a 2GB ARMv7 device and watched it swap itself into uselessness — not a bug in our code, just what modern E2EE + a real OS needs. Rather say that out loud than ship a "supported" build that's actually unusable.

**mastodon:**
> A less glamorous build-in-public update: after on-device QA, I'm setting AegisLink's real minimum spec at arm64 with 3GB+ RAM, and dropping 32-bit support entirely.
>
> The 2GB/ARMv7 test device wasn't failing on anything we wrote — it was swapping under normal OS memory pressure before the app even got a chance to misbehave. Listing a device as "supported" when it can't actually hold a session open isn't honesty, it's a support-ticket generator. Better to say the floor out loud.
>
> #buildinpublic

---

## Pillar 5 — Honest differentiation

### P5-1: Hybrid post-quantum handshake (PQXDH)

- [ ] Posted

**x:**
> Our key exchange is hybrid post-quantum (PQXDH) — classical X3DH plus a PQ KEM layered on top, so a future quantum computer breaking the classical math alone still isn't enough to retroactively decrypt past sessions. Not every E2EE messenger has moved on this yet.

**mastodon:**
> One concrete differentiation point: our handshake is a hybrid post-quantum design (PQXDH) — the classical X3DH exchange combined with a post-quantum KEM, not a replacement for it. Hybrid matters because it means a break in *either* the classical or the post-quantum primitive alone isn't enough to compromise the session; both have to fall.
>
> The reason this matters at all is "harvest now, decrypt later" — traffic captured today and stored could be decrypted years from now once quantum computing catches up, if the original exchange was classical-only. Mobile and desktop both run it.
>
> #infosec #privacy

---

### P5-2: Sealed-sender — the relay never sees `from`

- [ ] Posted

**x:**
> As of this build, our relay genuinely never sees who sent a chat message, call signal, or group message — no `from` field, ever, anywhere in the protocol. Not "we promise not to log it." It isn't in the wire format to log.

**mastodon:**
> A distinction worth being precise about: "we don't log who sent what" is a *policy*. "The field doesn't exist on the wire" is a *protocol property* — and it's the one that actually matters, because policies require trust and protocol properties don't.
>
> As of our latest default, the relay has no `from` field to log across chat, calls, or group messages — sender identity lives only inside payloads sealed against the recipient's key. The relay routes opaque blobs; it structurally cannot reconstruct who's talking to whom, even if it wanted to.
>
> #infosec #privacy

---

### P5-3: Why we embedded Tor instead of requiring Orbot

- [ ] Posted

**x:**
> Most "use Tor with your messenger" setups mean: go install Orbot, configure it, hope it stays running. We're embedding the Tor client directly in the app instead — same network-layer protection, zero extra app to install or trust.

**mastodon:**
> A design choice worth explaining: the common pattern for "Tor-protected messenger" is pairing with Orbot — a separate app the user installs, configures, and has to keep running and trust independently.
>
> We went the other direction: embed a Tor client inside the app itself for the mailbox transport. Same IP-layer protection (the relay doesn't see your real IP), but it's the app's job to make that work, not an extra piece of software the user has to manage correctly for the protection to hold. Fewer steps between "installed the app" and "actually protected."
>
> #infosec #privacy

---

## Pillar 6 — Manifesto / values

### P6-1: Why anonymous by default

- [ ] Posted

**x:**
> No email. No phone number. No real name. Not because we couldn't build a signup form — because every one of those fields is a thread someone can pull later to find out who you are. Anonymous isn't a mode you opt into here. It's the only mode.

**mastodon:**
> Why no email, phone, or name at signup: each of those isn't just a convenience field, it's a permanent link between "this account" and "a real person" — one that outlives any privacy setting you configure afterward, because it was never private to begin with.
>
> Anonymity by default means there's no real identity in the system to protect in the first place. Not a toggle, not an advanced setting — the only way the app works.
>
> #privacy

---

### P6-2: Zero metadata is a principle, not a checkbox

- [ ] Posted

**x:**
> "We minimize metadata" can mean a hundred different things depending on how much pressure it's under. Ours means: no IP logs, no access timestamps, no message-size logs, no frequency logs — and any new feature gets checked against that before it ships, not after someone notices.

**mastodon:**
> "Zero metadata" is easy to put in a tagline and hard to actually hold as a constraint, because every new feature comes with a tempting reason to log "just this one thing" — for debugging, for abuse prevention, for analytics.
>
> Treating it as a principle means: no IPs, no access timestamps, no message/attachment sizes, no contact-frequency logs, full stop — and every new feature gets evaluated against that line *before* merge, not patched out after an audit finds it. The discipline is in what doesn't get added, which is much less visible than a feature list.
>
> #privacy #infosec

---

### P6-3: Don't trust us — verify us

- [ ] Posted

**x:**
> Everything — the crypto, the protocol, the threat model — is public and open source. Not as a marketing line. Because "trust me" isn't a security model, and the entire point of building this in the open is that someone who knows more than I do can find the mistake before an attacker does.

**mastodon:**
> The reason the code, protocol docs, and threat model are public isn't a marketing choice — it's the actual security model. Closed-source crypto asks you to trust a claim. Open-source crypto lets you, or someone who knows more than I do, check the claim.
>
> Pre-audit and built mostly solo, that openness is the only real check that exists right now. Treat everything here as a claim to verify, not a promise to take on faith — that's the whole point of doing it this way.
>
> #infosec #privacy #opensource
