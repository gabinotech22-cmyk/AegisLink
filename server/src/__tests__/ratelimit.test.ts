/**
 * ratelimit.test.ts — verifies express-rate-limit rejects past the threshold.
 *
 * Covers two sensitive endpoints:
 *   - GET /identity/challenge (PoW challenge flood guard: 20 / 60s)
 *   - POST /polls/vote (ballot-stuffing guard added in this audit: 30 / 60s)
 *
 * Once the limit is exceeded the server must respond 429 with a JSON body and
 * must NOT leak any IP in the response.
 */

import express from 'express';
import request from 'supertest';

process.env['AEGIS_DB_PATH'] = ':memory:';

const { default: identityRoutes } = await import('../routes/identity.js');
const { default: pollsRoutes } = await import('../routes/polls.js');

const app = express();
app.use(express.json());
app.use('/identity', identityRoutes);
app.use('/polls', pollsRoutes);

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

  it('throttles POST /polls/vote after 30 votes/min', async () => {
    let limited = false;
    for (let i = 0; i < 40; i++) {
      const res = await request(app)
        .post('/polls/vote')
        .send({ pollId: 'p1', voterHash: `voter-${i}`, optionIndex: 0 });
      if (res.status === 429) {
        limited = true;
        break;
      }
    }
    expect(limited).toBe(true);
  });
});
