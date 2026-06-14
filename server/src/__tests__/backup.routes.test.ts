/**
 * backup.routes.test.ts — Integration tests for /backup endpoints.
 *
 * Covered cases:
 *   1. PUT without valid auth → 401
 *   2. PUT with valid auth → 200, persists
 *   3. GET with valid auth → 200, returns the envelope uploaded in #2
 *   4. GET of aegisId without backup → 404
 *   5. PUT with payload exceeding 5 MB → 413
 *   6. DELETE (authenticated) removes the backup → 200, then GET → 404
 *   7. DELETE without valid auth → 401
 *
 * Auth helper: `authenticate(aegisId)` calls GET /backup/challenge then solves
 * the nacl.box locally using the registered identity's secretKey, returning
 * { token, plain } ready to attach to PUT/GET/DELETE requests.
 */

import express from 'express';
import request from 'supertest';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';

// Use in-memory SQLite for all tests.
process.env['AEGIS_DB_PATH'] = ':memory:';

const { encodeBase64, decodeBase64 } = tweetnaclUtil;

// Deps + app are built in beforeAll rather than via top-level await: ts-jest's
// ESM emit is not reliable across the suite, and a top-level await downleveled
// to CommonJS is a hard SyntaxError. Deferring keeps the file valid either way.
let identityRepo: typeof import('../db/client.js')['identityRepo'];
let app: express.Express;

// ── Registered test identity ──────────────────────────────────────────────────

const AEGIS_ID = 'TST-BACK-PTTT';
const clientKeys = nacl.box.keyPair();
const signingKeys = nacl.sign.keyPair();

beforeAll(async () => {
  ({ identityRepo } = await import('../db/client.js'));
  const { default: backupRoutes } = await import('../routes/backup.js');
  app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/backup', backupRoutes);

  await identityRepo.insert({
    aegis_id: AEGIS_ID,
    public_key_b64: encodeBase64(clientKeys.publicKey),
    signing_public_key_b64: encodeBase64(signingKeys.publicKey),
    created_at: Date.now(),
  });
});

// ── Test fixtures ─────────────────────────────────────────────────────────────

const VALID_ENVELOPE = {
  v: 1,
  salt: encodeBase64(nacl.randomBytes(32)),
  nonce: encodeBase64(nacl.randomBytes(24)),
  ciphertext: encodeBase64(nacl.randomBytes(64)),
};

// ── Auth helper ───────────────────────────────────────────────────────────────

/**
 * Simulates the client auth flow:
 *  1. Fetches a challenge from GET /backup/challenge?aegisId=...
 *  2. Opens the nacl.box using the registered secretKey.
 *  3. Returns { token, plain } ready to attach to subsequent requests.
 */
