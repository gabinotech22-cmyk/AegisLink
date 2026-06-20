/**
 * identity.delete.test.ts — B-2 account deletion (DELETE /identity/:id).
 *
 * Verifies:
 *   - a valid Ed25519 signature over `${aegisId}:delete:${bucket}` deletes the
 *     identity AND cascades to its server-side material (prekeys bundle gone)
 *   - a forged signature is rejected (403) and leaves the account intact
 *   - a stale timestamp is rejected (400)
 *   - an unknown identity returns 404
 *   - the server requires proof-of-key-possession, not just knowing the ID (#3)
 */
import express from 'express';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
import request from 'supertest';

process.env['AEGIS_DB_PATH'] = ':memory:';

const { encodeBase64 } = tweetnaclUtil;

let identityRepo: typeof import('../db/client.js')['identityRepo'];
let prekeysRepo: typeof import('../db/client.js')['prekeysRepo'];
let app: express.Express;

const AEGIS_ID = 'DEK-2345-6789'; // Crockford base32 (no I/L/O/U)
const signKeys = nacl.sign.keyPair();

function signDelete(id: string, ts: number): string {
  const bucket = Math.floor(ts / 30_000);
  return encodeBase64(
    nacl.sign.detached(new TextEncoder().encode(`${id}:delete:${bucket}`), signKeys.secretKey),
  );
}

async function seedIdentity(): Promise<void> {
  await identityRepo.deleteAccount(AEGIS_ID); // idempotent — clean slate
  await identityRepo.insert({
    aegis_id: AEGIS_ID,
    public_key_b64: encodeBase64(nacl.box.keyPair().publicKey),
    signing_public_key_b64: encodeBase64(signKeys.publicKey),
    created_at: Date.now(),
  });
  // Seed a prekey so the cascade has something to remove (proves it cascades).
  await prekeysRepo.upsertSigned({
    aegis_id: AEGIS_ID,
    device_id: 'default',
    key_id: 1,
    public_key_b64: encodeBase64(nacl.box.keyPair().publicKey),
    signature_b64: encodeBase64(nacl.randomBytes(64)),
    created_at: Date.now(),
  });
}

beforeAll(async () => {
  ({ identityRepo, prekeysRepo } = await import('../db/client.js'));
  const { default: identityRoutes } = await import('../routes/identity.js');
  const { default: prekeysRoutes } = await import('../routes/prekeys.js');
  app = express();
  app.use(express.json());
  app.use('/identity', identityRoutes);
  app.use('/prekeys', prekeysRoutes);
});

beforeEach(seedIdentity);

describe('DELETE /identity/:id — account deletion', () => {
  it('deletes the identity and cascades to its prekey bundle', async () => {
    // Sanity: the identity and a prekey bundle exist beforehand.
    expect((await request(app).get(`/identity/${AEGIS_ID}`)).status).toBe(200);
    expect((await request(app).get(`/prekeys/bundle/${AEGIS_ID}`)).status).toBe(200);

    const ts = Date.now();
    const res = await request(app)
      .delete(`/identity/${AEGIS_ID}`)
      .send({ sig: signDelete(AEGIS_ID, ts), ts });
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    // Identity gone, and the cascade removed its prekeys (bundle 404).
    expect((await request(app).get(`/identity/${AEGIS_ID}`)).status).toBe(404);
    expect((await request(app).get(`/prekeys/bundle/${AEGIS_ID}`)).status).toBe(404);
  });

  it('rejects a forged signature with 403 and leaves the account intact', async () => {
    const ts = Date.now();
    const forged = encodeBase64(nacl.randomBytes(nacl.sign.signatureLength));
    const res = await request(app).delete(`/identity/${AEGIS_ID}`).send({ sig: forged, ts });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_signature');
    // Still there.
    expect((await request(app).get(`/identity/${AEGIS_ID}`)).status).toBe(200);
  });

  it('rejects a stale timestamp with 400', async () => {
    const ts = Date.now() - 5 * 60_000;
    const res = await request(app)
      .delete(`/identity/${AEGIS_ID}`)
      .send({ sig: signDelete(AEGIS_ID, ts), ts });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('timestamp_out_of_range');
  });

  it('returns 404 for an unknown identity', async () => {
    const unknown = 'ZZZ-9999-9999';
    const ts = Date.now();
    const res = await request(app)
      .delete(`/identity/${unknown}`)
      .send({ sig: signDelete(unknown, ts), ts });
    expect(res.status).toBe(404);
  });
});
