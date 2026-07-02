#!/usr/bin/env bash
# scripts/cleanup-test-channels.sh — remove test channels from the prod relay DB by name.
#
# Public channels can only be tombstoned with the channel's Ed25519 key, which
# lives on the creating device. When test channels are orphaned (e.g. the
# duplicate "testers" channels created by the 2026-07-02 double-tap bug), the
# only cleanup path is direct DB surgery on the relay host.
#
# The channel name is CLEARTEXT inside signed_manifest_blob (public directory
# metadata) — no secrets are read or printed by this script.
#
# Usage:
#   bash scripts/cleanup-test-channels.sh --name testers            # dry run (list matches)
#   bash scripts/cleanup-test-channels.sh --name testers --apply    # delete matches
#
# Env overrides: AEGIS_SSH_HOST (default aegislink.duckdns.org),
#                AEGIS_SSH_USER (default root), AEGIS_SSH_KEY (path to key).

set -euo pipefail

HOST="${AEGIS_SSH_HOST:-aegislink.duckdns.org}"
USER="${AEGIS_SSH_USER:-root}"
KEY="${AEGIS_SSH_KEY:-}"
COMPOSE="/opt/aegislink/docker-compose.yml"
NAME=""
APPLY=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name) NAME="$2"; shift 2 ;;
    --apply) APPLY=1; shift ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "ERROR: --name <channel name> is required." >&2
  exit 1
fi

SSH_OPTS=()
[[ -n "$KEY" ]] && SSH_OPTS+=(-i "$KEY")

# Runs inside the relay container: match rows whose manifest name equals the
# target (trimmed, case-insensitive), then list or delete channel + posts +
# pending joins. The relay uses Node's built-in node:sqlite (see
# server/src/db/sqlite.ts), so no external driver is needed.
JS=$(cat <<'EOF'
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(process.env.AEGIS_DB_PATH || '/data/aegislink.db');
const target = process.env.TARGET_NAME.trim().toLowerCase();
const apply = process.env.APPLY === '1';
const rows = db.prepare('SELECT channel_id, signed_manifest_blob, created_at FROM public_channels').all();
const matches = rows.filter((r) => {
  try { return String(JSON.parse(r.signed_manifest_blob).name || '').trim().toLowerCase() === target; }
  catch { return false; }
});
console.log(`scanned ${rows.length} channels, ${matches.length} match name "${target}"`);
for (const m of matches) console.log(`  ${m.channel_id}  created_at=${m.created_at}`);
if (!apply) { console.log('DRY RUN -- nothing deleted. Re-run with --apply.'); process.exit(0); }
db.exec('BEGIN');
try {
  const delPosts = db.prepare('DELETE FROM public_channel_posts WHERE channel_id = ?');
  const delJoins = db.prepare('DELETE FROM public_channel_pending_joins WHERE channel_id = ?');
  const delChan  = db.prepare('DELETE FROM public_channels WHERE channel_id = ?');
  for (const m of matches) { delPosts.run(m.channel_id); delJoins.run(m.channel_id); delChan.run(m.channel_id); }
  db.exec('COMMIT');
} catch (e) { db.exec('ROLLBACK'); throw e; }
console.log(`deleted ${matches.length} channels (+ posts + pending joins).`);
EOF
)

ssh "${SSH_OPTS[@]}" "$USER@$HOST" \
  "docker compose -f $COMPOSE exec -T -e TARGET_NAME=$(printf '%q' "$NAME") -e APPLY=$APPLY relay node --experimental-sqlite -e $(printf '%q' "$JS")"
