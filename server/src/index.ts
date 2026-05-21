import express from 'express';
import cors from 'cors';
import { createServer } from 'node:http';
import { Server as SocketServer } from 'socket.io';
import identityRoutes from './routes/identity.js';
import pushRoutes from './routes/push.js';
import web3Routes from './routes/web3.js';
import prekeysRoutes from './routes/prekeys.js';
import blobRoutes from './routes/blob.js';
import pollsRoutes from './routes/polls.js';
import turnRoutes from './routes/turn.js';
import workRoutes from './routes/work.js';
import { attachRelay } from './relay/handler.js';
import { initDb, messageRepo } from './db/client.js';

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

app.use(cors({ origin: ORIGIN }));

// Minimal security headers (no helmet dependency needed for a JSON/relay API).
// The relay serves only JSON + opaque blobs, so we lock down sniffing, framing
// and referrer leakage, and disable caching of any sensitive response.
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
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
app.use('/polls', pollsRoutes);
app.use('/turn', turnRoutes);
app.use('/work', workRoutes);

const httpServer = createServer(app);

const io = new SocketServer(httpServer, {
  cors: { origin: ORIGIN },
  // Bind to all interfaces so phones on LAN can reach the dev server.
});

attachRelay(io);

// Bootstrap DB then start server.
initDb().then(() => {
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[aegislink-server] listening on http://0.0.0.0:${PORT}`);
    console.log(`[aegislink-server] CORS origin: ${ORIGIN}`);
  });

  // Purge expired queued messages every 10 minutes.
  setInterval(() => {
    void messageRepo.purgeExpired();
  }, 10 * 60 * 1000).unref();
}).catch((err: unknown) => {
  console.error('[aegislink-server] DB init failed:', err);
  process.exit(1);
});
