/**
 * turn.auth.test.ts — GET /turn/credentials must require a valid Ed25519
 * signature from a registered identity (A-7 of the 2026-06 audit).
 *
 * Before this, anyone could mint working coturn credentials and steal relay
 * bandwidth. Now the request must carry aegisId + ts + a signature over
 * `${aegisId}:turn:${floor(ts/30_000)}` by the identity's registered signing
 * key — the same trust model as POST /prekeys.
 */

process.env['AEGIS_DB_PATH'] = ':memory:';
process.env['TURN_SECRET'] = 'test-turn-secret';

import express from 'express';
import request from 'supertest';
import nacl from 'tweetnacl';
import naclUtil from 'tweetnacl-util';

const { encodeBase64, decodeUTF8 } = naclUtil;

let app: express.Express;
let identityRepo: typeof import('../db/client.js')['identityRepo'];

// A registered identity with a known signing keypair.
const signKeys = nacl.sign.keyPair();
const boxKeys = nacl.box.keyPair();
const AEGIS_ID = 'ABC-DEFG-HJKM'; // matches the Crockford-base32 route regex

function sign(aegisId: string, ts: number, secret: Uint8Array): string {
  const bucket = Math.floor(ts / 30_000);
  return encodeBase64(nacl.sign.detached(decodeUTF8(`${aegisId}:turn:${bucket}`), secret));
}

beforeAll(async () => {
  const db = await import('../db/client.js');
  await db.initDb();
  identityRepo = db.identityRepo;
  await identityRepo.insert({
    aegis_id: AEGIS_ID,
    public_key_b64: encodeBase64(boxKeys.publicKey),
    signing_public_key_b64: encodeBase64(signKeys.publicKey),
    created_at: Date.now(),
  });

  const { default: turnRoutes } = await import('../routes/turn.js');
  app = express();
  app.use('/turn', turnRoutes);
});

describe('GET /turn/credentials — signature auth', () => {
  it('issues credentials for a valid signature from a registered identity', async () => {
    const ts = Date.now();
    const sig = sign(AEGIS_ID, ts, signKeys.secretKey);
    const res = await request(app)
      .get('/turn/credentials')
      .query({ aegisId: AEGIS_ID, sig, ts });
    expect(res.status).toBe(200);
    expect(typeof res.body.username).toBe('string');
    expect(typeof res.body.credential).toBe('string');
    expect(Array.isArray(res.body.urls)).toBe(true);
    // The username binds the expiry + aegisId per coturn use-auth-secret.
    expect(res.body.username).toContain(`:${AEGIS_ID}`);
  });

  it('advertises our OWN coturn as STUN (same host/port as TURN), never a third party', async () => {
    const ts = Date.now();
    const sig = sign(AEGIS_ID, ts, signKeys.secretKey);
    const res = await request(app)
      .get('/turn/credentials')
      .query({ aegisId: AEGIS_ID, sig, ts });
    expect(res.status).toBe(200);
    const urls: string[] = res.body.urls;
    // TURN_HOST/TURN_PORT are unset in the test env → defaults localhost:3478.
    // coturn serves STUN on the TURN port, so the response must include our stun:.
    expect(urls).toContain('stun:localhost:3478');
    // And NEVER a public third-party STUN.
    for (const u of urls) {
      expect(u).not.toContain('google.com');
      expect(u).not.toContain('cloudflare.com');
    }
  });

  it('rejects a request with no signature (400)', async () => {
    const res = await request(app)
      .get('/turn/credentials')
      .query({ aegisId: AEGIS_ID, ts: Date.now() });
    expect(res.status).toBe(400);
  });

  it('rejects a forged signature (403)', async () => {
    const ts = Date.now();
    const wrong = nacl.sign.keyPair(); // not the registered key
    const sig = sign(AEGIS_ID, ts, wrong.secretKey);
    const res = await request(app)
      .get('/turn/credentials')
      .query({ aegisId: AEGIS_ID, sig, ts });
    expect(res.status).toBe(403);
  });

  it('rejects an unregistered identity (403)', async () => {
    const ts = Date.now();
    const sig = sign('ZZZ-ZZZZ-ZZZZ', ts, signKeys.secretKey);
    const res = await request(app)
      .get('/turn/credentials')
      .query({ aegisId: 'ZZZ-ZZZZ-ZZZZ', sig, ts });
    expect(res.status).toBe(403);
  });

  it('rejects a stale timestamp (400)', async () => {
    const ts = Date.now() - 5 * 60_000; // 5 min old, outside the ±60s window
    const sig = sign(AEGIS_ID, ts, signKeys.secretKey);
    const res = await request(app)
      .get('/turn/credentials')
      .query({ aegisId: AEGIS_ID, sig, ts });
    expect(res.status).toBe(400);
  });
});
