#!/usr/bin/env bash
# AegisLink self-hosted relay — bring it up and print the address users need.
# Idempotent: safe to re-run after `git pull` (rebuilds, keeps data + onion key).
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .env ]; then
  cp .env.example .env
  echo "[selfhost] created .env from .env.example"
fi

# Fill the two mandatory secrets if the operator left them empty.
gen_secret() { openssl rand -hex 32 2>/dev/null || head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'; }
for key in BLOB_SECRET TURN_SECRET; do
  if ! grep -Eq "^${key}=.+" .env; then
    sed -i.bak "/^${key}=/d" .env && rm -f .env.bak
    echo "${key}=$(gen_secret)" >> .env
    echo "[selfhost] generated ${key}"
  fi
done

echo "[selfhost] building + starting relay, tor, ntfy…"
docker compose up -d --build

echo "[selfhost] waiting for the onion service (first boot generates the key)…"
for _ in $(seq 1 60); do
  ONION="$(docker compose exec -T tor cat /var/lib/tor/aegislink_relay/hostname 2>/dev/null | tr -d '[:space:]' || true)"
  [ -n "$ONION" ] && break
  sleep 2
done
if [ -z "${ONION:-}" ]; then
  echo "[selfhost] tor has not published the onion yet — run ./print-onion.sh in a minute" >&2
  exit 1
fi

echo
echo "  Your relay:  http://${ONION}"
echo
echo "  In AegisLink: Privacy → Network → My relay → paste the .onion → Verify → Switch."
echo "  Back up the tor_keys volume: losing it changes this address."
echo
