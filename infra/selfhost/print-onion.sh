#!/usr/bin/env bash
# Print the relay's .onion address (persisted in the tor_keys volume) and,
# on stderr, its QR code (show-qr.sh) — stdout stays just the address.
set -euo pipefail
cd "$(dirname "$0")"
ONION="$(docker compose exec -T tor cat /var/lib/tor/aegislink_relay/hostname 2>/dev/null | tr -d '[:space:]' || true)"
if [ -z "$ONION" ]; then echo "onion not published yet (is the tor container running?)" >&2; exit 1; fi
echo "http://${ONION}"
# `--no-qr` for scripts that only want the address on stdout.
if [ "${1:-}" != "--no-qr" ]; then ./show-qr.sh "http://${ONION}" >&2; fi
