/**
 * blobUploadPow.test.ts — audit 2026-09-16 AL-04
 *
 * (a) POST /blob/upload without a valid PoW is answered from the headers alone:
 *     the relay never reads the body. Proven with a raw HTTP request that
 *     declares a 40 MB Content-Length, sends only a few bytes, and still gets
 *     the 400 back — with the old middleware order (`express.raw` first) the
 *     server would sit waiting for the remaining ~40 MB.
 * (b) The global quota is reserved atomically: N concurrent uploads that
 *     together exceed the cap cannot all succeed, and the counter never passes
 *     MAX_TOTAL_UPLOAD_BYTES. The old code checked the counter in the handler
 *     and incremented it in the writeFile callback, so parallel requests all
 *     passed the check before any of them counted.
 */

import { jest } from '@jest/globals';
import express from 'express';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

process.env['AEGIS_DB_PATH'] = ':memory:';

const FIVE_GB = 5 * 1024 * 1024 * 1024;
const _origCwd = process.cwd.bind(process);

function solvePoW(challenge: string, difficulty: number): string {
  let nonce = 0;
  while (true) {
    const nonceHex = nonce.toString(16);
    const digest = crypto.createHash('sha256').update(nonceHex + challenge).digest();
    let remaining = difficulty;
    let ok = true;
    for (const byte of digest) {
      if (remaining <= 0) break;
      const check = remaining >= 8 ? 8 : remaining;
      const mask = 0xff & (0xff << (8 - check));
      if ((byte & mask) !== 0) { ok = false; break; }
      remaining -= 8;
    }
    if (ok) return nonceHex;
    nonce++;
  }
}

type BlobModule = typeof import('../routes/blob.js');
type PowModule = typeof import('../pow/challenge.js');

/** Fresh router + pow instance whose uploads dir is pre-seeded to `seedBytes`. */
async function isolatedBlob(seedBytes: number): Promise<{ app: express.Express; blob: BlobModule; pow: PowModule; tmp: string }> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aegis-pow-'));
  const uploads = path.join(tmp, 'uploads');
  fs.mkdirSync(uploads);
  if (seedBytes > 0) {
    const fd = fs.openSync(path.join(uploads, crypto.randomUUID()), 'w');
    fs.ftruncateSync(fd, seedBytes);
    fs.closeSync(fd);
  }
  (process as NodeJS.Process & { cwd: () => string }).cwd = () => tmp;
  let blob!: BlobModule;
  let pow!: PowModule;
  await jest.isolateModulesAsync(async () => {
    blob = await import('../routes/blob.js');
    pow = await import('../pow/challenge.js');
  });
  (process as NodeJS.Process & { cwd: () => string }).cwd = _origCwd;
  const app = express();
  app.use('/blob', blob.default);
  return { app, blob, pow, tmp };
}

describe('POST /blob/upload — PoW is checked before the body is read (AL-04)', () => {
  test('a request without PoW is rejected while its 40 MB body is still unsent', async () => {
    const { app, tmp } = await isolatedBlob(0);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;

    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            host: '127.0.0.1', port, method: 'POST', path: '/blob/upload',
            headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(40 * 1024 * 1024) },
          },
          (res) => { res.resume(); resolve(res.statusCode ?? 0); },
        );
        req.on('error', reject);
        // Only a sliver of the declared body — never the rest.
        req.write(Buffer.alloc(16, 1));
        // Deliberately no req.end(): with body-first parsing the server would wait
        // for the remaining bytes and this promise would only settle on timeout.
        setTimeout(() => reject(new Error('server waited for the body instead of rejecting on headers')), 4_000).unref();
      });
      expect(status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }, 10_000);

  test('a wrong PoW nonce is rejected with 403 before parsing', async () => {
    const { app, pow, tmp } = await isolatedBlob(0);
    const { challenge } = pow.issueChallenge();
    const res = await request(app)
      .post('/blob/upload')
      .query({ powChallenge: challenge, powNonce: 'deadbeef' })
      .set('Content-Type', 'application/octet-stream')
      .send(Buffer.alloc(1024, 7));
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('pow_failed');
    fs.rmSync(tmp, { recursive: true, force: true });
  });
});

describe('POST /blob/upload — quota is reserved atomically (AL-04)', () => {
  test('concurrent uploads at the edge of the cap cannot jointly overshoot it', async () => {
    const CHUNK = 1000;
    // Room for exactly 3 chunks; fire 6 in parallel.
    const { app, blob, pow, tmp } = await isolatedBlob(FIVE_GB - 3 * CHUNK);
    expect(blob.__currentTotalBytes()).toBe(FIVE_GB - 3 * CHUNK);

    const uploads = Array.from({ length: 6 }, () => {
      const { challenge, difficulty } = pow.issueChallenge();
      const nonce = solvePoW(challenge, difficulty);
      return request(app)
        .post('/blob/upload')
        .query({ powChallenge: challenge, powNonce: nonce })
        .set('Content-Type', 'application/octet-stream')
        .send(Buffer.alloc(CHUNK, 9));
    });
    const results = await Promise.all(uploads);
    const ok = results.filter((r) => r.status === 200).length;
    const full = results.filter((r) => r.status === 507).length;

    expect(ok).toBe(3);
    expect(full).toBe(3);
    expect(blob.__currentTotalBytes()).toBeLessThanOrEqual(FIVE_GB);
    expect(blob.__currentTotalBytes()).toBe(FIVE_GB);

    fs.rmSync(tmp, { recursive: true, force: true });
  }, 30_000);
});
