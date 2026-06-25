# Social post queue

Ready-to-post drafts, organized by the 6 pillars in `../STRATEGY.md`. This is
a **manual human gate**, not an automated publisher (see "Operational note"
in the strategy doc) — nothing here goes out until a person copies it to the
platform.

## How to use

1. Open the lowest-numbered `bank-NNN.md` file.
2. Pick the next unposted item in roughly pillar-mix order (don't post three
   pillar-1 items in a row even if they're first in the file).
3. Copy the variant for the target platform (`x:` / `mastodon:` / `telegram:`).
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
