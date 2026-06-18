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

/**
 * Build a body that ALSO carries a PQXDH (v2) signed PQ prekey. We don't need
 * real ML-KEM-768 key material here — the server only checks length-agnostic
 * Ed25519 signature validity over whatever bytes are given, so random bytes of
 * plausible size exercise the same code path without pulling in @noble/post-quantum.
 */
function makePqBody(
  ts: number,
  sig: string,
  opts: { tamperPq?: boolean; opkStart?: number } = {},
) {
  // opkCount: 0 — these tests only exercise the pqSignedPreKey signature-check
  // path and must NOT add OPKs to AEGIS_ID's pool (the OPK-exhaustion test
  // below depends on AEGIS_ID having exactly the 3 OPKs uploaded earlier).
  const base = makeBody(ts, sig, opts.opkStart ?? 100, 0);
  const pqPub = nacl.randomBytes(1184); // ML-KEM-768 pubkey size, content irrelevant for sig check
  const pqSig = opts.tamperPq
    ? nacl.randomBytes(nacl.sign.signatureLength) // forged — must be rejected
    : nacl.sign.detached(pqPub, signKeys.secretKey);
  return {
    ...base,
    pqSignedPreKey: {
      keyId: 1,
      publicKeyB64: encodeBase64(pqPub),
      signatureB64: encodeBase64(pqSig),
    },
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

  it('accepts an upload that includes a valid pqSignedPreKey (v2)', async () => {
    const ts = Date.now();
    const res = await request(app)
      .post('/prekeys')
      .send(makePqBody(ts, signUpload(AEGIS_ID, ts)));
    expect(res.status).toBe(201);
    expect(res.body.uploaded).toBe(0);
  });

  it('rejects an upload whose pqSignedPreKey signature is forged', async () => {
    const ts = Date.now();
    const res = await request(app)
      .post('/prekeys')
      .send(makePqBody(ts, signUpload(AEGIS_ID, ts), { tamperPq: true, opkStart: 200 }));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_pq_spk_signature');
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

  it('round-trips pqSignedPreKey in the served bundle after a v2 upload', async () => {
    const pqAegisId = 'PQX-2345-6789';
    const pqSignKeys = nacl.sign.keyPair();
    await identityRepo.insert({
      aegis_id: pqAegisId,
      public_key_b64: encodeBase64(nacl.box.keyPair().publicKey),
      signing_public_key_b64: encodeBase64(pqSignKeys.publicKey),
      created_at: Date.now(),
    });

    const ts = Date.now();
    const bucket = Math.floor(ts / 30_000);
    const msg = new TextEncoder().encode(`${pqAegisId}:prekeys:${bucket}`);
    const sig = encodeBase64(nacl.sign.detached(msg, pqSignKeys.secretKey));

    const spk = nacl.box.keyPair();
    const pqPub = nacl.randomBytes(1184);
    const pqSig = nacl.sign.detached(pqPub, pqSignKeys.secretKey);

    const uploadRes = await request(app).post('/prekeys').send({
      aegisId: pqAegisId,
      sig,
      ts,
      signedPreKey: {
        keyId: 1,
        publicKeyB64: encodeBase64(spk.publicKey),
        signatureB64: encodeBase64(nacl.sign.detached(spk.publicKey, pqSignKeys.secretKey)),
      },
      oneTimePreKeys: [],
      pqSignedPreKey: {
        keyId: 1,
        publicKeyB64: encodeBase64(pqPub),
        signatureB64: encodeBase64(pqSig),
      },
    });
    expect(uploadRes.status).toBe(201);

    const bundleRes = await request(app).get(`/prekeys/bundle/${pqAegisId}`);
    expect(bundleRes.status).toBe(200);
    expect(bundleRes.body.bundle.pqSignedPreKey).not.toBeNull();
    expect(bundleRes.body.bundle.pqSignedPreKey.publicKeyB64).toBe(encodeBase64(pqPub));
    expect(bundleRes.body.bundle.pqSignedPreKey.signatureB64).toBe(encodeBase64(pqSig));
  });

  it('serves pqSignedPreKey: null for a v1-only identity (interop)', async () => {
    // A fresh identity that uploads prekeys WITHOUT a pqSignedPreKey (legacy v1
    // client) must still resolve with pqSignedPreKey explicitly null, not
    // omitted — proving v1-only clients keep working against the v2-capable relay.
    const v1AegisId = 'V1X-2345-6789';
    const v1SignKeys = nacl.sign.keyPair();
    await identityRepo.insert({
      aegis_id: v1AegisId,
      public_key_b64: encodeBase64(nacl.box.keyPair().publicKey),
      signing_public_key_b64: encodeBase64(v1SignKeys.publicKey),
      created_at: Date.now(),
    });

    const ts = Date.now();
    const bucket = Math.floor(ts / 30_000);
    const msg = new TextEncoder().encode(`${v1AegisId}:prekeys:${bucket}`);
    const sig = encodeBase64(nacl.sign.detached(msg, v1SignKeys.secretKey));
    const spk = nacl.box.keyPair();

    const uploadRes = await request(app).post('/prekeys').send({
      aegisId: v1AegisId,
      sig,
      ts,
      signedPreKey: {
        keyId: 1,
        publicKeyB64: encodeBase64(spk.publicKey),
        signatureB64: encodeBase64(nacl.sign.detached(spk.publicKey, v1SignKeys.secretKey)),
      },
      oneTimePreKeys: [],
      // no pqSignedPreKey — legacy v1 upload
    });
    expect(uploadRes.status).toBe(201);

    const res = await request(app).get(`/prekeys/bundle/${v1AegisId}`);
    expect(res.status).toBe(200);
    expect(res.body.bundle).toHaveProperty('pqSignedPreKey');
    expect(res.body.bundle.pqSignedPreKey).toBeNull();
  });
});
