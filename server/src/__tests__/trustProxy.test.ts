/**
 * trustProxy.test.ts — regression for the TRUST_PROXY collapse bug.
 *
 * When `trust proxy` resolves to 0 behind nginx, express-rate-limit's default
 * keyGenerator falls back to the raw socket IP (always the nginx upstream's
 * loopback address), so every client in the world shares ONE rate-limit
 * bucket. With `trust proxy = 1` (the correct production value — see
 * server/src/index.ts), express parses X-Forwarded-For and buckets per real
 * client IP again.
 *
 * This test proves the fixed behavior: two distinct X-Forwarded-For values
 * hitting the same limiter land in independent buckets, so one client
 * exhausting its quota never 429s the other.
 */

import express from 'express';
import request from 'supertest';

process.env['AEGIS_DB_PATH'] = ':memory:';

let app: express.Express;

beforeAll(async () => {
  const { default: identityRoutes } = await import('../routes/identity.js');
  app = express();
  // Mirrors the production default set in server/src/index.ts
  // (app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1))).
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use('/identity', identityRoutes);
});

describe('trust proxy — per-IP rate limit isolation', () => {
  it('does not let one client exhaust another client\'s quota', async () => {
    const CLIENT_A = '203.0.113.10';
    const CLIENT_B = '203.0.113.20';

    // Exhaust CLIENT_A's 20/min GET /identity/challenge quota.
    let aLimited = false;
    for (let i = 0; i < 25; i++) {
      const res = await request(app)
        .get('/identity/challenge')
        .set('X-Forwarded-For', CLIENT_A);
      if (res.status === 429) {
        aLimited = true;
        break;
      }
    }
    expect(aLimited).toBe(true);

    // CLIENT_B must be unaffected — separate bucket keyed off its own
    // X-Forwarded-For value, proving the two clients are not sharing a
    // single global bucket (the TRUST_PROXY=0 collapse bug).
    const resB = await request(app)
      .get('/identity/challenge')
      .set('X-Forwarded-For', CLIENT_B);
    expect(resB.status).toBe(200);

    // Zero-metadata: nothing in either response echoes an IP address.
    expect(JSON.stringify(resB.body)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
