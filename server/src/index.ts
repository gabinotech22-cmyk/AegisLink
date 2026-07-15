import express from 'express';
import cors from 'cors';
import cluster from 'node:cluster';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { Server as SocketServer } from 'socket.io';
import { setupWorker } from '@socket.io/sticky';
import identityRoutes from './routes/identity.js';
import pushRoutes from './routes/push.js';
import web3Routes from './routes/web3.js';
import prekeysRoutes from './routes/prekeys.js';
import blobRoutes from './routes/blob.js';
import backupRoutes from './routes/backup.js';
import linksRoutes from './routes/links.js';
import turnRoutes from './routes/turn.js';
import proxyGifRoutes from './routes/proxyGif.js';
import proxyLinkPreviewRoutes from './routes/proxyLinkPreview.js';
import { createWorkRouter } from './routes/work.js';
import { createPublicChannelsRouter } from './routes/publicChannels.js';
import { attachRelay } from './relay/handler.js';
import { attachSocketIoRedisAdapter } from './relay/socketIoRedisAdapter.js';
import { attachSocketIoClusterAdapter } from './relay/socketIoClusterAdapter.js';
import { initDb, messageRepo, senderKeyDistRepo, pruneExpiredWorkMessages, pushEndpointRepo, pushMailboxTokenRepo } from './db/client.js';

// ── Last-resort error handlers ───────────────────────────────────────────────
// Log only the error itself (never envelope payloads or user identifiers) to
// journald and exit non-zero so systemd (Restart=always, RestartSec=5) replaces
// the process with a clean one. A half-broken relay must never keep serving:
// clients retry and the offline queue absorbs the ~5 s restart window.
process.on('uncaughtException', (err) => {
  console.error('[aegislink-server] FATAL uncaughtException:', err);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[aegislink-server] FATAL unhandledRejection:', reason);
  process.exit(1);
});

const PORT = Number(process.env.PORT ?? 3001);
const IS_PROD = process.env.NODE_ENV === 'production';

// True ONLY for a process forked via Node's own `cluster.fork()` (signaled by
// `NODE_UNIQUE_ID`, which Node sets internally) — i.e. exactly the workers
// spawned by src/clusterMaster.ts. A plain `pm2 start`/`node src/index.ts`
// process (dev, Docker, PM2 fork mode) is never a cluster worker, so this
// check is a safe, deployment-agnostic signal. See docs/RELAY-HORIZONTAL-SCALING.md
// for why PM2's own `exec_mode: 'cluster'` is NOT used for this (it cannot
// provide the sticky-session routing Socket.IO long-polling needs).
const isClusterWorker = cluster.isWorker;
// Dev defaults to '*' so React Native / Expo Go (which doesn't send a stable
// Origin) can connect from physical phones on LAN. In PRODUCTION we refuse to
// default to '*' (fail closed, golden rule #6): browser origins must match the
// explicit CORS_ORIGIN allowlist (plus the known own-domain below). Origin-less
// clients (native mobile, Electron file://, curl) are unaffected either way.
const ORIGIN = process.env.CORS_ORIGIN ?? (IS_PROD ? '' : '*');
if (IS_PROD && !process.env.CORS_ORIGIN) {
  console.warn(
    '[aegislink-server] CORS_ORIGIN not set in production — browser CORS is ' +
      'restricted to the known own-domain. Set CORS_ORIGIN to allow other origins.'
  );
}

const app = express();

// Trust the first proxy hop so express-rate-limit reads the real client IP
// from X-Forwarded-For when deployed behind nginx/caddy/etc.
// Set to 1 (one trusted proxy) — adjust to 0 if running without a reverse proxy.
const TRUST_PROXY_SETTING = Number(process.env.TRUST_PROXY ?? 1);
app.set('trust proxy', TRUST_PROXY_SETTING);
// Safety net for a stale `.env` on the box: if this ever ships as 0 in
// production, express ignores X-Forwarded-For and every per-IP rate limiter
// (registrationLimiter, challengeLimiter, lookupLimiter, etc.) falls back to
// the raw socket IP — always nginx's own loopback address — so every client
// in the world collapses into ONE shared bucket. This does not touch the
// TRUST_PROXY default (still 1); it only makes a misconfigured box loud in
// the startup logs instead of silently rate-limiting the whole userbase.
if (IS_PROD && TRUST_PROXY_SETTING === 0) {
  console.warn(
    '[aegislink-server] TRUST_PROXY=0 in production — X-Forwarded-For is ' +
      'ignored, so every client shares ONE express-rate-limit bucket keyed ' +
      "off the reverse proxy's own IP. If nginx/Caddy sits in front of this " +
      'relay, set TRUST_PROXY=1 in .env and run: ' +
      'pm2 reload aegislink-relay --update-env'
  );
}

