#!/usr/bin/env node
/**
 * loadtest.mjs — backward-compatible entrypoint for the 1:1 messaging scenario.
 *
 * The load-test harness grew into scenario modules under scripts/loadtest/. This
 * shim preserves the original command so existing runbooks keep working:
 *
 *   node scripts/loadtest.mjs [--url http://127.0.0.1:3101] [--clients 50] [--msgs 15] [--payload 1024]
 *
 * For the full harness (offline-drain, reconnect-storm, …) use:
 *   node scripts/loadtest/run.mjs --scenario <name> ...
 *
 * LOCAL TARGETS ONLY by default — production hosts are refused unless
 * --i-understand-this-is-prod is passed (see scripts/loadtest/lib.mjs).
 */

import { makeArgReader, hasFlag, guardUrl, startEventLoopMonitor } from './loadtest/lib.mjs';
import { messaging } from './loadtest/scenarios.mjs';

const arg = makeArgReader();
const BASE_URL = arg('url', 'http://127.0.0.1:3101');
const opts = {
  clients: Number(arg('clients', '50')),
  msgs: Number(arg('msgs', '15')),
  payloadBytes: Number(arg('payload', '1024')),
};

guardUrl(BASE_URL, hasFlag('i-understand-this-is-prod'));

console.log(`AegisLink loadtest (1:1 messaging) → ${BASE_URL}`);
console.log(`${opts.clients} clients, ${opts.msgs} msgs/sender, ${opts.payloadBytes} B payloads\n`);

const loop = startEventLoopMonitor();
const result = await messaging(BASE_URL, opts);
const lag = loop.stop();

if (result.fatal) {
  console.error((result.errors ?? []).join('\n'));
  process.exit(1);
}
console.log('══ RESULTS ═══════════════════════════════════');
for (const line of result.lines ?? []) console.log(line);
console.log(`harness loop-lag  mean ${lag.meanMs.toFixed(1)}ms · p99 ${lag.p99Ms.toFixed(1)}ms · max ${lag.maxMs.toFixed(1)}ms`);
if (result.errors?.length) {
  console.log(`errors: ${result.errors.length}`);
  for (const e of result.errors.slice(0, 10)) console.log(e);
}
process.exit(result.ok && !result.errors?.length ? 0 : 1);
