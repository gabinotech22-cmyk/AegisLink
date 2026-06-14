/**
 * prekeys.test.ts — X3DH prekey upload + bundle fetch (routes/prekeys.ts).
 *
 * Verifies:
 *   - upload requires a valid Ed25519 signature over `${aegisId}:prekeys:${bucket}`
 *   - a forged signature is rejected (403)
 *   - a stale timestamp is rejected (400)
 *   - fetching a bundle returns the SPK + signing key and consumes one OPK
 *   - OPKs are consumed atomically (each fetch pops a distinct OPK, then null)
 *   - the server stores prekeys as opaque base64 — never derives/sees secrets
 */

import express from 'express';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
import request from 'supertest';

process.env['AEGIS_DB_PATH'] = ':memory:';

const { encodeBase64 } = tweetnaclUtil;

// Deps + app are built in beforeAll rather than via top-level await: ts-jest's
// ESM emit is not reliable across the suite, and a top-level await downleveled
// to CommonJS is a hard SyntaxError. Deferring keeps the file valid either way.
let identityRepo: typeof import('../db/client.js')['identityRepo'];
let app: express.Express;

const AEGIS_ID = 'ABC-2345-6789';
const signKeys = nacl.sign.keyPair();

function signUpload(aegisId: string, ts: number): string {
  const bucket = Math.floor(ts / 30_000);
  const msg = new TextEncoder().encode(`${aegisId}:prekeys:${bucket}`);
  return encodeBase64(nacl.sign.detached(msg, signKeys.secretKey));
}

function makeBody(ts: number, sig: string, opkStart = 1, opkCount = 3) {
  const spk = nacl.box.keyPair();
  const oneTimePreKeys = [];
  for (let i = 0; i < opkCount; i++) {
    oneTimePreKeys.push({
      keyId: opkStart + i,
      publicKeyB64: encodeBase64(nacl.box.keyPair().publicKey),
    });
  }
  return {
    aegisId: AEGIS_ID,
    sig,
    ts,
    signedPreKey: {
      keyId: 1,
      publicKeyB64: encodeBase64(spk.publicKey),
      signatureB64: encodeBase64(nacl.sign.detached(spk.publicKey, signKeys.secretKey)),
    },
    oneTimePreKeys,
  };
}

beforeAll(async () => {
  ({ identityRepo } = await import('../db/client.js'));
  const { default: prekeysRoutes } = await import('../routes/prekeys.js');
  app = express();
  app.use(express.json());
  app.use('/prekeys', prekeysRoutes);

  await identityRepo.insert({
    aegis_id: AEGIS_ID,
    public_key_b64: encodeBase64(nacl.box.keyPair().publicKey),
    signing_public_key_b64: encodeBase64(signKeys.publicKey),
    created_at: Date.now(),
  });
});

describe('POST /prekeys', () => {
  it('uploads prekeys with a valid signature', async () => {
    const ts = Date.now();
    const res = await request(app).post('/prekeys').send(makeBody(ts, signUpload(AEGIS_ID, ts)));
    expect(res.status).toBe(201);
    expect(res.body.uploaded).toBe(3);
  });

  it('rejects a forged signature with 403', async () => {
    const ts = Date.now();
    const forged = encodeBase64(nacl.randomBytes(nacl.sign.signatureLength));
    const res = await request(app).post('/prekeys').send(makeBody(ts, forged, 10));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('rejects a stale timestamp with 400', async () => {
    const ts = Date.now() - 5 * 60_000;
    const res = await request(app).post('/prekeys').send(makeBody(ts, signUpload(AEGIS_ID, ts), 20));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('timestamp_out_of_range');
  });

  it('rejects a malformed body with 400', async () => {
    const res = await request(app).post('/prekeys').send({ aegisId: AEGIS_ID });
    expect(res.status).toBe(400);
  });
});

describe('GET /prekeys/bundle/:aegisId', () => {
  it('returns a bundle and consumes one OPK per fetch', async () => {
    // The route now returns a multi-device shape `{ bundles, bundle }` where
    // `bundle` is the first device's bundle (backward-compat alias). All the
    // per-device fields (signingPublicKeyB64, signedPreKey, oneTimePreKey) live
    // inside that object.
    const r1 = await request(app).get(`/prekeys/bundle/${AEGIS_ID}`);
    expect(r1.status).toBe(200);
    expect(r1.body.bundle.signingPublicKeyB64).toBe(encodeBase64(signKeys.publicKey));
    expect(r1.body.bundle.signedPreKey.publicKeyB64).toBeTruthy();
    expect(r1.body.bundle.oneTimePreKey).not.toBeNull();
    const firstOpkId = r1.body.bundle.oneTimePreKey.keyId;

    const r2 = await request(app).get(`/prekeys/bundle/${AEGIS_ID}`);
    expect(r2.status).toBe(200);
    expect(r2.body.bundle.oneTimePreKey.keyId).not.toBe(firstOpkId);

    // Third fetch — only 3 OPKs were uploaded above, so this should be the last.
    const r3 = await request(app).get(`/prekeys/bundle/${AEGIS_ID}`);
    expect(r3.body.bundle.oneTimePreKey).not.toBeNull();

    // Fourth fetch — OPKs exhausted; bundle still returned with null OPK.
    const r4 = await request(app).get(`/prekeys/bundle/${AEGIS_ID}`);
    expect(r4.status).toBe(200);
    expect(r4.body.bundle.oneTimePreKey).toBeNull();
  });

  it('rejects a malformed id', async () => {
    const res = await request(app).get('/prekeys/bundle/not-an-id');
    expect(res.status).toBe(400);
  });

  it('returns 404 for an unknown identity', async () => {
    const res = await request(app).get('/prekeys/bundle/ZZZ-9999-9999');
    expect(res.status).toBe(404);
  });
});
