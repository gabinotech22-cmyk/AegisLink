/**
 * blob.test.ts — covers FIX A (storage quota → 507) and FIX E (download headers).
 *
 * Tests:
 *   FIX A: uploading a blob that would exceed MAX_TOTAL_UPLOAD_BYTES returns 507.
 *   FIX E: GET /blob/download/:id responds with Content-Disposition: attachment
 *          and Content-Type: application/octet-stream.
 */

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

// Redirect uploads to a temp dir so tests are isolated.
const TMP_UPLOADS = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-blob-test-'));
process.env['AEGIS_DB_PATH'] = ':memory:';

// We need to monkeypatch process.cwd() before the module is imported so the
// blob router picks up TMP_UPLOADS as its UPLOADS_DIR. We do this by rewriting
// the path after import via the module-internal variable — but since ESM
// modules are sealed we instead place a real file in TMP_UPLOADS and intercept
// the quota check by manipulating the module's exported state.
//
// Simpler approach: spin up the router with cwd pointing to TMP_UPLOADS.
// We achieve this by temporarily overriding process.cwd().
const _origCwd = process.cwd.bind(process);
// issueChallenge + the blob router are imported in beforeAll (not via top-level
// await): ts-jest's ESM emit is not reliable across the suite, and a top-level
// await downleveled to CommonJS is a hard SyntaxError. The cwd override that
// makes the router pick up TMP_UPLOADS moves into beforeAll with the import.
let issueChallenge: typeof import('../pow/challenge.js')['issueChallenge'];
let app: express.Express;

// ── Helper: obtain a fresh PoW solution ──────────────────────────────────────
function solvePoW(challenge: string, difficulty: number): string {
  let nonce = 0;
  while (true) {
    const nonceHex = nonce.toString(16);
    const digest = crypto.createHash('sha256').update(nonceHex + challenge).digest();
    if (hasLeadingZeroBits(digest, difficulty)) return nonceHex;
    nonce++;
  }
}

function hasLeadingZeroBits(buf: Buffer, bits: number): boolean {
  let remaining = bits;
  for (const byte of buf) {
    if (remaining <= 0) break;
    const check = remaining >= 8 ? 8 : remaining;
    const mask = 0xff & (0xff << (8 - check));
    if ((byte & mask) !== 0) return false;
    remaining -= 8;
  }
  return true;
}

// ── Express app for tests (built in beforeAll; see the import note above) ──────
beforeAll(async () => {
  (process as NodeJS.Process & { cwd: () => string }).cwd = () => TMP_UPLOADS;
  ({ issueChallenge } = await import('../pow/challenge.js'));
  const { default: blobRoutes } = await import('../routes/blob.js');
  (process as NodeJS.Process & { cwd: () => string }).cwd = _origCwd;

  app = express();
  app.use('/blob', blobRoutes);
});

// ── Utility: perform a valid upload ──────────────────────────────────────────
async function doUpload(body: Buffer): Promise<request.Response> {
  const { challenge, difficulty } = issueChallenge();
  const nonce = solvePoW(challenge, difficulty);
  return request(app)
    .post('/blob/upload')
    .query({ powChallenge: challenge, powNonce: nonce })
    .set('Content-Type', 'application/octet-stream')
    .send(body);
}

// ── Cleanup temp dir after all tests ─────────────────────────────────────────
afterAll(() => {
  fs.rmSync(TMP_UPLOADS, { recursive: true, force: true });
});

// ── FIX E: download headers ───────────────────────────────────────────────────
describe('FIX E — blob download anti-render headers', () => {
  it('responds with Content-Disposition: attachment and Content-Type: application/octet-stream', async () => {
    const data = Buffer.from('hello-aegislink');
    const uploadRes = await doUpload(data);
    expect(uploadRes.status).toBe(200);
    const { id, token } = uploadRes.body as { id: string; token: string };
    expect(typeof id).toBe('string');
    expect(typeof token).toBe('string');

    const dlRes = await request(app).get(`/blob/download/${id}`).query({ t: token });
    expect(dlRes.status).toBe(200);
    expect(dlRes.headers['content-disposition']).toMatch(/attachment/i);
    expect(dlRes.headers['content-type']).toMatch(/application\/octet-stream/i);
    expect(dlRes.headers['x-content-type-options']).toBe('nosniff');
  });
});

