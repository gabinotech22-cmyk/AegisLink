# Bank 003 — Evergreen refill (written 2026-08-02)

Written to close the gap that caused the 2026-07-26→2026-08-02 silence: bank-001
and bank-002 were the only content ever queued, and nothing generates more on
its own. This batch is deliberately **pillar 2/3/5/6 only** (education, practical
hygiene, differentiation, manifesto) — no pillar 1 (current events), because
those posts require a real, checkable, current source and can't be pre-written
weeks ahead without going stale or unverifiable. See `../STRATEGY.md` for the
pillar definitions and voice rules, `README.md` for the posting workflow.

**Coverage:** all 12 items below are queue items (X manual, Mastodon/Telegram
via the automated queues — Telegram reuses the `mastodon:` copy as usual, per
existing convention).

---

## L3-1 (Pillar 2): IP address is metadata too

- [ ] Posted

**x:**
> Metadata leaks even without a single message. Your IP tells a relay roughly where you are and when you're online. AegisLink's mailbox path runs through embedded Tor — not a bolt-on VPN, built into the app so the relay never learns your real IP.

**mastodon:**
> A metadata leak that has nothing to do with message content: your IP address. Even a messenger that encrypts everything perfectly still reveals, to whoever operates the relay, roughly where you are and exactly when you're online — every connection.
>
> That's why AegisLink routes the mailbox path through an embedded Tor client by default, not an optional VPN toggle. The relay sees a Tor exit node, not you.
>
> #privacy #infosec #tor

---

## L3-2 (Pillar 2): contact-list sync is a social graph leak

- [ ] Posted

**x:**
> Uploading your phone's contact list to "find friends" hands a messenger your entire social graph before you've sent a single message. AegisLink never asks for your contacts — Aegis IDs are shared manually, on purpose.

**mastodon:**
> Most messengers offer to "find your friends" by uploading your phone contacts to their servers. Convenient — and it hands them your social graph before you've sent a single message, whether or not those contacts ever use the app.
>
> AegisLink never asks for your contact list. Adding someone means sharing an Aegis ID on purpose, not the app scanning your address book for you.
>
> #privacy #metadata

---

## L3-3 (Pillar 2): E2EE that stops at the backup isn't E2EE

- [ ] Posted

**x:**
> "End-to-end encrypted" that stops applying to your backup isn't end-to-end encrypted, it's end-to-end-until-Tuesday. AegisLink's local and remote backups are encrypted with a key only you hold — the server can't read what it's storing.

**mastodon:**
> A common gap: a messenger is E2EE for live messages, then backs up chat history to a cloud service that can read it. The encryption guarantee quietly stops applying the moment the data leaves the device for "safekeeping."
>
> AegisLink's backups — local or remote — are encrypted with a key that only you hold. The storage layer, ours or anyone else's, never sees plaintext.
>
> #privacy #infosec #e2ee

---

## L3-4 (Pillar 3): app lock is the unglamorous first layer

- [ ] Posted

**x:**
> E2EE protects your messages in transit. It does nothing if someone picks up your unlocked phone. A device passcode plus an app-level lock is the unglamorous first layer every "secure" chat app still depends on.

**mastodon:**
> The strongest E2EE in the world doesn't help if your phone is sitting unlocked on a table. Message encryption protects data in transit and at rest on disk — it says nothing about someone physically picking up your device.
>
> A device passcode and an app-level lock (biometric or PIN) are the boring first layer every "secure" messenger quietly depends on. Worth actually turning on, not assuming.
>
> #privacy #opsec

---

## L3-5 (Pillar 3): link previews can leak your IP before you click

- [ ] Posted

**x:**
> Link previews are convenient and can be a metadata leak: some apps fetch the URL from your device the moment a link lands in chat, before you've clicked anything — handing your IP to whoever's on the other end of that link.

**mastodon:**
> A subtle one: link previews. Some messengers fetch the linked page automatically the moment a URL appears in a chat — sometimes before you've even opened the conversation — which can reveal your IP and device info to whoever controls that URL, no click required.
>
> Worth knowing whether your messenger fetches previews client-side (your IP, your risk) or server-side (the relay fetches it, not you) — and turning previews off for links you don't trust either way.
>
> #privacy #infosec

---

## L3-6 (Pillar 3): disappearing messages are a mitigation, not a guarantee

- [ ] Posted

**x:**
> Disappearing messages delete the message. They don't stop a screenshot, a second phone photographing the screen, or someone reading over a shoulder before the timer runs out. Useful control, not a guarantee.

