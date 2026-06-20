/**
 * links.csp.test.ts — CSP hardening for the invite landing pages (M-4).
 *
 * Verifies (regla #11):
 *   - /g and /a return a Content-Security-Policy header
 *   - the policy denies everything by default (default-src 'none') and forbids
 *     framing (frame-ancestors 'none')
 *   - the inline bootstrap script is pinned by a SHA-256 hash, and that hash
 *     EXACTLY matches the <script> the page actually ships — otherwise a real
 *     browser would refuse to run it (the page would silently break)
 *   - no 'unsafe-inline' is granted to script-src (injected <script> is refused)
 *   - /.well-known/assetlinks.json still serves JSON
 */

import express from 'express';
import request from 'supertest';
import { createHash } from 'node:crypto';

let app: express.Express;

beforeAll(async () => {
  const { default: linksRoutes } = await import('../routes/links.js');
  app = express();
  app.use('/', linksRoutes);
});

function extractInlineScript(html: string): string {
  const m = html.match(/<script>([\s\S]*?)<\/script>/);
  if (!m) throw new Error('no inline <script> found in landing HTML');
  return m[1];
}

function cspDirective(csp: string, name: string): string | undefined {
  return csp
    .split(';')
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe.each([
  ['/g', 'group'],
  ['/a', 'contact'],
])('CSP on landing %s', (path) => {
  it('ships a strict CSP whose script hash matches the inline script', async () => {
    const res = await request(app).get(path);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);

    const csp = res.headers['content-security-policy'];
    expect(csp).toBeDefined();

    // Deny-by-default + no framing.
    expect(cspDirective(csp, 'default-src')).toBe("default-src 'none'");
    expect(cspDirective(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'");

    // script-src is hash-pinned, never 'unsafe-inline'.
    const scriptSrc = cspDirective(csp, 'script-src');
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");

    // The pinned hash must match the script the page actually serves, or the
    // browser blocks it. This is the regression guard: edit the script without
    // updating the hash → mismatch → test fails before it ships.
    const script = extractInlineScript(res.text);
    const expectedHash = createHash('sha256').update(script, 'utf8').digest('base64');
    expect(scriptSrc).toContain(`'sha256-${expectedHash}'`);
  });
});

describe('assetlinks.json', () => {
  it('still serves the App Links JSON', async () => {
    const res = await request(app).get('/.well-known/assetlinks.json');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].target.package_name).toBe('com.aegislink.app');
  });
});
