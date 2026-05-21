# SSL Setup — AegisLink

## First-time setup (run once on the VM)

```bash
# 1. SSH into the Oracle Cloud VM
ssh ubuntu@<VM_PUBLIC_IP>

# 2. Ensure the project is cloned/uploaded to /opt/aegislink
# (or wherever DEPLOY_PATH is configured)

# 3. Run the setup script as root
sudo bash /opt/aegislink/infra/ssl/setup-ssl.sh
```

The script is idempotent — running it a second time is safe and will skip steps already done (certbot uses `--keep-until-expiring`).

## What the script does

1. Installs nginx and certbot if missing.
2. Creates a temporary HTTP config so certbot can pass the ACME challenge.
3. Obtains a Let's Encrypt certificate for `aegislink.duckdns.org`.
4. Writes the final TLS + WebSocket reverse-proxy config (port 443 → relay :3001).
5. Installs a daily cron (`0 3 * * *`) that runs `renew-ssl.sh` for automatic renewal.

## Verifying SSL

```bash
curl -v https://aegislink.duckdns.org/health
# Expected: HTTP 200 with body {"status":"ok"}

# Check certificate expiry
openssl s_client -connect aegislink.duckdns.org:443 </dev/null 2>/dev/null \
  | openssl x509 -noout -dates
```

## Manual renewal (normally automatic)

```bash
sudo bash /opt/aegislink/infra/ssl/renew-ssl.sh
```
