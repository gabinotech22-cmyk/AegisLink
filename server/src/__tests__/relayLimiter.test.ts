/**
 * relayLimiter.test.ts — HTTP rate limits stay per-client over Tor.
 *
 * Every mobile and desktop client reaches the official relay over its onion
 * (docs/SEALED-SENDER-ARCHITECTURE.md §6.2). Onion requests all share the Tor
 * sidecar's address, so a per-IP bucket would lock every Tor user out at
 * once. These tests pin the policy of http/relayLimiter.ts:
 *   - clearnet (nginx, X-Forwarded-For) keeps the per-IP bucket;
 *   - onion + identity policy: per identity, only accepted requests count, so
 *     a forged request naming someone else does not spend their budget;
 *   - onion + shared policy: only the flood backstop (max × multiplier);
 *   - a `.onion` Host that arrives through nginx (has X-Forwarded-For) is
 *     still clearnet — the onion policy cannot be claimed by a header.
 */
import express from 'express';
import request from 'supertest';
import { relayLimiter, isOnionRequest, queryField } from '../http/relayLimiter.js';

const ONION = 'fhxnal5jmuuqsbtzz7avos4drhqmuy4c7ffd35gi3hw2uwbe5iqshfyd.onion';

function appWith(limiter: express.RequestHandler): express.Express {
  const app = express();
  app.set('trust proxy', 1);
  // `ok=1` → the route accepts the request (200); otherwise it rejects (403),
  // standing in for a failed signature check.
  app.get('/r', limiter, (req, res) => {
    if (req.query['ok'] === '1') res.json({ ok: true });
    else res.status(403).json({ error: 'invalid_signature' });
  });
  app.get('/probe', (req, res) => {
    res.json({ onion: isOnionRequest(req) });
  });
  return app;
}

async function hitUntil429(send: () => request.Test, cap: number): Promise<number> {
  for (let i = 1; i <= cap; i++) {
    const res = await send();
    if (res.status === 429) return i;
  }
  return -1;
}

beforeAll(() => {
  process.env['AEGIS_ONION_FLOOD_MULT'] = '3';
});

describe('isOnionRequest', () => {
  it('is true only for a .onion Host without X-Forwarded-For', async () => {
    const app = appWith((_req, _res, next) => next());
    expect((await request(app).get('/probe').set('Host', ONION)).body.onion).toBe(true);
    expect(
      (await request(app).get('/probe').set('Host', ONION).set('X-Forwarded-For', '203.0.113.9')).body.onion,
    ).toBe(false);
    expect((await request(app).get('/probe').set('Host', 'relay.example.org')).body.onion).toBe(false);
    expect((await request(app).get('/probe').set('Host', 'short.onion')).body.onion).toBe(false);
  });
});

describe('clearnet keeps the per-IP bucket', () => {
  it('limits each forwarded IP separately', async () => {
    const app = appWith(
      relayLimiter({ windowMs: 60_000, max: 3, onion: { kind: 'shared' }, body: { error: 'rate_limit_exceeded' } }),
    );
    const a = () => request(app).get('/r?ok=1').set('X-Forwarded-For', '203.0.113.1');
    expect(await hitUntil429(a, 10)).toBe(4);
    const b = await request(app).get('/r?ok=1').set('X-Forwarded-For', '203.0.113.2');
    expect(b.status).toBe(200);
  });

  it('a spoofed .onion Host through nginx is still limited per IP', async () => {
    const app = appWith(
      relayLimiter({
        windowMs: 60_000,
        max: 2,
        onion: { kind: 'identity', key: queryField('id') },
        body: { error: 'rate_limit_exceeded' },
      }),
    );
    const send = (id: string) =>
      request(app).get(`/r?ok=1&id=${id}`).set('Host', ONION).set('X-Forwarded-For', '203.0.113.7');
    await send('A');
    await send('B');
    // Rotating the claimed identity does not help: the bucket is the IP.
    expect((await send('C')).status).toBe(429);
  });
});

describe('onion + identity policy', () => {
  const make = () =>
    appWith(
      relayLimiter({
        windowMs: 60_000,
        max: 3,
        onion: { kind: 'identity', key: queryField('id') },
        body: { error: 'rate_limit_exceeded' },
      }),
    );

  it('one identity exhausting its budget does not block another', async () => {
    const app = make();
    const a = () => request(app).get('/r?ok=1&id=AAA').set('Host', ONION);
    expect(await hitUntil429(a, 10)).toBe(4);
    const b = await request(app).get('/r?ok=1&id=BBB').set('Host', ONION);
    expect(b.status).toBe(200);
  });

  it("forged requests naming someone else's id do not spend their budget", async () => {
    const app = make();
    // 3 rejected (403) requests claiming the victim's id: they do not count.
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/r?id=VICTIM').set('Host', ONION)).status).toBe(403);
    }
    // The victim still has its full budget of 3 accepted requests.
    for (let i = 0; i < 3; i++) {
      expect((await request(app).get('/r?ok=1&id=VICTIM').set('Host', ONION)).status).toBe(200);
    }
    expect((await request(app).get('/r?ok=1&id=VICTIM').set('Host', ONION)).status).toBe(429);
  });

  it('the flood backstop still caps failed-request floods (max × multiplier)', async () => {
    const app = make();
    const junk = (i: number) => request(app).get(`/r?id=X${i}`).set('Host', ONION);
    let limitedAt = -1;
    for (let i = 1; i <= 20; i++) {
      if ((await junk(i)).status === 429) {
        limitedAt = i;
        break;
      }
    }
    expect(limitedAt).toBe(3 * 3 + 1);
  });
});

describe('onion + shared policy', () => {
  it('uses only the flood backstop, not the per-IP max', async () => {
    const app = appWith(
      relayLimiter({ windowMs: 60_000, max: 2, onion: { kind: 'shared' }, body: { error: 'rate_limit_exceeded' } }),
    );
    const send = () => request(app).get('/r?ok=1').set('Host', ONION);
    // Per-IP would stop at 3; the onion backstop is 2 × 3 = 6 → 7th is limited.
    expect(await hitUntil429(send, 20)).toBe(7);
  });

  it('honours an explicit onionFloodMax', async () => {
    const app = appWith(
      relayLimiter({
        windowMs: 60_000,
        max: 1,
        onion: { kind: 'shared' },
        onionFloodMax: 5,
        body: { error: 'rate_limit_exceeded' },
      }),
    );
    const res = await hitUntil429(() => request(app).get('/r?ok=1').set('Host', ONION), 20);
    expect(res).toBe(6);
  });

  it('429 bodies carry no address', async () => {
    const app = appWith(
      relayLimiter({ windowMs: 60_000, max: 1, onion: { kind: 'shared' }, onionFloodMax: 1, body: { error: 'rate_limit_exceeded' } }),
    );
    await request(app).get('/r?ok=1').set('Host', ONION);
    const res = await request(app).get('/r?ok=1').set('Host', ONION);
    expect(res.status).toBe(429);
    expect(JSON.stringify(res.body)).not.toMatch(/\d+\.\d+\.\d+\.\d+/);
  });
});
