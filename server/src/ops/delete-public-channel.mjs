/**
 * Ops maintenance — delete an (orphaned) public channel from the relay DB.
 *
 * Why this exists: a public channel whose owner identity was reset/lost becomes
 * an orphan — it lingers in the signed public directory with no key able to sign
 * a tombstone, so it can't be removed through the normal owner flow. This script
 * removes such a channel (and its posts + pending joins) directly, on the relay.
 *
 * Safety:
 *   - DRY RUN by default: prints what WOULD be deleted, changes nothing.
 *   - `--confirm` is required to actually delete.
 *   - Backs up every matched row (channel + posts + pending joins) to a JSON file
 *     BEFORE deleting, so a mistaken run is recoverable.
 *   - Refuses to delete more than one channel matched by name — pass `--id` to
 *     target a single channel unambiguously.
 *   - Deletes inside a transaction; rolls back on any error.
 *
 * Runs with plain node (uses the built-in node:sqlite, same driver as the app —
 * no TypeScript, so `tsc --noEmit` in the Docker build never touches it).
 *
 * Usage (inside the relay container, workdir /app):
 *   node src/ops/delete-public-channel.mjs "TESTERS"            # dry run / inspect
 *   node src/ops/delete-public-channel.mjs "TESTERS" --confirm  # delete
 *   node src/ops/delete-public-channel.mjs --id <channelId> --confirm
 *   node src/ops/delete-public-channel.mjs --list               # list all channels
 */

import { DatabaseSync } from 'node:sqlite';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const confirm = argv.includes('--confirm');
const listOnly = argv.includes('--list');
const idIdx = argv.indexOf('--id');
const wantId = idIdx >= 0 ? argv[idIdx + 1] : null;
const wantName = argv.find((a, i) => !a.startsWith('--') && !(idIdx >= 0 && i === idIdx + 1)) ?? null;

const DB_PATH = process.env.AEGIS_DB_PATH ?? '/data/aegislink.db';

/** Extract the human name committed inside a signed manifest blob (JSON). */
function manifestName(blob) {
  try {
    const m = JSON.parse(blob);
    return typeof m?.name === 'string' ? m.name : null;
  } catch {
    return null;
  }
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA busy_timeout = 5000;');

const allRows = db
  .prepare('SELECT channel_id, signed_manifest_blob, channel_type, created_at FROM public_channels')
  .all();
const all = allRows.map((r) => ({
  channel_id: r.channel_id,
  name: manifestName(r.signed_manifest_blob),
  channel_type: r.channel_type,
  created_at: r.created_at,
}));

if (listOnly || (!wantId && !wantName)) {
  if (!listOnly) {
    console.error('Usage: node src/ops/delete-public-channel.mjs "<name>" [--confirm]');
    console.error('   or: node src/ops/delete-public-channel.mjs --id <channelId> [--confirm]');
    console.error('   or: node src/ops/delete-public-channel.mjs --list\n');
  }
  console.log(`Public channels (${all.length}):`);
  for (const c of all) {
    console.log(`  ${c.channel_id}  "${c.name ?? '?'}"  type=${c.channel_type}`);
  }
  db.close();
  process.exit(listOnly ? 0 : 1);
}

let matches = wantId
  ? all.filter((c) => c.channel_id === wantId)
  : all.filter((c) => (c.name ?? '').toLowerCase() === wantName.toLowerCase());

if (matches.length === 0) {
  console.log(`No public channel matches ${wantId ? `id=${wantId}` : `name="${wantName}"`}. Nothing to do.`);
  console.log(`\nAll public channels (${all.length}):`);
  for (const c of all) console.log(`  ${c.channel_id}  "${c.name ?? '?'}"  type=${c.channel_type}`);
  db.close();
  process.exit(0);
}

const countPosts = db.prepare('SELECT COUNT(*) AS c FROM public_channel_posts WHERE channel_id = ?');
const countPending = db.prepare('SELECT COUNT(*) AS c FROM public_channel_pending_joins WHERE channel_id = ?');
for (const m of matches) {
  m.posts = countPosts.get(m.channel_id).c;
  m.pending = countPending.get(m.channel_id).c;
}

console.log(`Matched ${matches.length} channel(s):`);
for (const m of matches) {
  console.log(`  ${m.channel_id}  "${m.name ?? '?'}"  type=${m.channel_type}  posts=${m.posts}  pending=${m.pending}`);
}

if (!confirm) {
  console.log('\nDRY RUN — nothing deleted. Re-run with --confirm to delete the above.');
  db.close();
  process.exit(0);
}

if (matches.length > 1 && !wantId) {
  console.error(`\nRefusing to delete ${matches.length} channels matched by name. Re-run with --id <channelId> to target exactly one.`);
  db.close();
  process.exit(2);
}

// Back up every matched row before deleting so a mistake is recoverable.
const selChannel = db.prepare('SELECT * FROM public_channels WHERE channel_id = ?');
const selPosts = db.prepare('SELECT * FROM public_channel_posts WHERE channel_id = ?');
const selPending = db.prepare('SELECT * FROM public_channel_pending_joins WHERE channel_id = ?');
const backup = {};
for (const m of matches) {
  backup[m.channel_id] = {
    channel: selChannel.get(m.channel_id),
    posts: selPosts.all(m.channel_id),
    pending: selPending.all(m.channel_id),
  };
}
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const backupPath = `/tmp/deleted-public-channel-${ts}.json`;
writeFileSync(backupPath, JSON.stringify(backup, null, 2));
console.log(`\nBacked up matched rows → ${backupPath}`);

const delPosts = db.prepare('DELETE FROM public_channel_posts WHERE channel_id = ?');
const delPending = db.prepare('DELETE FROM public_channel_pending_joins WHERE channel_id = ?');
const delChannel = db.prepare('DELETE FROM public_channels WHERE channel_id = ?');

db.exec('BEGIN');
try {
  for (const m of matches) {
    delPosts.run(m.channel_id);
    delPending.run(m.channel_id);
    delChannel.run(m.channel_id);
  }
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  console.error(`Delete failed, rolled back: ${e instanceof Error ? e.message : String(e)}`);
  db.close();
  process.exit(1);
}

console.log(`Deleted ${matches.length} channel(s) + their posts/pending joins. Backup at ${backupPath}.`);
db.close();
