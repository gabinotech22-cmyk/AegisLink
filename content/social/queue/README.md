# Social post queue

Ready-to-post drafts, organized by the 6 pillars in `../STRATEGY.md`.

**As of 2026-06-25, Telegram and Mastodon are automated** (see "Operational
note" in the strategy doc) — the `mastodon:`/`telegram:` variants of
`bank-001.md` were copied into the private `aegislink-social` repo's
publishing queues (`social/queue/telegram-queue.json`, scheduled server-side
via `schedule-mastodon-bank-001.ps1`) and post on their own. **Don't
hand-copy those two variants out of `bank-001.md` — they'd duplicate.**

**X is still a manual human gate.** Nothing in the `x:` column goes out
until a person copies it to the platform.

## How to use (X only, for now)

1. Open the lowest-numbered `bank-NNN.md` file.
2. Pick the next unposted item in roughly pillar-mix order (don't post three
   pillar-1 items in a row even if they're first in the file).
3. Copy the `x:` variant to X.
4. After posting, check it off (`- [ ]` → `- [x]`) and commit that change —
   this is the audit trail, same idea as `content/devto/published/`.
5. When a `bank-NNN.md` file is fully checked off, move it to
   `../published/bank-NNN.md`.

## Freshness warning

Pillar 1 (current events) items are dated. If a post references a status
("trilogue scheduled for X") that has since resolved, **don't post it** —
update it with the actual outcome or drop it. Verify the underlying news is
still accurate before copying it out, especially anything more than a couple
weeks old.

## Files

- `bank-001.md` — 18 posts, first batch (written 2026-06-25)
- `bank-002.md` — Android Closed Testing launch: 3 queue posts + one-shot
  community posts (Reddit ×4, Show HN) with their own posting ground rules
  (written 2026-07-06)
