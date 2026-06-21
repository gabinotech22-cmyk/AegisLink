# dev.to AegisLog automation

Auto-publishes one queued dev.to article every Friday, under the **AegisLink**
organization, via GitHub Actions (`.github/workflows/devto-aegislog.yml`).

The human gate is this folder: **only markdown already written and merged into
`queue/` can ever be published.** The cron is just the courier — it never writes
content, only sends what a human already committed.

## How it works

- `queue/` — articles waiting to publish, named `NNNN-slug.md` (lowest number
  goes first). Each is a normal dev.to article: frontmatter + markdown body.
- `published/` — the workflow moves a file here after publishing it, so it is
  never posted twice. The move is committed back to the repo as an audit trail.
- Every Friday 15:00 UTC the workflow publishes the **single** lowest-numbered
  file in `queue/`. Next Friday it publishes the next one, and so on.

## Frontmatter

```yaml
---
title: "..."            # required
published: false        # the publisher flips this to true on send
tags: a, b, c, d        # max 4
series: "AegisLog"       # groups posts into a dev.to series
canonical_url:           # set if the post lives elsewhere first
# optional knobs:
draft: true              # skip this file entirely (stays in queue)
publish_after: 2026-07-01 # don't publish before this date
---
```

## One-time setup (done in GitHub / dev.to, not here)

1. dev.to → Settings → Extensions → **Generate API Key**.
2. GitHub repo → Settings → Secrets and variables → Actions:
   - **Secret** `DEV_TO_API_KEY` = the key above.
   - **Variable** `DEVTO_ORG_USERNAME` = the org slug (default `aegislink`).
   - Optional **Variable** `DEVTO_ORG_ID` if you'd rather pin the numeric id
     than have the script resolve it from the username.

## Testing without publishing

Run the workflow manually (Actions → "dev.to AegisLog" → Run workflow) with
**dry run** checked, or locally:

```bash
DRY_RUN=1 node scripts/devto-publish.mjs
```
