/**
 * web3Did.test.ts — GET /web3/did/resolve/:did and the DID revocation store.
 *
 * Regression for the web3 audit 2026-09-24: POST /web3/device/revoke checked
 * an Ed25519 signature against a key THE CLIENT supplied and never tied that key
 * to the DID, so anyone could permanently deactivate any DID with a throwaway
 * key pair. The endpoint is gone; a DID is deactivated only by its owner's
 * signed account deletion (identity.delete.test.ts). This suite covers:
 *   - the forgeable write path (and its read twin) no longer exist
 *   - W3C DID Resolution for did:key: 200 / 400 invalidDid / 410 deactivated /
 *     501 methodNotSupported
 *   - the legacy table (which kept the signing key = the DID) is purged and
 *     rebuilt hash-only
 */

import express from 'express';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import request from 'supertest';
import { DatabaseSync } from 'node:sqlite';

process.env['AEGIS_DB_PATH'] = ':memory:';

let app: express.Express;
let web3Repo: typeof import('../db/client.js')['web3Repo'];
let didKey: typeof import('../crypto/didKey.js');

beforeAll(async () => {
  ({ web3Repo } = await import('../db/client.js'));
  didKey = await import('../crypto/didKey.js');
  const { default: web3Routes } = await import('../routes/web3.js');
  app = express();
  app.use(express.json());
  app.use('/web3', web3Routes);
});

const freshDid = () => didKey.didKeyFromEd25519(nacl.sign.keyPair().publicKey);
const resolve = (did: string) =>
  request(app).get(`/web3/did/resolve/${encodeURIComponent(did)}`);

describe('forgeable revocation endpoints are gone', () => {
  it('POST /web3/device/revoke no longer exists — a self-signed foreign revocation cannot land', async () => {
    const victim = freshDid();
    const attacker = nacl.sign.keyPair();
    const didHash = didKey.didHashHex(victim);
    const revokedAt = Date.now();
    const signature = nacl.sign.detached(
      new TextEncoder().encode(`aegislink:revoke:${didHash}:${revokedAt}`),
      attacker.secretKey,
    );
    const res = await request(app).post('/web3/device/revoke').send({
      didHash,
      revokedAt,
      signature: encodeBase64(signature),
      signingPublicKeyB64: encodeBase64(attacker.publicKey),
    });
    expect(res.status).toBe(404);
    expect(await web3Repo.isRevoked(didHash)).toBe(false);
    expect((await resolve(victim)).status).toBe(200);
  });

  it('GET /web3/device/revocation/:didHash no longer exists', async () => {
    const res = await request(app).get(`/web3/device/revocation/${'a'.repeat(64)}`);
    expect(res.status).toBe(404);
  });
});

describe('GET /web3/did/resolve/:did', () => {
  it('resolves an active did:key to its W3C DID Document', async () => {
    const did = freshDid();
    const res = await resolve(did);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/ld+json');
    expect(res.body['@context']).toBe('https://w3id.org/did-resolution/v1');
    expect(res.body.didDocument).toEqual(didKey.didKeyDocument(did));
    expect(res.body.didResolutionMetadata).toEqual({ contentType: 'application/did+ld+json' });
    expect(res.body.didDocumentMetadata).toEqual({});
  });

  it('reports a revoked DID as deactivated with 410', async () => {
    const did = freshDid();
    await web3Repo.insertRevocation(didKey.didHashHex(did));
    const res = await resolve(did);
    expect(res.status).toBe(410);
    expect(res.body.didDocument.id).toBe(did);
    expect(res.body.didDocumentMetadata).toEqual({ deactivated: true });
  });

  it('does not let a non-canonical alias of a revoked key read as active', async () => {
    const did = freshDid();
    await web3Repo.insertRevocation(didKey.didHashHex(did));
    const alias = did.replace('did:key:z', 'did:key:z1');
    const res = await resolve(alias);
    expect(res.status).toBe(400);
    expect(res.body.didResolutionMetadata).toEqual({ error: 'invalidDid' });
    expect(res.body.didDocument).toBeNull();
  });

  it('answers methodNotSupported (501) for did:ethr and other methods', async () => {
    for (const did of ['did:ethr:0xb9c5714089478a327f09197987f16f9e5d936e8a', 'did:web:example.com']) {
      const res = await resolve(did);
      expect(res.status).toBe(501);
      expect(res.body.didResolutionMetadata).toEqual({ error: 'methodNotSupported' });
      expect(res.body.didDocument).toBeNull();
    }
  });

  it.each([
    ['not a DID', 'hello'],
    ['empty method-specific id', 'did:key:'],
    ['broken did:key', 'did:key:zNotAKey'],
    ['oversized', `did:key:z${'a'.repeat(300)}`],
  ])('rejects %s as invalidDid (400)', async (_label, did) => {
    const res = await resolve(did);
    expect(res.status).toBe(400);
    expect(res.body.didResolutionMetadata).toEqual({ error: 'invalidDid' });
  });
});

describe('revoked_did_hashes migration', () => {
  it('drops untrusted legacy rows and rebuilds the table hash-only', async () => {
    const { initSqliteSchema } = await import('../db/sqlite.js');
    const db = new DatabaseSync(':memory:');
    db.exec(`
      CREATE TABLE revoked_did_hashes (
        did_hash        TEXT PRIMARY KEY,
        revoked_at      INTEGER NOT NULL,
        signature_b64   TEXT NOT NULL,
        signing_pub_key TEXT NOT NULL
      );
      INSERT INTO revoked_did_hashes VALUES ('${'b'.repeat(64)}', 1, 'sig', 'pub');
    `);

    initSqliteSchema(db);

    const cols = (db.prepare(`PRAGMA table_info(revoked_did_hashes)`).all() as Array<{ name: string }>)
      .map((c) => c.name);
    expect(cols).toEqual(['did_hash']);
    expect({ ...(db.prepare(`SELECT COUNT(*) AS n FROM revoked_did_hashes`).get() as object) }).toEqual({ n: 0 });

    // Idempotent: a second boot keeps rows written under the new schema.
    db.exec(`INSERT INTO revoked_did_hashes (did_hash) VALUES ('${'c'.repeat(64)}')`);
    initSqliteSchema(db);
    expect({ ...(db.prepare(`SELECT COUNT(*) AS n FROM revoked_did_hashes`).get() as object) }).toEqual({ n: 1 });
    db.close();
  });
});
