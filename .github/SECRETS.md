# GitHub Actions — required secrets & access register

Configure secrets at: **repo → Settings → Secrets and variables → Actions → New repository secret**.

> ⚠️ Never put user data, real message content, private keys, or at-rest
> encryption keys into a GitHub secret. Secrets here are CI/deploy credentials
> only. The relay's app secrets (TURN, push, GIF provider) live in the VM's
> `/home/ubuntu/aegislink/.env` and are **never** touched by CI.

---

## EAS Build (mobile iOS + Android)

| Secret | Description | How to obtain |
|--------|-------------|----------------|
| `EXPO_TOKEN` | EAS access token | expo.dev → Account Settings → Access Tokens → Create |

Optional, only for App Store submissions (`eas submit`):

| Secret | Description |
|--------|-------------|
| `APPLE_ID` | Apple ID email for App Store Connect |
| `ASC_APP_ID` | App Store Connect numeric app ID |

---

## Deploy SSH (relay — Hetzner VM, systemd)

The relay runs on a **Hetzner Cloud** VM (Helsinki), **not** AWS/PM2. The
manual `Deploy relay (manual)` workflow (`.github/workflows/deploy.yml`,
`workflow_dispatch` only) ships `server/src` over SSH, runs
`npm ci --omit=dev`, restarts the systemd unit, and health-checks with
automatic rollback.

| Secret | Description | Value shape |
|--------|-------------|-------------|
| `DEPLOY_HOST` | Public IP / hostname of the relay VM | e.g. `157.180.116.176` |
| `DEPLOY_USER` | SSH user on the VM | `ubuntu` |
| `DEPLOY_SSH_KEY` | Full private key authorized on the VM (dedicated CI key) | contents of the CI private key |

Real VM layout (verified over SSH; mirrored in `deploy.yml`):

- **code:** `/home/ubuntu/aegislink/server` (no git checkout on the VM)
- **service:** systemd unit `aegislink` → `node_modules/.bin/tsx src/index.ts`
- **env:** `/home/ubuntu/aegislink/.env` (systemd `EnvironmentFile` — never touched by CI)
- **health:** `http://127.0.0.1:3001/health` (local) / `https://aegislink.duckdns.org/health` (public)
- **nginx, coturn, landing:** managed separately (`infra/nginx/*`, `infra/deploy-web.sh`) over SSH, not by CI

### Generate a dedicated CI SSH key (recommended)

```bash
# On your local machine
ssh-keygen -t ed25519 -C "aegislink-ci" -f ~/.ssh/aegislink_ci -N ""

# Authorize on the VM
ssh-copy-id -i ~/.ssh/aegislink_ci.pub ubuntu@<VM_IP>

# DEPLOY_SSH_KEY value is the contents of the private key:
cat ~/.ssh/aegislink_ci
```

---

## Access register (who/what holds privileged access)

OSTIF best-practices step 6 — keep an explicit inventory of access. Update
this table when access is granted, rotated, or revoked. **No credentials go
in this file**, only *who/what* and *where the secret lives*.

| Asset | Held by | Stored where | Rotation |
|-------|---------|--------------|----------|
| Relay VM SSH (deploy) | maintainer + CI | local `~/.ssh/aegislink_ci` (CI key in `DEPLOY_SSH_KEY`) | rotate if CI key exposure suspected |
| Relay VM root/sudo | maintainer | local SSH key (`~/.ssh/aegislink_hetzner`) | rotate on suspicion |
| EAS / Expo | maintainer | `EXPO_TOKEN` secret + expo.dev account | revoke + reissue in expo.dev |
| Relay app secrets (TURN, push, GIF) | relay process | VM `/home/ubuntu/aegislink/.env` | per-service in provider console |
| GitHub repo admin | maintainer | GitHub account (2FA) | — |
| Push/FCM credentials | EAS + Firebase | EAS GraphQL + Firebase console (key restricted) | re-upload to EAS if rotated |

> When a CI build's signing identity changes (new keystore SHA-1), add it to the
> Firebase API-key allowlist or external push breaks — see project notes.
