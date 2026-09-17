/**
 * GET /relay/info — federation F2 (docs/FEDERATION-DESIGN.md D5).
 * Static capability document: no per-request variation, no user data.
 */
import express from 'express';
import request from 'supertest';
import relayInfoRoutes, { relayInfo, RELAY_PROTOCOL, MAX_BLOB_BYTES } from '../routes/relayInfo.js';

const app = express();
app.use('/relay', relayInfoRoutes);

describe('GET /relay/info', () => {
  test('answers the capability document with defaults', async () => {
    const res = await request(app).get('/relay/info');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toContain('max-age');
    expect(res.body.protocol).toBe(RELAY_PROTOCOL);
    expect(res.body.maxBlobBytes).toBe(MAX_BLOB_BYTES);
    expect(res.body.features).toEqual(expect.arrayContaining(['mailbox', 'prekeys', 'blob', 'calls', 'identity-lookup']));
    expect(typeof res.body.name).toBe('string');
  });

  test('reflects env policy: ntfy on, identity lookup off, min client', () => {
    const info = relayInfo({ PUSH_MAILBOX_ENABLED: 'on', IDENTITY_LOOKUP: 'off', APP_MIN_VERSION: '1.1.0', RELAY_NAME: 'my relay' } as NodeJS.ProcessEnv);
    expect(info.features).toContain('ntfy');
    expect(info.features).not.toContain('identity-lookup');
    expect(info.minClient).toBe('1.1.0');
    expect(info.name).toBe('my relay');
  });

  test('is identical across requests (no fingerprinting surface)', async () => {
    const a = (await request(app).get('/relay/info')).body;
    const b = (await request(app).get('/relay/info')).body;
    expect(a).toEqual(b);
  });
});
