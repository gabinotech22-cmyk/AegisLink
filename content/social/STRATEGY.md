# Social content strategy

Until 2026-06-25 our X/Mastodon/Telegram presence was ~100% build-in-public
(AegisLog Fridays + daily pulse). That's necessary but not sufficient — Signal,
Threema and Zerion stay active by reacting to the world, not just narrating
their own commits. A feed that only says "shipped X this week" goes quiet the
first slow week and never reaches anyone who isn't already a contributor.

This doc defines the mix going forward. The bank of ready-to-post drafts lives
in `queue/` (see `queue/README.md` for the posting/human-gate workflow).

## The 6 pillars

| # | Pillar | What it is | Cadence | Why |
|---|--------|------------|---------|-----|
| 1 | **Current events** | React to real privacy/surveillance news (laws, breaches, Big Tech privacy walk-backs) | 2-3/wk | Effectively infinite source material; the main thing Signal posts about |
| 2 | **Education / myth-busting** | "Encrypted ≠ private", what metadata actually is, why a phone number deanonymizes you | 2/wk | Builds authority; reusable as IG carousels (Vault format already exists) |
| 3 | **Practical hygiene** | Actionable tips: strip photo metadata, why "E2EE" alone isn't a privacy guarantee | 1-2/wk | Useful → gets shared; reaches non-technical people |
| 4 | **Build-in-public** | What we already do: AegisLog, daily pulse | 1-2/wk | Keep it, but it stops being the whole feed |
| 5 | **Honest differentiation** | What we do differently vs. Signal/Session — PQXDH, sealed-sender, embedded Tor — without trashing anyone | 1/wk | Educates without trolling; respects the no-aggressive-marketing line |
| 6 | **Manifesto / values** | Why we exist: anonymity by default, zero metadata as a principle, not a feature | every 1-2 wk | Gives the account a spine; builds loyalty, not just reach |

Target mix: roughly **40% react-and-educate (1+2), 20% build-in-public, 40%
the rest (3+5+6)**. We were close to 100% pillar 4; this brings it back down.

## Voice rules (apply to every post, every pillar)

- First person singular ("I'm building..."), matching the existing dev.to
  voice — not corporate "we".
- Pre-audit honesty: when a claim is about AegisLink's own security, don't
  overstate it. If something hasn't had a third-party audit, say so when it's
  relevant — exactly like `content/devto/published/0001-hides-metadata.md`.
- No FUD, no fearmongering, no naming a specific privacy-respecting competitor
  to dunk on. Critique *patterns* (metadata logging, centralized servers,
  device-linking phishing) not people or projects we respect.
- News reactions cite a real, checkable source. Never invent a statistic,
  breach, or law detail — if it can't be verified, it doesn't get posted.
- Red line carried over from `project_build_in_public`: no unpatched
  vulnerability, ours or anyone else's, gets mentioned before a fix ships.

## Platform notes

- **X**: short (~250 chars to leave room for QT/reply), 1 hook line + 1 punch
  line. No thread unless the topic genuinely needs 3+ beats.
- **Mastodon**: longer-form is fine, use `#infosec` and `#privacy` tags on
  technical posts (per `project_mastodon_infosec`). The audience there
  tolerates — rewards — more nuance than X.
- **Telegram channel**: same copy as Mastodon usually works as-is.
- **IG**: pillar 2 (education) is the one that becomes carousels — reuse the
  Vault theme/render pipeline (`project_ig_content_pipeline`), don't write new
  IG-specific copy here unless explicitly asked.

## Operational note

There's no GitHub Actions poster for X/IG/Mastodon wired up yet (Mastodon's
native `scheduled_at` and Telegram's GHA cron exist; X/IG remain manual per
`automation_social_github_actions`). Until that's built, `queue/` is a
**human-curated bank**, not an auto-publisher — pull from it manually or feed
it into the VM queue. Building that automation is separate, future work.
