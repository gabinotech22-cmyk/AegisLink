#!/usr/bin/env bash
# Print a relay address as a QR code in the terminal and save it as
# relay-qr.png next to this script (gitignored), so users can scan it from
# AegisLink → Privacy → Network → My relay → "Scan relay QR" instead of
# typing 56 characters — or you can send them the PNG over a trusted channel.
# Needs `qrencode` (Debian/Ubuntu: sudo apt install qrencode). Without it,
# prints how to get it and exits 0: the QR is a convenience, never required.
set -euo pipefail
cd "$(dirname "$0")"
URL="${1:?usage: ./show-qr.sh http://<onion>.onion}"
if ! command -v qrencode >/dev/null 2>&1; then
  echo "  (Install qrencode to also get it as a QR code: sudo apt install qrencode, then ./print-onion.sh)"
  exit 0
fi
qrencode -t ANSIUTF8 -m 2 "$URL"
qrencode -o relay-qr.png -s 8 -m 2 "$URL"
echo "  Saved as $(pwd)/relay-qr.png"
