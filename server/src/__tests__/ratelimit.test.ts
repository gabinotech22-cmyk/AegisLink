/**
 * ratelimit.test.ts — verifies express-rate-limit rejects past the threshold.
 *
 * Covers:
 *   - GET /identity/challenge (PoW challenge flood guard: 20 / 60s)
 *
 * (The old POST /polls/vote case was removed with the HTTP poll endpoint in the
 * 2026-06 audit, A-8 — votes are now E2EE-only and tallied client-side.)
 *
 * Once the limit is exceeded the server must respond 429 with a JSON body and
 * must NOT leak any IP in the response.
 */

import express from 'express';
import request from 'supertest';

process.env['AEGIS_DB_PATH'] = ':memory:';

// Built in beforeAll rather than via top-level await: ts-jest's ESM emit is not
// reliable across the suite, and a top-level await downleveled to CommonJS is a
// hard SyntaxError. Deferring keeps the file valid under both module modes.
let app: express.Express;

beforeAll(async () => {
  const { default: identityRoutes } = await import('../routes/identity.js');
  app = express();
  app.use(express.json());
  app.use('/identity', identityRoutes);
});

describe('rate limiting', () => {
  it('throttles GET /identity/challenge after 20 requests/min', async () => {
    let limited = false;
    let lastBody: Record<string, unknown> = {};
    for (let i = 0; i < 25; i++) {
      const res = await request(app).get('/identity/challenge');
      if (res.status === 429) {
        limited = true;
        lastBody = res.body;
        break;
      }
    }
    expect(limited).toBe(true);
    expect(lastBody.error).toBe('rate_limit_exceeded');
    // Zero-metadata: the 429 body must not echo an IP address.
    expect(JSON.stringify(lastBody)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
