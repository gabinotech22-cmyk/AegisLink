/**
 * web3DeviceRevoke.test.ts
 *
 * Integration test for POST /web3/device/revoke and GET /web3/device/revocation/:didHash.
 *
 * Uses an in-memory SQLite database (AEGIS_DB_PATH=:memory:) to avoid touching
 * the real data directory. The server is NOT started — we test the Express app
 * directly via supertest.
 *
 * Privacy properties verified:
 * - The server accepts a revocation only when the Ed25519 signature is valid.
 * - The server stores only the hash, never the DID in plaintext.
 * - The revocation check endpoint returns only a boolean.
 * - A tampered payload is rejected with 403.
 */

import { createHash } from 'node:crypto';
import express from 'express';
import nacl from 'tweetnacl';
import { encodeBase64 } from 'tweetnacl-util';
import request from 'supertest';

// Point SQLite at a temp file so parallel test runs don't collide.
const DB_PATH = `:memory:`;
process.env['AEGIS_DB_PATH'] = DB_PATH;

// Import routes AFTER setting AEGIS_DB_PATH so the DB is bootstrapped correctly.
// Done in beforeAll rather than a top-level `await import`: ts-jest's ESM emit
// is not reliable across the suite, and a top-level await that gets downleveled
// to CommonJS is a hard SyntaxError ("await is only valid in async functions").
// Deferring the import keeps the file valid under both module modes.
let app: express.Express;

beforeAll(async () => {
  const { default: web3Routes } = await import('../routes/web3.js');
  app = express();
  app.use(express.json());
  app.use('/web3', web3Routes);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex');
}

function buildPayload(
  keypair: nacl.SignKeyPair,
  didHash: string,
  revokedAt: number
) {
  const message = `aegislink:revoke:${didHash}:${revokedAt}`;
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = nacl.sign.detached(msgBytes, keypair.secretKey);
  return {
    didHash,
    revokedAt,
    signature: encodeBase64(sigBytes),
    signingPublicKeyB64: encodeBase64(keypair.publicKey),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('POST /web3/device/revoke', () => {
  const keypair = nacl.sign.keyPair();
  const did = 'did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK';
  const didHash = sha256Hex(did);

  it('accepts a valid revocation payload and returns 201', async () => {
    const revokedAt = Date.now();
    const payload = buildPayload(keypair, didHash, revokedAt);
    const res = await request(app).post('/web3/device/revoke').send(payload);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ revoked: true });
  });

  it('is idempotent — second call returns 200', async () => {
    const revokedAt = Date.now();
    const payload = buildPayload(keypair, didHash, revokedAt);
    await request(app).post('/web3/device/revoke').send(payload);
    const res = await request(app).post('/web3/device/revoke').send(payload);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true });
  });

  it('rejects a payload with an invalid signature (403)', async () => {
    const revokedAt = Date.now();
    const payload = buildPayload(keypair, didHash, revokedAt);
    // Tamper the signature.
    const tampered = { ...payload, signature: encodeBase64(nacl.randomBytes(64)) };
    const res = await request(app).post('/web3/device/revoke').send(tampered);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('invalid_signature');
  });

  it('rejects a payload with a stale timestamp (400)', async () => {
    const staleAt = Date.now() - 10 * 60 * 1000; // 10 minutes ago
    const otherDID = 'did:key:z6MkpTHR8VNsBxYAAWHut2Geadd9jSwuias8sisDArDJF';
    const otherHash = sha256Hex(otherDID);
    const payload = buildPayload(keypair, otherHash, staleAt);
    const res = await request(app).post('/web3/device/revoke').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('revocation_timestamp_out_of_range');
  });

  it('rejects a malformed didHash (400)', async () => {
    const payload = {
      didHash: 'not_a_valid_hash',
      revokedAt: Date.now(),
      signature: encodeBase64(nacl.randomBytes(64)),
      signingPublicKeyB64: encodeBase64(keypair.publicKey),
    };
    const res = await request(app).post('/web3/device/revoke').send(payload);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_body');
  });
});

describe('GET /web3/device/revocation/:didHash', () => {
  const keypair2 = nacl.sign.keyPair();
  const did2 = 'did:key:z6MkiTsvne5bLnHHmFmLBPBfDFHcW8uFTFk4hpVHSfhm';
  const didHash2 = sha256Hex(did2);

  it('returns revoked: false for an unknown hash', async () => {
    const unknownHash = 'a'.repeat(64);
    const res = await request(app).get(`/web3/device/revocation/${unknownHash}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: false });
  });

  it('returns revoked: true after a revocation is submitted', async () => {
    const revokedAt = Date.now();
    const payload = buildPayload(keypair2, didHash2, revokedAt);
    await request(app).post('/web3/device/revoke').send(payload);

    const res = await request(app).get(`/web3/device/revocation/${didHash2}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true });
  });

  it('rejects a non-hex hash format (400)', async () => {
    const res = await request(app).get('/web3/device/revocation/not-a-hex-hash');
    expect(res.status).toBe(400);
  });
});