app.use(cors({
  origin: (origin, cb) => {
    // No Origin header: curl, native mobile (React Native), Electron file://
    if (!origin) return cb(null, true);
    // Explicit wildcard configured (dev default)
    if (ORIGIN === '*') return cb(null, true);
    // Explicit allowlist from CORS_ORIGIN env (comma-separated)
    const allowed = ORIGIN.split(',').map(s => s.trim());
    if (allowed.includes(origin)) return cb(null, true);
    // Own production domain always allowed
    if (origin === 'https://aegislink.duckdns.org') return cb(null, true);
    // Localhost variants allowed in non-production
    if (process.env.NODE_ENV !== 'production' &&
        /^https?:\/\/localhost(:\d+)?$/.test(origin)) return cb(null, true);
    cb(new Error('CORS blocked'));
  },
  credentials: false,
}));

// Minimal security headers (no helmet dependency needed for a JSON/relay API).
// The relay serves only JSON + opaque blobs, so we lock down sniffing, framing
// and referrer leakage, and disable caching of any sensitive response.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  // CSP (M-4): the relay serves only JSON + opaque blobs, which never load any
  // subresource — so the strictest possible policy is also the correct one. The
  // two HTML landing pages (/g, /a) override this with their own hash-pinned CSP
  // (see routes/links.ts); setHeader replaces, so their policy wins for those
  // responses while every JSON/blob endpoint stays locked to 'none'.
  res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  // HSTS: enforce HTTPS for 1 year in production (ignored over HTTP by browsers)
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.removeHeader('X-Powered-By');
  next();
});
app.disable('x-powered-by');

