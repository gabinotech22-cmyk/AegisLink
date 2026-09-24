/**
 * identityDeleteRevokesDid.test.ts — account deletion deactivates the DID.
 *
 * Web3 audit 2026-09-24: a DID revocation used to be accepted from anyone who
 * signed it with ANY key. Now the only writer is DELETE /identity/:id, which
 * verifies the owner's signature against the STORED signing key and derives the
 * DID (did:key of that key) server-side (golden rules #3/#7). Verifies:
 *   - a signed deletion deactivates exactly that identity's did:key (410)
 *   - an unrelated did:key stays active
 *   - a forged deletion deactivates nothing
 *
 * Own file (not identity.delete.test.ts) so DELETE's 5-per-15-min limiter and
 * the in-memory DB start fresh for these cases.
 */
import express from 'express';
import nacl from 'tweetnacl';
import tweetnaclUtil from 'tweetnacl-util';
import request from 'supertest';

process.env['AEGIS_DB_PATH'] = ':memory:';

const { encodeBase64 } = tweetnaclUtil;

let identityRepo: typeof import('../db/client.js')['identityRepo'];
let web3Repo: typeof import('../db/client.js')['web3Repo'];
let didKey: typeof import('../crypto/didKey.js');
let app: express.Express;

beforeAll(async () => {
  ({ identityRepo, web3Repo } = await import('../db/client.js'));
  didKey = await import('../crypto/didKey.js');
  const { default: identityRoutes } = await import('../routes/identity.js');
  const { default: web3Routes } = await import('../routes/web3.js');
  app = express();
  app.use(express.json());
  app.use('/identity', identityRoutes);
  app.use('/web3', web3Routes);
});

async function seed(aegisId: string): Promise<nacl.SignKeyPair> {
  const keys = nacl.sign.keyPair();
  await identityRepo.insert({
    aegis_id: aegisId,
    public_key_b64: encodeBase64(nacl.box.keyPair().publicKey),
    signing_public_key_b64: encodeBase64(keys.publicKey),
    created_at: Date.now(),
  });
  return keys;
}

function signDelete(aegisId: string, ts: number, secretKey: Uint8Array): string {
  const bucket = Math.floor(ts / 30_000);
  return encodeBase64(
    nacl.sign.detached(new TextEncoder().encode(`${aegisId}:delete:${bucket}`), secretKey),
  );
}

const resolve = (did: string) =>
  request(app).get(`/web3/did/resolve/${encodeURIComponent(did)}`);

describe('DELETE /identity/:id deactivates the identity DID', () => {
  it('deactivates the did:key of the deleted identity, and only that one', async () => {
    const id = 'DKY-2345-6789'; // Crockford base32 (no I/L/O/U)
    const keys = await seed(id);
    const ownDid = didKey.didKeyFromEd25519(keys.publicKey);
    const otherDid = didKey.didKeyFromEd25519(nacl.sign.keyPair().publicKey);
    expect((await resolve(ownDid)).status).toBe(200);

    const ts = Date.now();
    const res = await request(app)
      .delete(`/identity/${id}`)
      .send({ sig: signDelete(id, ts, keys.secretKey), ts });
    expect(res.status).toBe(200);

    const after = await resolve(ownDid);
    expect(after.status).toBe(410);
    expect(after.body.didDocumentMetadata).toEqual({ deactivated: true });
    expect((await resolve(otherDid)).status).toBe(200);
  });

  it('a forged deletion deactivates nothing', async () => {
    const id = 'FGD-2345-6789';
    const keys = await seed(id);
    const ts = Date.now();
    const forged = encodeBase64(nacl.randomBytes(nacl.sign.signatureLength));
    const res = await request(app).delete(`/identity/${id}`).send({ sig: forged, ts });
    expect(res.status).toBe(403);

    const ownDid = didKey.didKeyFromEd25519(keys.publicKey);
    expect(await web3Repo.isRevoked(didKey.didHashHex(ownDid))).toBe(false);
    expect((await resolve(ownDid)).status).toBe(200);
  });

  it('a deletion signed with another key deactivates nothing', async () => {
    const id = 'KEY-2345-6789';
    const keys = await seed(id);
    const intruder = nacl.sign.keyPair();
    const ts = Date.now();
    const res = await request(app)
      .delete(`/identity/${id}`)
      .send({ sig: signDelete(id, ts, intruder.secretKey), ts });
    expect(res.status).toBe(403);
    expect(await web3Repo.isRevoked(didKey.didHashHex(didKey.didKeyFromEd25519(keys.publicKey)))).toBe(false);
    expect(await web3Repo.isRevoked(didKey.didHashHex(didKey.didKeyFromEd25519(intruder.publicKey)))).toBe(false);
  });
});