// ── C-1: download requires the HMAC token bound to the blob id ────────────────
describe('C-1 — blob download authorization token', () => {
  it('upload returns a token and download with the correct token succeeds', async () => {
    const uploadRes = await doUpload(Buffer.from('c1-authorized'));
    expect(uploadRes.status).toBe(200);
    const { id, token } = uploadRes.body as { id: string; token: string };
    expect(token.length).toBeGreaterThan(0);

    const ok = await request(app).get(`/blob/download/${id}`).query({ t: token });
    expect(ok.status).toBe(200);
  });

  it('download WITHOUT a token is rejected with 403 (knowing the UUID is not enough)', async () => {
    const uploadRes = await doUpload(Buffer.from('c1-no-token'));
    const { id } = uploadRes.body as { id: string };

    const res = await request(app).get(`/blob/download/${id}`);
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('forbidden');
  });

  it('download with a WRONG token is rejected with 403', async () => {
    const uploadRes = await doUpload(Buffer.from('c1-bad-token'));
    const { id, token } = uploadRes.body as { id: string; token: string };

    // Flip one char of a same-length token so the constant-time compare runs.
    const wrong = (token[0] === 'A' ? 'B' : 'A') + token.slice(1);
    const res = await request(app).get(`/blob/download/${id}`).query({ t: wrong });
    expect(res.status).toBe(403);
    expect((res.body as { error: string }).error).toBe('forbidden');
  });

  it('a valid token for one blob does not authorize a different blob id', async () => {
    const a = await doUpload(Buffer.from('blob-A'));
    const b = await doUpload(Buffer.from('blob-B'));
    const { token: tokenA } = a.body as { token: string };
    const { id: idB } = b.body as { id: string };

    const res = await request(app).get(`/blob/download/${idB}`).query({ t: tokenA });
    expect(res.status).toBe(403);
  });
});

// ── FIX A: storage quota → 507 ───────────────────────────────────────────────
describe('FIX A — global storage quota returns 507', () => {
  it('returns 507 when the upload would exceed MAX_TOTAL_UPLOAD_BYTES', async () => {
    // We cannot actually fill 5 GB in a test. Instead we manipulate currentTotalBytes
    // by importing the internal module state via a side-channel:
    // write a sentinel file whose stat size tricks the startup initialiser.
    //
    // Because the module is already initialised, we instead craft a body whose
    // size alone exceeds what is left. We do this by pre-filling the uploads dir
    // with a file sized to (MAX - 1 byte) using fs directly so the in-memory
    // counter stays at 0 from module init, then triggering a second request that
    // cannot fit.
    //
    // Practical test: we set up the scenario where currentTotalBytes is already
    // just below the cap by exploiting the initialiser — but since the module was
    // already imported we cannot re-run the IIFE. Instead we write a huge fake
    // file into TMP_UPLOADS/uploads (the dir the router uses) at a size that
    // causes the next request body (even 1 byte) to overflow.
    //
    // We use a simpler, reliable approach: import the private counter via a
    // trivial hack — write a file sized MAX_TOTAL_UPLOAD_BYTES into the dir then
    // spawn a fresh isolated test that re-imports the module fresh. Since ESM
    // caching makes that hard, we instead expose a thin test hook.
    //
    // Simplest reliable approach for ESM: write a large sparse file into the
    // uploads dir so the startup IIFE in a fresh import sees it. We do that by
    // importing the module with a fresh cwd set to a new temp dir containing a
    // pre-seeded large file. The test below does exactly that.

    const FIVE_GB = 5 * 1024 * 1024 * 1024;

    // New isolated tmp dir for this sub-test.
    const isolatedTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-quota-'));
    const isolatedUploads = path.join(isolatedTmp, 'uploads');
    fs.mkdirSync(isolatedUploads);

    // Create a sparse file of exactly MAX_TOTAL_UPLOAD_BYTES size using a
    // truncate — this is instant (no actual disk write) on most filesystems.
    const bigFilePath = path.join(isolatedUploads, crypto.randomUUID());
    const fd = fs.openSync(bigFilePath, 'w');
    fs.ftruncateSync(fd, FIVE_GB);
    fs.closeSync(fd);

    // Override cwd so the freshly imported blob module sees isolatedTmp/uploads.
    (process as NodeJS.Process & { cwd: () => string }).cwd = () => isolatedTmp;

    // Re-evaluate the blob router with a FRESH module registry so its startup
    // scan runs against the overridden cwd (isolatedTmp) and sees the pre-seeded
    // 5 GB file. A `?cachebust` query specifier does not resolve under Jest's
    // module resolver; jest.isolateModulesAsync is the supported way to force a
    // fresh module instance.
    // Capture issueChallenge from the SAME isolated registry as the router, so
    // the PoW challenge is verifiable by the isolated router's own pow module
    // instance (a challenge from the outer instance would be rejected → 403).
    let isolatedRouter!: express.Router;
    let isolatedIssueChallenge!: typeof import('../pow/challenge.js')['issueChallenge'];
    await jest.isolateModulesAsync(async () => {
      const mod = await import('../routes/blob.js');
      isolatedRouter = (mod as { default: express.Router }).default;
      ({ issueChallenge: isolatedIssueChallenge } = await import('../pow/challenge.js'));
    });

    (process as NodeJS.Process & { cwd: () => string }).cwd = _origCwd;

    const isolatedApp = express();
    isolatedApp.use('/blob', isolatedRouter);

    const { challenge, difficulty } = isolatedIssueChallenge();
    const nonce = solvePoW(challenge, difficulty);

    const res = await request(isolatedApp)
      .post('/blob/upload')
      .query({ powChallenge: challenge, powNonce: nonce })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.from('x')); // 1 byte — should overflow 5 GB cap

    expect(res.status).toBe(507);
    expect((res.body as { error: string }).error).toBe('storage_full');

    // Cleanup
    fs.rmSync(isolatedTmp, { recursive: true, force: true });
  });
});
