import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFileSync } from 'node:fs';
import { Server as SocketServer } from 'socket.io';
import identityRoutes from './routes/identity.js';
import pushRoutes from './routes/push.js';
import web3Routes from './routes/web3.js';
import prekeysRoutes from './routes/prekeys.js';
import blobRoutes from './routes/blob.js';
import backupRoutes from './routes/backup.js';
import linksRoutes from './routes/links.js';
import pollsRoutes from './routes/polls.js';
import turnRoutes from './routes/turn.js';
import proxyGifRoutes from './routes/proxyGif.js';
import proxyLinkPreviewRoutes from './routes/proxyLinkPreview.js';
import { createWorkRouter } from './routes/work.js';
import { createDeviceLinkRouter } from './routes/deviceLink.js';
import { attachRelay } from './relay/handler.js';
import { initDb, messageRepo, pruneExpiredWorkMessages } from './db/client.js';

const PORT = Number(process.env.PORT ?? 3001);
// Default '*' so React Native / Expo Go (which doesn't send a stable Origin)
// can connect from physical phones on LAN. Lock down to specific hosts in prod
// by setting CORS_ORIGIN=https://yourdomain.com,...
const ORIGIN = process.env.CORS_ORIGIN ?? '*';

const app = express();

// Trust the first proxy hop so express-rate-limit reads the real client IP
// from X-Forwarded-For when deployed behind nginx/caddy/etc.
// Set to 1 (one trusted proxy) — adjust to 0 if running without a reverse proxy.
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1));

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
app.use('/polls', pollsRoutes);
app.use('/turn', turnRoutes);
app.use('/proxy/gif', proxyGifRoutes);
app.use('/proxy/linkpreview', proxyLinkPreviewRoutes);

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
  // Bind to all interfaces so phones on LAN can reach the dev server.
});

attachRelay(io);

// Routes that require access to the Socket.IO server for real-time events.
app.use('/work', createWorkRouter(io));
app.use('/devices', createDeviceLinkRouter(io));

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
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[aegislink-server] listening on ${serverScheme}://0.0.0.0:${PORT}${tlsDirect ? ' (direct TLS)' : ''}`);
    console.log(`[aegislink-server] CORS origin: ${ORIGIN}`);
  });

  // Purge expired queued messages every 10 minutes.
  setInterval(() => {
    void messageRepo.purgeExpired();
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