async function authenticate(aegisId: string): Promise<{ token: string; plain: string }> {
  const challengeRes = await request(app).get(`/backup/challenge`).query({ aegisId });
  expect(challengeRes.status).toBe(200);

  const { token, ephemeralPubKey, nonce, ciphertext } = challengeRes.body as {
    token: string;
    ephemeralPubKey: string;
    nonce: string;
    ciphertext: string;
  };

  const opened = nacl.box.open(
    decodeBase64(ciphertext),
    decodeBase64(nonce),
    decodeBase64(ephemeralPubKey),
    clientKeys.secretKey,
  );
  if (!opened) throw new Error('test: could not open challenge box');
  const plain = encodeBase64(opened);
  return { token, plain };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('GET /backup/challenge', () => {
  it('returns a challenge for a registered identity', async () => {
    const res = await request(app).get('/backup/challenge').query({ aegisId: AEGIS_ID });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('token');
    expect(res.body).toHaveProperty('ephemeralPubKey');
    expect(res.body).toHaveProperty('nonce');
    expect(res.body).toHaveProperty('ciphertext');
  });

  it('returns 401 for an unknown identity', async () => {
    const res = await request(app).get('/backup/challenge').query({ aegisId: 'ZZZ-9999-9999' });
    expect(res.status).toBe(401);
  });

  it('returns 400 for a malformed aegisId', async () => {
    const res = await request(app).get('/backup/challenge').query({ aegisId: 'not-valid' });
    expect(res.status).toBe(400);
  });
});

describe('PUT /backup — without valid auth', () => {
  it('returns 401 when token is missing', async () => {
    const res = await request(app)
      .put('/backup')
      .send({ aegisId: AEGIS_ID, token: '00000000-0000-4000-8000-000000000000', plain: 'garbage', envelope: VALID_ENVELOPE });
    expect(res.status).toBe(401);
  });

  it('returns 401 when plain is wrong (wrong key holder)', async () => {
    const { token } = await authenticate(AEGIS_ID);
    // Use a forged plain that won't match.
    const res = await request(app)
      .put('/backup')
      .send({ aegisId: AEGIS_ID, token, plain: encodeBase64(nacl.randomBytes(32)), envelope: VALID_ENVELOPE });
    expect(res.status).toBe(401);
  });

  it('returns 400 when envelope is missing required fields', async () => {
    const { token, plain } = await authenticate(AEGIS_ID);
    const res = await request(app)
      .put('/backup')
      .send({ aegisId: AEGIS_ID, token, plain, envelope: { v: 1 } });
    expect(res.status).toBe(400);
  });
});

describe('PUT /backup — with valid auth', () => {
  it('returns 200 and persists the backup', async () => {
    const { token, plain } = await authenticate(AEGIS_ID);
    const res = await request(app)
      .put('/backup')
      .send({ aegisId: AEGIS_ID, token, plain, envelope: VALID_ENVELOPE });
    expect(res.status).toBe(200);
    expect((res.body as { ok: boolean }).ok).toBe(true);
  });

  it('returns 413 when envelope ciphertext exceeds 5 MB', async () => {
    const { token, plain } = await authenticate(AEGIS_ID);
    // Build an envelope whose JSON serialization exceeds 5 MB.
    const bigCiphertext = 'A'.repeat(5 * 1024 * 1024 + 1024);
    const res = await request(app)
      .put('/backup')
      .send({
        aegisId: AEGIS_ID,
        token,
        plain,
        envelope: { v: 1, salt: 'abc', nonce: 'abc', ciphertext: bigCiphertext },
      });
    expect(res.status).toBe(413);
  });
});

describe('GET /backup/:aegisId — with valid auth', () => {
  // Ensure there is a backup present (PUT first).
  beforeAll(async () => {
    const { token, plain } = await authenticate(AEGIS_ID);
    await request(app)
      .put('/backup')
      .send({ aegisId: AEGIS_ID, token, plain, envelope: VALID_ENVELOPE });
  });

  it('returns 200 and the stored envelope', async () => {
    const { token, plain } = await authenticate(AEGIS_ID);
    const res = await request(app)
      .get(`/backup/${AEGIS_ID}`)
      .query({ token, plain });
    expect(res.status).toBe(200);
    const body = res.body as { envelope: typeof VALID_ENVELOPE };
    expect(body.envelope).toBeDefined();
    expect(body.envelope.v).toBe(VALID_ENVELOPE.v);
    expect(body.envelope.salt).toBe(VALID_ENVELOPE.salt);
    expect(body.envelope.ciphertext).toBe(VALID_ENVELOPE.ciphertext);
  });

  it('returns 401 when plain is wrong', async () => {
    const { token } = await authenticate(AEGIS_ID);
    const res = await request(app)
      .get(`/backup/${AEGIS_ID}`)
      .query({ token, plain: encodeBase64(nacl.randomBytes(32)) });
    expect(res.status).toBe(401);
  });
});

describe('GET /backup/:aegisId — 404 for unknown identity backup', () => {
  const OTHER_ID = 'TST-NKBA-CKPP';
  const otherKeys = nacl.box.keyPair();

  beforeAll(async () => {
    await identityRepo.insert({
      aegis_id: OTHER_ID,
      public_key_b64: encodeBase64(otherKeys.publicKey),
      signing_public_key_b64: encodeBase64(nacl.sign.keyPair().publicKey),
      created_at: Date.now(),
    });
  });

  it('returns 404 when no backup exists for this identity', async () => {
    // Authenticate using OTHER_ID's key.
    const challengeRes = await request(app).get('/backup/challenge').query({ aegisId: OTHER_ID });
    expect(challengeRes.status).toBe(200);
    const { token, ephemeralPubKey, nonce, ciphertext } = challengeRes.body as {
      token: string; ephemeralPubKey: string; nonce: string; ciphertext: string;
    };
    const opened = nacl.box.open(
      decodeBase64(ciphertext),
      decodeBase64(nonce),
      decodeBase64(ephemeralPubKey),
      otherKeys.secretKey,
    );
    if (!opened) throw new Error('test: could not open challenge for OTHER_ID');
    const plain = encodeBase64(opened);

    const res = await request(app)
      .get(`/backup/${OTHER_ID}`)
      .query({ token, plain });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /backup/:aegisId — authenticated', () => {
  // Pre-condition: ensure backup exists.
  beforeAll(async () => {
    const { token, plain } = await authenticate(AEGIS_ID);
    await request(app)
      .put('/backup')
      .send({ aegisId: AEGIS_ID, token, plain, envelope: VALID_ENVELOPE });
  });

  it('returns 200 and removes the backup', async () => {
    const { token, plain } = await authenticate(AEGIS_ID);
    const delRes = await request(app)
      .delete(`/backup/${AEGIS_ID}`)
      .send({ aegisId: AEGIS_ID, token, plain });
    expect(delRes.status).toBe(200);
    expect((delRes.body as { ok: boolean }).ok).toBe(true);

    // Subsequent GET should now return 404.
    const { token: t2, plain: p2 } = await authenticate(AEGIS_ID);
    const getRes = await request(app)
      .get(`/backup/${AEGIS_ID}`)
      .query({ token: t2, plain: p2 });
    expect(getRes.status).toBe(404);
  });

  it('returns 401 on DELETE without valid auth', async () => {
    const delRes = await request(app)
      .delete(`/backup/${AEGIS_ID}`)
      .send({ aegisId: AEGIS_ID, token: '00000000-0000-4000-8000-000000000000', plain: 'garbage' });
    expect(delRes.status).toBe(401);
  });
});
