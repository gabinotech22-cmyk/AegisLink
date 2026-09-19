#!/usr/bin/env bash
# Print the relay's .onion address (persisted in the tor_keys volume).
set -euo pipefail
cd "$(dirname "$0")"
ONION="$(docker compose exec -T tor cat /var/lib/tor/aegislink_relay/hostname 2>/dev/null | tr -d '[:space:]' || true)"
if [ -z "$ONION" ]; then echo "onion not published yet (is the tor container running?)" >&2; exit 1; fi
echo "http://${ONION}"