**mastodon:**
> Disappearing messages are a genuinely useful control — but it's worth being precise about what they actually guarantee: the message deletes itself after the timer. They can't stop a screenshot, a second device photographing the screen, or someone reading over a shoulder before it expires.
>
> AegisLink ships ephemeral timers because reducing the window of exposure matters. It's a mitigation, not a promise that content can never leave the conversation.
>
> #privacy #opsec

---

## L3-7 (Pillar 5): self-hosted relay vs. one company's servers

- [ ] Posted

**x:**
> Signal, WhatsApp, Telegram — pick your "private" messenger, you're still trusting one company's servers by design. AegisLink's relay is open source and self-hostable: run your own if you don't want to trust ours.

**mastodon:**
> Most "private" messengers, however good the crypto, still route every connection through one company's infrastructure by design — Signal's servers, Meta's servers, Telegram's servers. You're trusting their operational security, not just their math.
>
> AegisLink's relay is open source and self-hostable. Don't want to trust our instance? Run your own — same protocol, same clients, no fork required.
>
> #privacy #opensource #infosec

---

## L3-8 (Pillar 5): anonymity by default, not by toggle

- [ ] Posted

**x:**
> Telegram has "Secret Chats." Most encryption is opt-in, chat by chat, and most people never toggle it. AegisLink doesn't have a private mode — every chat is E2EE, every account is anonymous, by default, full stop.

**mastodon:**
> Telegram's regular chats aren't end-to-end encrypted by default — that's what "Secret Chats" are for, a separate opt-in mode most users never discover, let alone switch to for every conversation.
>
> AegisLink doesn't have a private mode next to a normal mode. There's one mode: every chat is E2EE, every account is anonymous, from the first message. Nothing to remember to turn on.
>
> #privacy #e2ee

---

## L3-9 (Pillar 5): group encryption is where claims quietly weaken

- [ ] Posted

**x:**
> Group encryption is where a lot of "E2EE" messengers quietly weaken: shared group keys, server-assisted fan-out, metadata about membership. Worth asking how your group chats are actually keyed, not just assuming 1:1 protections carry over.

**mastodon:**
> A place E2EE claims often get quietly weaker: group chats. Some apps use a single shared group key (one compromised member can read everything, forever), others lean on the server for membership fan-out in ways that leak who's in a group.
>
> It's worth asking how a messenger actually keys its groups, not assuming the same guarantees as 1:1 chat carry over automatically — they often don't.
>
> #infosec #privacy

---

## L3-10 (Pillar 6): funding without selling data

- [ ] Posted

**x:**
> AegisLink doesn't sell data because there's no data to sell — the model is a paid Work tier for teams, not ads or analytics. Every security feature stays free for everyone, always. Funding and privacy shouldn't be in tension.

**mastodon:**
> How AegisLink stays funded without the usual trade-off: there's no data to sell, so that was never on the table. The model is a paid Work tier for teams and organizations — rooms, roles, enterprise features.
>
> Every core security and privacy feature stays free for everyone, permanently. Funding and privacy pulling in the same direction, instead of against each other, was a design constraint from day one, not an afterthought.
>
> #buildinpublic #privacy

---

## L3-11 (Pillar 6): solo dev, public roadmap

- [ ] Posted

**x:**
> Building this alone means no team to catch my blind spots — so the roadmap, the security docs, and the honest "not audited yet" caveats are all public. If something's wrong, the fix is more eyes, not more silence.

**mastodon:**
> Building AegisLink solo means there's no team internally to catch my blind spots before something ships. The response to that isn't to project more confidence — it's to make the roadmap, the security docs, and every honest "not audited yet" caveat public.
>
> If there's a blind spot, the fix is more eyes on the code and the docs, not less visibility into what's actually true right now.
>
> #buildinpublic #privacy

---

## L3-12 (Pillar 6): what "audited" will actually mean here

- [ ] Posted

**x:**
> "Audited" gets used loosely. When AegisLink's audit happens, the plan is: publish the full report, publish what's fixed vs. accepted-risk, and publish the auditor's name. A summary with no report attached isn't an audit, it's a badge.

**mastodon:**
> "Audited" gets thrown around loosely in this space — sometimes it means a full public report, sometimes it means a badge with no report anyone can read.
>
> The plan for AegisLink's eventual audit: publish the full report, publish exactly what got fixed versus accepted as residual risk, and name the auditor. If any of those three pieces is missing, treat the claim skeptically — ours included, later.
>
> #infosec #privacy