app.use(express.json({ limit: '64kb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

app.use('/identity', identityRoutes);
app.use('/push', pushRoutes);
app.use('/web3', web3Routes);
app.use('/prekeys', prekeysRoutes);
app.use('/blob', blobRoutes);
app.use('/backup', backupRoutes);
app.use('/', linksRoutes); // /.well-known/assetlinks.json + /g + /a landings
app.use('/turn', turnRoutes);
app.use('/proxy/gif', proxyGifRoutes);
app.use('/proxy/linkpreview', proxyLinkPreviewRoutes);
app.use('/public-channels', createPublicChannelsRouter());

// ── Direct TLS (optional) ────────────────────────────────────────────────────
// When TLS_CERT_PATH + TLS_KEY_PATH are set, the relay terminates HTTPS/WSS
// ITSELF — no reverse proxy needed. Clients then connect straight to
// wss://<domain>:<PORT> with zero extra hops (reuse the same Let's Encrypt cert
// coturn already uses, e.g. /etc/letsencrypt/live/aegislink.duckdns.org/).
// When unset, the relay listens on plain HTTP — the correct choice when an
// nginx/Caddy proxy upstream is terminating TLS for you.
const TLS_CERT_PATH = process.env.TLS_CERT_PATH;
const TLS_KEY_PATH = process.env.TLS_KEY_PATH;
const tlsDirect = Boolean(TLS_CERT_PATH && TLS_KEY_PATH);

if (isClusterWorker && tlsDirect) {
  // Fail closed rather than silently building a broken worker: the cluster
  // master (src/clusterMaster.ts) owns ONE plain-HTTP listening socket and
  // hands off raw, un-TLS'd connections to workers over IPC — a documented
  // limitation of @socket.io/sticky ("not compatible with an HTTPS server").
  // A worker that built its own https.Server and received a raw TCP socket
  // via `io.httpServer.emit('connection', ...)` would misparse every
  // request (no TLS handshake ever happened on that socket). TLS must be
  // terminated in FRONT of the cluster master (nginx/Caddy) instead —
  // see docs/RELAY-HORIZONTAL-SCALING.md.
  console.error(
    '[aegislink-server] FATAL: TLS_CERT_PATH/TLS_KEY_PATH direct TLS termination ' +
    'is not supported in cluster-worker mode. Terminate TLS in front of the ' +
    'cluster master (nginx/Caddy) instead — see docs/RELAY-HORIZONTAL-SCALING.md.'
  );
  process.exit(1);
}

const serverScheme = tlsDirect ? 'https' : 'http';
const httpServer = tlsDirect
  ? createHttpsServer(
      { cert: readFileSync(TLS_CERT_PATH as string), key: readFileSync(TLS_KEY_PATH as string) },
      app,
    )
  : createServer(app);

const io = new SocketServer(httpServer, {
  // Mirror the same permissive-in-dev / strict-in-prod logic used for HTTP CORS.
  // React Native and Electron send no Origin header, so null/undefined must be
  // allowed explicitly — Socket.IO does this automatically when origin is '*'.
  cors: { origin: ORIGIN === '*' ? '*' : ['https://aegislink.duckdns.org', ...ORIGIN.split(',').map(s => s.trim())], credentials: false },
  // Detect dead clients faster than the defaults (25s/20s ≈ 45s window). When a
  // phone is suspended/backgrounded the OS silently drops the WebSocket; until
  // the server notices, the recipient still counts as "online" so messages are
  // delivered to a dead socket instead of triggering an FCM push wake-up (the
  // "ghost socket" — messages/notifications go missing after backgrounding).
  // pingInterval stays at 15s so a backgrounded/suspended phone is still caught
  // within roughly the same ~35s window as before (see pingTimeout below).
  //
  // pingTimeout was widened 10s -> 20s (fix/call-heartbeat-during-signaling):
  // live 1:1 calls on a DEBUG build were observed reconnecting ~20s into every
  // call. Root cause is heartbeat starvation, not a dead transport: WebRTC call
  // setup drives a burst of JS-thread work on the client (ICE gathering
  // callbacks, RTCPeerConnection event bridging, per-candidate secretbox seal —
  // see mobile/src/crypto/callSession.ts — JSON stringify/parse of SDP/ICE),
  // which is heavier under Hermes-debug/dev-bridge overhead. socket.io-client's
  // engine answers `ping` from its own event loop turn; if that turn is briefly
  // starved, the pong misses the old 10s pingTimeout and the server closes a
  // perfectly healthy socket. 20s gives a busy JS thread real headroom to catch
  // up before we tear down an active session, while pingInterval unchanged
  // means a genuinely backgrounded phone is still detected in ~35s (still much
  // tighter than socket.io's stock 45s default — the ghost-socket fix above is
  // not weakened). This is the same "generous heartbeat, don't punish a live
  // signaling session for jitter" posture Signal/Session-style clients take —
  // detecting a truly dead peer a few seconds later is far cheaper than
  // dropping a healthy call's signaling channel mid-negotiation.
  pingInterval: 15000,
  pingTimeout: 20000,
  // Bind to all interfaces so phones on LAN can reach the dev server.
  //
  // `transports` deliberately left at the Socket.IO default (websocket +
  // long-polling), NOT restricted to `['websocket']`, even though horizontal
  // scaling without sticky routing breaks long-polling (a client's successive
  // polling requests can land on a different worker/VM before the websocket
  // upgrade completes). Reasoning: the mobile client
  // (mobile/src/socket/client.ts) explicitly configures
  // `transports: ['websocket', 'polling']` as a deliberate resilience
  // fallback for restrictive/mobile networks and the Tor onion path
  // (docs/RELAY-ONION-SERVICE.md) — dropping polling server-side would
  // silently remove that fallback for exactly the constrained-network users
  // it exists to protect, without coordinating with mobile-lead. The correct
  // fix is sticky ROUTING, not disabling polling:
  //   - same-machine PM2 cluster (src/clusterMaster.ts, `isClusterWorker`
  //     above): `@socket.io/sticky` routes every request by Engine.IO's
  //     `sid` — solved in-process, no infra change needed.
  //   - real multi-VM scale-out (future): sticky sessions at the load
  //     balancer (nginx `hash $arg_sid` / cookie-based), documented as an
  //     infra requirement in docs/RELAY-HORIZONTAL-SCALING.md.
});

// ── Cross-process broadcast adapter ─────────────────────────────────────────
// Exactly one of these applies (see relay/socketIoRedisAdapter.ts and
// relay/socketIoClusterAdapter.ts for the full reasoning behind each):
//   - REDIS_URL set: Redis adapter. Works for both same-machine AND real
//     multi-VM scale-out, so it wins whenever configured.
//   - No REDIS_URL but running as a cluster worker (src/clusterMaster.ts):
//     the zero-dependency IPC cluster adapter — correct and sufficient for
//     N workers on ONE machine, which is what's actually deployed if PM2 is
//     pointed at ecosystem.config.cjs without Redis provisioned yet.
//   - Neither: Socket.IO's own default in-memory adapter — today's real
//     single-process production deployment, zero behavior change.
if (process.env.REDIS_URL) {
  attachSocketIoRedisAdapter(io);
} else if (isClusterWorker) {
  attachSocketIoClusterAdapter(io);
}

attachRelay(io);

// Routes that require access to the Socket.IO server for real-time events.
app.use('/work', createWorkRouter(io));
// NOTE: the legacy HTTP /devices router was removed (security roadmap Ola 3,
// C-6 + A-7). It was unauthenticated dead code — device linking and revocation
// run exclusively over the authenticated socket events `device:link`,
// `device:link:approve`, and `device:revoke`, which scope every action to the
// challenge-response-verified aegisId. See server/src/relay/handler.ts.

// CORS rejections from the origin callback above would otherwise surface as a
// generic 500 — turn them into a clean 403 with no stack/detail leakage.
app.use((err: Error, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (err.message === 'CORS blocked') {
    res.status(403).json({ error: 'cors_blocked' });
    return;
  }
  next(err);
});

// Bootstrap DB then start server.
initDb().then(() => {
  if (isClusterWorker) {
    // The cluster master (src/clusterMaster.ts) already owns the real
    // listening socket and hands off raw connections over IPC — this worker
    // must NOT also call `.listen()` (that would try to bind PORT a second
    // time in this process and fail, or worse, race the master for it).
    setupWorker(io);
    // nosemgrep: aegislink-no-console-log-production
    console.log(`[aegislink-server] cluster worker pid=${process.pid} ready (routed via src/clusterMaster.ts sticky sessions)`);
  } else {
    httpServer.listen(PORT, '0.0.0.0', () => {
      // nosemgrep: aegislink-no-console-log-production
      console.log(`[aegislink-server] listening on ${serverScheme}://0.0.0.0:${PORT}${tlsDirect ? ' (direct TLS)' : ''}`);
      // nosemgrep: aegislink-no-console-log-production
      console.log(`[aegislink-server] CORS origin: ${ORIGIN}`);
    });
  }

  // Purge expired queued messages and SenderKey distributions every 10 minutes.
  // NOTE: under cluster mode, every worker runs this independently — harmless
  // (the underlying deletes are idempotent), just modestly redundant work.
  setInterval(() => {
    void messageRepo.purgeExpired();
    void senderKeyDistRepo.purgeExpired();
    // Slice 2b.3b/2b.4 (R1): push bindings must not outlive the epoch
    // rotation — drop anything not re-registered within 2 epochs (48 h).
    void pushEndpointRepo.purgeOlderThan(Date.now() - 48 * 60 * 60 * 1000);
    void pushMailboxTokenRepo.purgeOlderThan(Date.now() - 48 * 60 * 60 * 1000);
  }, 10 * 60 * 1000).unref();

  // Prune work messages that exceed channel retention policies.
  void pruneExpiredWorkMessages();
  setInterval(() => {
    void pruneExpiredWorkMessages();
  }, 60 * 60 * 1000).unref();
}).catch((err: unknown) => {
  console.error('[aegislink-server] DB init failed:', err);
  process.exit(1);
});
