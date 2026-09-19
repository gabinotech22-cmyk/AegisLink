#!/usr/bin/env bash
# Archive the onion identity key (tor_keys volume). Keep the archive OFFLINE:
# whoever holds it can impersonate your relay's address.
set -euo pipefail
cd "$(dirname "$0")"
OUT="${1:-tor_keys-$(date +%Y%m%d-%H%M%S).tar.gz}"
VOL="$(docker volume ls -q --filter name=tor_keys | head -1)"
if [ -z "$VOL" ]; then echo "tor_keys volume not found (run ./up.sh first)" >&2; exit 1; fi
docker run --rm -v "${VOL}:/keys:ro" -v "$PWD:/out" alpine:3.24 tar czf "/out/${OUT}" -C /keys .
chmod 600 "$OUT"
echo "[selfhost] onion key archived to ${OUT} (mode 600) — store it offline"
