/**
 * clusterMaster.ts — the ONLY correct entrypoint for running >1 relay worker
 * on a single machine (PM2 "cluster mode" on its own, without this file,
 * CANNOT provide sticky sessions — see docs/RELAY-HORIZONTAL-SCALING.md for
 * the full "why" and the architectural dead-end this replaces).
 *
 * This process is a thin traffic router. It:
 *   1. Holds the ONE real listening socket on `PORT`.
 *   2. Routes every raw HTTP connection to the worker that owns that
 *      client's session (`@socket.io/sticky`, keyed by Engine.IO's `sid`
 *      query param) — so a client's long-polling requests always land on
 *      the same worker, and its eventual websocket upgrade lands there too.
 *   3. Wires up `@socket.io/cluster-adapter` (`setupPrimary()`) so events
 *      broadcast by one worker (e.g. `io.to(socketId).emit(...)`) reach
 *      sockets held by ANY sibling worker, over IPC — no Redis needed for
 *      this same-machine case (Redis remains the mechanism for actual
 *      multi-VM scale-out, see relay/socketIoRedisAdapter.ts).
 *   4. Forks N workers that run the REAL app (src/index.ts) — Node's
 *      `cluster.fork()` re-executes `process.argv[1]` by default, so
 *      `cluster.setupPrimary({ exec })` below repoints forked children at
 *      `index.ts` instead of re-running this router file.
 *
 * `src/index.ts` detects it is running as a forked worker via
 * `cluster.isWorker` (true ONLY for processes spawned by an actual
 * `cluster.fork()` call — never for a plain `pm2 start`/`child_process.fork`
 * child, so this is a safe, PM2-agnostic signal) and adjusts accordingly:
 * it skips its own `httpServer.listen(...)` (this master already owns the
 * real socket and hands off raw connections) and calls
 * `setupWorker(io)` to receive them.
 *
 * Run directly with: `node --import tsx src/clusterMaster.ts`
 * (see `server/ecosystem.config.cjs` for the PM2-supervised version — PM2
 * runs ONLY this one process, in fork mode; the N workers below are this
 * process's own children, invisible to and unmanaged by PM2).
 */
import cluster from 'node:cluster';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { setupMaster } from '@socket.io/sticky';
import { setupPrimary } from '@socket.io/cluster-adapter';

if (!cluster.isPrimary) {
  // Should be unreachable: `cluster.setupPrimary({ exec })` below repoints
  // every forked WORKER at src/index.ts, never back at this file. If this
  // throws, something forked a worker using this file directly — fail loud
  // rather than silently running two competing "masters".
  throw new Error('clusterMaster.ts must only run as the cluster primary process, never as a forked worker.');
}

const PORT = Number(process.env.PORT ?? 3001);
const WORKER_COUNT = Number(process.env.AEGIS_CLUSTER_WORKERS ?? 2);

const workerEntry = fileURLToPath(new URL('./index.js', import.meta.url));

cluster.setupPrimary({
  exec: workerEntry,
  // Inherit the exact node flags this master itself was launched with
  // (notably `--import tsx`, needed to run the .ts entrypoint directly) —
  // this is already `cluster.settings.execArgv`'s default, kept explicit
  // here so the dependency on tsx being present in execArgv is obvious.
  execArgv: process.execArgv,
});

const httpServer = createServer();

// Sticky routing: keyed by the `sid` query param Engine.IO already sends on
// every polling request and the websocket upgrade — no cookies needed.
setupMaster(httpServer, { loadBalancingMethod: 'least-connection' });

// Cross-worker broadcast for THIS machine's workers (IPC-based, no Redis).
setupPrimary();

httpServer.on('error', (err) => {
  // nosemgrep: aegislink-no-console-log-production
  console.error('[aegislink-cluster-master] FATAL httpServer error:', err instanceof Error ? err.message : String(err));
  process.exit(1);
});

httpServer.listen(PORT, '0.0.0.0', () => {
  // nosemgrep: aegislink-no-console-log-production
  console.log(`[aegislink-cluster-master] routing http://0.0.0.0:${PORT} across ${WORKER_COUNT} worker(s)`);
});

for (let i = 0; i < WORKER_COUNT; i++) {
  cluster.fork();
}

cluster.on('exit', (worker, code, signal) => {
  // nosemgrep: aegislink-no-console-log-production
  console.error(`[aegislink-cluster-master] worker pid=${worker.process.pid} exited (code=${code}, signal=${signal ?? 'none'}) — forking a replacement`);
  cluster.fork();
});
