#!/usr/bin/env node
/**
 * loadtest/run.mjs — AegisLink relay load-test runner.
 *
 * Exercises the real protocol (PoW registration → NaCl challenge-response socket
 * auth → sealed envelopes) across selectable scenarios, measuring latency,
 * throughput, error and rate-limit counts, plus the harness's own event-loop lag.
 *
 * Usage (from server/):
 *   node scripts/loadtest/run.mjs --scenario messaging       --clients 50  --msgs 15
 *   node scripts/loadtest/run.mjs --scenario offline-drain   --clients 50  --msgs 15
 *   node scripts/loadtest/run.mjs --scenario reconnect-storm --clients 200
 *   node scripts/loadtest/run.mjs --scenario all             --clients 50
 *
 * Targets LOCAL by default (http://127.0.0.1:3101). Production hosts are refused
 * unless you pass --i-understand-this-is-prod (pre-launch window only).
 *
 * SERVER-SIDE metrics (CPU, RSS, event-loop lag) are NOT visible from here — the
 * relay is remote. Watch `pm2 monit` / `pm2 logs aegislink-relay` on the box for
 * the run. The prod bottleneck is synchronous SQLite blocking the single event
 * loop, so server-side loop lag is the number that matters — read it there.
 */

import { makeArgReader, hasFlag, guardUrl, startEventLoopMonitor } from './lib.mjs';
import { SCENARIOS } from './scenarios.mjs';

const arg = makeArgReader();
const BASE_URL = arg('url', 'http://127.0.0.1:3101');
const SCENARIO = arg('scenario', 'messaging');
const opts = {
  clients: Number(arg('clients', '50')),
  msgs: Number(arg('msgs', '15')),
  payloadBytes: Number(arg('payload', '1024')),
};

guardUrl(BASE_URL, hasFlag('i-understand-this-is-prod'));

const toRun = SCENARIO === 'all' ? Object.keys(SCENARIOS) : [SCENARIO];
for (const name of toRun) {
  if (!SCENARIOS[name]) {
    console.error(`Unknown scenario "${name}". Available: ${Object.keys(SCENARIOS).join(', ')}, all`);
    process.exit(1);
  }
}

console.log(`AegisLink loadtest → ${BASE_URL}`);
console.log(`scenarios: ${toRun.join(', ')} · clients ${opts.clients} · msgs ${opts.msgs} · payload ${opts.payloadBytes}B\n`);

let anyFail = false;
for (const name of toRun) {
  console.log(`══ ${name} ${'═'.repeat(Math.max(0, 44 - name.length))}`);
  const loop = startEventLoopMonitor();
  let result;
  try {
    result = await SCENARIOS[name](BASE_URL, opts);
  } catch (e) {
    console.error(`  crashed: ${e?.stack ?? e}`);
    anyFail = true;
    loop.stop();
    continue;
  }
  const lag = loop.stop();

  if (result.fatal) {
    console.error(`  fatal — could not set up:\n  ${(result.errors ?? []).slice(0, 10).join('\n  ')}`);
    anyFail = true;
    continue;
  }
  for (const line of result.lines ?? []) console.log(`  ${line}`);
  console.log(`  harness loop-lag  mean ${lag.meanMs.toFixed(1)}ms · p99 ${lag.p99Ms.toFixed(1)}ms · max ${lag.maxMs.toFixed(1)}ms`);
  if (result.errors?.length) {
    console.log(`  errors: ${result.errors.length}`);
    for (const e of result.errors.slice(0, 10)) console.log(`    ${e}`);
  }
  if (!result.ok) anyFail = true;
  console.log('');
}

process.exit(anyFail ? 1 : 0);
