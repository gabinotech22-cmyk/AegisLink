// PM2 process file for the AegisLink relay — OPT-IN multi-worker mode.
//
// Extension is `.cjs` (not `.js`) because package.json sets `"type": "module"`
// and PM2 loads ecosystem files with `require()`, which needs CommonJS.
//
// IMPORTANT — this supervises `src/clusterMaster.ts`, NOT `src/index.ts`
// directly, and uses `exec_mode: 'fork'` with a SINGLE PM2 instance. This is
// deliberate, not a downgrade: PM2's own `exec_mode: 'cluster'` (an earlier
// version of this file used it directly on `src/index.ts`) turned out to be
// incompatible with sticky sessions for this app. PM2 cluster mode forks
// workers ITSELF, giving application code no hook to run as the true Node
// `cluster` primary — but `@socket.io/sticky`'s `setupMaster()` (which is
// what makes long-polling safe across workers) REQUIRES being called from
// the actual primary process. The fix, per Socket.IO's own "Using multiple
// nodes" docs: the app manages its OWN `cluster.fork()`-ing internally
// (src/clusterMaster.ts is the primary; it forks `AEGIS_CLUSTER_WORKERS`
// copies of the real app, src/index.ts) — so PM2 only ever needs to
// supervise that ONE outer process, same as any other single-process app.
// Full writeup: docs/RELAY-HORIZONTAL-SCALING.md.
//
// NOT wired into deploy/deploy.sh / deploy/setup.sh yet. Those scripts still
// run `pm2 start npm --name aegislink-relay -- start` (single instance,
// no internal clustering at all) against the real Hetzner VM — this file is
// deliberately NOT plumbed into that path in this change, per the golden
// rule that direct-prod-touching scripts are out of scope here. To actually
// run multi-worker on the VM, an operator opts in explicitly:
//
//   pm2 delete aegislink-relay          # remove the old single-process app
//   pm2 start ecosystem.config.cjs
//   pm2 save
//
// Before flipping this on in production, see docs/RELAY-HORIZONTAL-SCALING.md
// for the REQUIRED companion reading: whether Redis is provisioned yet
// (changes which cross-worker broadcast adapter activates — see
// src/index.ts's REDIS_URL / isClusterWorker branch), and why TLS_CERT_PATH
// direct termination is NOT supported in this mode (must terminate TLS in
// front of this process, e.g. nginx/Caddy).
module.exports = {
  apps: [
    {
      name: 'aegislink-relay',
      // The cluster PRIMARY/router (src/clusterMaster.ts), not the app
      // itself — it forks the app (src/index.ts) as its own children,
      // invisible to PM2. Same `node --import tsx` invocation `npm start`
      // uses, just pointed at the router entrypoint and run directly (not
      // via the `npm` wrapper) so `cluster.fork()` behaves predictably.
      script: 'src/clusterMaster.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      // Exactly ONE PM2-supervised process. The N real workers are this
      // process's own `cluster.fork()` children (see AEGIS_CLUSTER_WORKERS
      // below) — PM2 never sees or manages them directly, so `exec_mode`
      // stays 'fork' and `instances` stays 1. Do NOT set exec_mode:
      // 'cluster' here — see the file-level comment above for why that
      // breaks sticky sessions for this app.
      exec_mode: 'fork',
      instances: 1,
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
        // The real Hetzner VM today has 2 vCPUs — one worker per core is
        // predictable and matches the actual box. Bump this deliberately
        // (not via 'max', which src/clusterMaster.ts doesn't support) when
        // the VM is upgraded.
        AEGIS_CLUSTER_WORKERS: '2',
      },
      // This threshold is for the thin ROUTER process itself (it holds no
      // app state, just connection routing tables), which should stay well
      // under this — if it ever grows this large something is anomalous.
      // The N forked app workers are NOT covered by this (PM2 doesn't see
      // them); each worker process has its own memory footprint driven by
      // the same code as today's single-instance deployment.
      max_memory_restart: '512M',
      autorestart: true,
      restart_delay: 5000,
      merge_logs: true,
    },
  ],
};
