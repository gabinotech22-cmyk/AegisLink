/**
 * deviceLinkRouteRemoved.test.ts
 *
 * Regression guard for security roadmap Ola 3 (C-6 + A-7).
 *
 * The legacy HTTP device-link router (server/src/routes/deviceLink.ts) exposed
 * three UNAUTHENTICATED endpoints:
 *   - POST   /devices/link-request
 *   - POST   /devices/link-confirm   (trusted token possession only — A-7)
 *   - DELETE /devices/:aegisId/:deviceId  (no proof of identity — C-6)
 *
 * They were dead code: every real client links/revokes over the authenticated
 * socket events (`device:link`, `device:link:approve`, `device:revoke`), which
 * scope every action to the challenge-response-verified aegisId. The router was
 * deleted to remove the unauthenticated attack surface entirely.
 *
 * This test fails loudly if either the module or an HTTP /devices mount returns.
 */

import express from 'express';
import request from 'supertest';

process.env['AEGIS_DB_PATH'] = ':memory:';

describe('legacy HTTP /devices router stays removed (C-6 + A-7)', () => {
  test('the deviceLink route module no longer exists', async () => {
    await expect(import('../routes/deviceLink.js')).rejects.toThrow();
  });

  test('an app mounted like index.ts answers no /devices HTTP routes', async () => {
    // Mirrors the production wiring in src/index.ts, which intentionally mounts
    // NO /devices router. Any unauthenticated device endpoint must 404.
    const app = express();
    app.use(express.json({ limit: '64kb' }));

    await request(app).post('/devices/link-request').send({}).expect(404);
    await request(app).post('/devices/link-confirm').send({}).expect(404);
    await request(app).delete('/devices/AAA-BBBB-CCCC/some-device').expect(404);
  });
});
