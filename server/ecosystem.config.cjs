// PM2 process file for the AegisLink relay — OPT-IN cluster mode.
//
// Extension is `.cjs` (not `.js`) because package.json sets `"type": "module"`
// and PM2 loads ecosystem files with `require()`, which needs CommonJS.
//
// NOT wired into deploy/deploy.sh / deploy/setup.sh yet. Those scripts still
// run `pm2 start npm --name aegislink-relay -- start` (single instance, fork
// mode) against the real Hetzner VM — this file is deliberately NOT plumbed
// into that path in this change, per the golden rule that direct-prod-touching
// scripts are out of scope here. To actually run in cluster mode on the VM,
// an operator opts in explicitly:
//
//   pm2 delete aegislink-relay          # remove the old fork-mode process
//   pm2 start ecosystem.config.cjs
//   pm2 save
//
// Before flipping this on in production, see docs/RELAY-HORIZONTAL-SCALING.md
// for the REQUIRED companion changes (REDIS_URL for both rate-limiting and
// the Socket.IO adapter, plus nginx sticky sessions — long-polling breaks
// across workers without them).
module.exports = {
  apps: [
    {
      name: 'aegislink-relay',
      // Run the TypeScript entrypoint directly via the `tsx` loader, exactly
      // like `npm start` does (package.json: "node --import tsx src/index.ts"),
      // but invoked without the `npm` wrapper: PM2's cluster mode forks
      // workers via Node's own `cluster` module, which requires the script to
      // be launched with `node` as the interpreter directly (a shell-wrapped
      // `npm start` is opaque to PM2 and silently falls back to fork mode).
      script: 'src/index.ts',
      interpreter: 'node',
      interpreter_args: '--import tsx',
      cwd: __dirname,
      exec_mode: 'cluster',
      // The real Hetzner VM today has 2 vCPUs. Pinning `instances: 2` (one
      // worker per core) is predictable and matches the actual box, unlike
      // `'max'` which silently changes behavior if the VM is ever resized.
      // Bump this (or switch to 'max') deliberately when the VM is upgraded.
      instances: 2,
      // Load the relay's existing .env (already created by deploy.sh at
      // APP_DIR/.env) the same way a plain `pm2 start npm -- start` would
      // pick up whatever env is already in the shell/systemd unit.
      env_file: '.env',
      env: {
        NODE_ENV: 'production',
      },
      max_memory_restart: '512M',
      autorestart: true,
      restart_delay: 5000,
      merge_logs: true,
    },
  ],
};
