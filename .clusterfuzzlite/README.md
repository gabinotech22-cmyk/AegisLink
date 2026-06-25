# ClusterFuzzLite integration

Continuous, coverage-guided fuzzing that runs **in our own CI** (GitHub
Actions), no external onboarding required. Recommended to us by an OSS-Fuzz
maintainer ([google/oss-fuzz#15783](https://github.com/google/oss-fuzz/pull/15783))
as the right fit until the project has a wide enough user base for OSS-Fuzz.

It reuses the exact same Jazzer.js targets and build logic as the OSS-Fuzz
integration — see [`infra/oss-fuzz/`](../infra/oss-fuzz/),
[`mobile/fuzz/`](../mobile/fuzz/) and the target/seed definitions in
[`mobile/src/fuzz/targets.ts`](../mobile/src/fuzz/targets.ts).

## Layout

| File | Purpose |
|------|---------|
| `Dockerfile` | `base-builder-javascript`; copies the **local** checkout (the PR/commit under test) into the container. |
| `build.sh` | Thin wrapper — delegates to `infra/oss-fuzz/build.sh` so OSS-Fuzz and ClusterFuzzLite never drift. |

## Workflows

| Workflow | Trigger | Mode | Purpose |
|----------|---------|------|---------|
| `.github/workflows/cflite_pr.yml` | pull_request | `code-change` | Fuzz only what the PR touches; a new parser crash fails the PR. SARIF → Security tab. |
| `.github/workflows/cflite_batch.yml` | daily cron + manual | `batch` | Longer run over all targets to surface deeper bugs. |
| `.github/workflows/cflite_build.yml` | push to `main` | build only | Caches the main build so PR runs can tell new crashes from pre-existing ones. |

All use `language: javascript` and `sanitizer: none` (Jazzer.js does not use C
sanitizers — matches `infra/oss-fuzz/project.yaml`).

## Optional follow-ups

These need a dedicated **storage repo** (a separate GitHub repo holding the
accumulated corpus + coverage), so they are intentionally left out of the
initial setup:

- **Corpus persistence** across batch runs (`storage-repo` input) — today each
  batch run starts from the in-tree seeds.
- **Coverage reports** (`cflite_cron.yml`, mode `coverage`) and **corpus
  pruning** (mode `prune`).

To enable: create a storage repo, add a deploy key / token, and set the
`storage-repo` / `storage-repo-branch` inputs on each action. See
<https://google.github.io/clusterfuzzlite/>.
