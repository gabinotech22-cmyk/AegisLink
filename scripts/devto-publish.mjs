#!/usr/bin/env node
// Publish the next queued dev.to article under the AegisLink organization.
//
// Reads the alphabetically-first markdown file in content/devto/queue/, posts it
// to the dev.to (Forem) API as a PUBLISHED article under the org, then moves the
// file to content/devto/published/ so it is never posted twice.
//
// The human gate is the repo itself: only markdown that has been written and
// merged into the queue gets published. The cron is just the courier.
//
// Env:
//   DEV_TO_API_KEY       (required) dev.to API key — Settings > Extensions
//   DEVTO_ORG_USERNAME   (optional) org slug on dev.to, default "aegislink"
//   DEVTO_ORG_ID         (optional) numeric org id; resolved from username if absent
//   DRY_RUN=1            (optional) parse + report, but do not publish or move
//
// Per-file frontmatter knobs (optional):
//   draft: true          -> skip this file entirely
//   publish_after: <ISO> -> skip until that date has passed

import { readdir, readFile, rename, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

const API = 'https://dev.to/api';
const KEY = process.env.DEV_TO_API_KEY;
const ORG_USERNAME = process.env.DEVTO_ORG_USERNAME || 'aegislink';
const QUEUE_DIR = 'content/devto/queue';
const PUBLISHED_DIR = 'content/devto/published';
const DRY = process.env.DRY_RUN === '1';

function parseFrontmatter(md) {
  const m = md.match(/^---\n([\s\S]*?)\n---/);
  const fm = {};
  if (m) {
    for (const line of m[1].split('\n')) {
      const i = line.indexOf(':');
      if (i > -1) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim().replace(/^["']|["']$/g, '');
    }
  }
  return fm;
}

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: { 'api-key': KEY, 'content-type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  if (!res.ok) throw new Error(`${opts.method || 'GET'} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function main() {
  if (!KEY && !DRY) {
    console.error('DEV_TO_API_KEY is not set.');
    process.exit(1);
  }

  let files;
  try {
    files = (await readdir(QUEUE_DIR)).filter((f) => f.endsWith('.md')).sort();
  } catch {
    console.log(`No queue directory (${QUEUE_DIR}) — nothing to do.`);
    return;
  }
  if (!files.length) {
    console.log('Queue empty — nothing to publish.');
    return;
  }

  const file = files[0];
  const path = join(QUEUE_DIR, file);
  const body = await readFile(path, 'utf8');
  const fm = parseFrontmatter(body);
  const title = fm.title || file;
  console.log(`Next in queue: ${file} — "${title}"`);

  if (fm.draft === 'true') {
    console.log('Frontmatter marks draft: true — skipping this run.');
    return;
  }
  if (fm.publish_after) {
    const when = Date.parse(fm.publish_after);
    if (!Number.isNaN(when) && Date.now() < when) {
      console.log(`publish_after (${fm.publish_after}) not reached — skipping.`);
      return;
    }
  }

  if (DRY) {
    console.log(`[dry-run] would publish "${title}" under org "${ORG_USERNAME}".`);
    return;
  }

  // Resolve org id (article creation needs the numeric id).
  let orgId = process.env.DEVTO_ORG_ID;
  if (!orgId) {
    const org = await api(`/organizations/${ORG_USERNAME}`);
    orgId = org.id;
  }
  console.log(`Publishing under org "${ORG_USERNAME}" (id ${orgId}).`);

  // Idempotency guard: if an article with this exact title is already published,
  // do not post a duplicate — just retire the queue file.
  const mine = await api('/articles/me/published?per_page=1000');
  const already = Array.isArray(mine) && mine.find((a) => a.title === title);

  if (already) {
    console.log(`Already published (${already.url}) — retiring queue file without re-posting.`);
  } else {
    // dev.to parses the frontmatter inside body_markdown; force it live on send.
    const toSend = body.replace(/^(---[\s\S]*?\bpublished:\s*)false/m, '$1true');
    const created = await api('/articles', {
      method: 'POST',
      body: JSON.stringify({ article: { body_markdown: toSend, organization_id: Number(orgId) } }),
    });
    console.log(`Published: ${created.url}`);
  }

  await mkdir(PUBLISHED_DIR, { recursive: true });
  await rename(path, join(PUBLISHED_DIR, file));
  console.log(`Moved ${file} -> ${PUBLISHED_DIR}/`);
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
