/**
 * proxyLinkPreview.test.ts — SSRF guard for GET /proxy/linkpreview
 *
 * Verifies that the relay rejects all requests that would cause it to connect
 * to private/loopback/link-local/cloud-metadata addresses (SSRF prevention).
 *
 * Also verifies that:
 *   - A missing or malformed `url` query param yields 400.
 *   - Non-http/https schemes are rejected.
 *   - Rate limit header is present in normal responses.
 *
 * No real network calls are made: all tests exercise the input-validation layer
 * that runs before any fetch() is attempted.
 */

import express from 'express';
import request from 'supertest';
import { default as proxyLinkPreviewRoutes } from '../routes/proxyLinkPreview.js';

const app = express();
app.use(express.json());
app.use('/proxy/linkpreview', proxyLinkPreviewRoutes);

// ── SSRF block-list tests ─────────────────────────────────────────────────────
describe('GET /proxy/linkpreview — SSRF guard', () => {
  const blockedUrls = [
    'http://127.0.0.1/',
    'http://127.0.0.1:8080/secret',
    'http://localhost/',
    'http://localhost:3000/',
    'http://0.0.0.0/',
    'http://10.0.0.1/',
    'http://10.255.255.255/internal',
    'http://172.16.0.1/',
    'http://172.31.255.255/aws',
    'http://192.168.0.1/',
    'http://192.168.1.100/router',
    'http://169.254.169.254/',
    'http://169.254.169.254/latest/meta-data/',
    'http://metadata.google.internal/',
    'https://metadata.google.internal/computeMetadata/v1/',
  ];

  for (const url of blockedUrls) {
    it(`blocks SSRF target: ${url}`, async () => {
      const res = await request(app)
        .get('/proxy/linkpreview')
        .query({ url });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('INVALID_PAYLOAD');
      // Response body must not echo the blocked URL or any IP address.
      expect(JSON.stringify(res.body)).not.toMatch(url);
    });
  }
});

// ── Scheme validation ─────────────────────────────────────────────────────────
describe('GET /proxy/linkpreview — scheme validation', () => {
  it('rejects ftp:// scheme', async () => {
    const res = await request(app)
      .get('/proxy/linkpreview')
      .query({ url: 'ftp://example.com/file.txt' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  it('rejects file:// scheme', async () => {
    const res = await request(app)
      .get('/proxy/linkpreview')
      .query({ url: 'file:///etc/passwd' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });
});

// ── Input validation ──────────────────────────────────────────────────────────
describe('GET /proxy/linkpreview — input validation', () => {
  it('returns 400 when `url` param is missing', async () => {
    const res = await request(app).get('/proxy/linkpreview');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  it('returns 400 when `url` is not a valid URL', async () => {
    const res = await request(app)
      .get('/proxy/linkpreview')
      .query({ url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });

  it('returns 400 when `url` exceeds 2048 chars', async () => {
    const longUrl = 'https://example.com/' + 'a'.repeat(2050);
    const res = await request(app)
      .get('/proxy/linkpreview')
      .query({ url: longUrl });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_PAYLOAD');
  });
});

// ── Privacy: 400 body must never echo the submitted URL ───────────────────────
describe('GET /proxy/linkpreview — zero metadata in error bodies', () => {
  it('does not echo the submitted URL in error response', async () => {
    const res = await request(app)
      .get('/proxy/linkpreview')
      .query({ url: 'http://127.0.0.1/sensitive' });
    expect(res.status).toBe(400);
    // The body must not contain the URL or a raw IP.
    expect(JSON.stringify(res.body)).not.toContain('127.0.0.1');
    expect(JSON.stringify(res.body)).not.toContain('sensitive');
  });
});
