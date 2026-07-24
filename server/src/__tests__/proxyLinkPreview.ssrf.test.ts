/**
 * proxyLinkPreview.ssrf.test.ts — security roadmap Ola 9 (B-8)
 *
 * The IP block list backing the DNS-rebinding defence (assertPublicHost) must
 * reject private/loopback/link-local/metadata addresses — including the cloud
 * metadata IP and IPv4-mapped IPv6 forms — and allow ordinary public IPs.
 */

import { isBlockedIp, canonicalIpv4 } from '../routes/proxyLinkPreview.js';

describe('proxyLinkPreview — B-8 SSRF IP block list', () => {
  it.each([
    '127.0.0.1',
    '0.0.0.0',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.1',
    '169.254.169.254',   // AWS/GCP IMDS
    '100.64.0.1',        // CGNAT
    '::1',               // IPv6 loopback
    'fe80::1',           // IPv6 link-local
    'fc00::1',           // IPv6 unique-local
    '::ffff:169.254.169.254', // IPv4-mapped IMDS
  ])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',     // example.com
    '172.32.0.1',        // just outside RFC1918 172.16/12
    '192.169.0.1',       // not 192.168
    '2606:4700:4700::1111', // public IPv6 (Cloudflare)
  ])('allows %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  // ── Audit 2026-07 (H2): hex-form IPv4-mapped IPv6 bypass ────────────────────
  // `::ffff:a9fe:a9fe` == 169.254.169.254 and `::ffff:7f00:1` == 127.0.0.1 used
  // to slip past the dotted-only regex, reaching cloud metadata / loopback.
  it.each([
    '::ffff:7f00:1',            // 127.0.0.1
    '[::ffff:7f00:1]',          // bracketed, as a URL host arrives
    '::ffff:a9fe:a9fe',         // 169.254.169.254 (IMDS)
    '::ffff:c0a8:0001',         // 192.168.0.1
    '::ffff:0a00:0001',         // 10.0.0.1
    '::7f00:1',                 // IPv4-compatible loopback
  ])('blocks hex-mapped private %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });

  it.each([
    '::ffff:8.8.8.8',          // 8.8.8.8 dotted-mapped
    '::ffff:0808:0808',        // 8.8.8.8 hex-mapped — must NOT be blocked
    '::ffff:5db8:d822',        // 93.184.216.34 hex-mapped
  ])('allows hex-mapped public %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(false);
  });

  it('canonicalIpv4 decodes the hex-mapped forms', () => {
    expect(canonicalIpv4('::ffff:a9fe:a9fe')).toBe('169.254.169.254');
    expect(canonicalIpv4('::ffff:7f00:1')).toBe('127.0.0.1');
    expect(canonicalIpv4('::ffff:0808:0808')).toBe('8.8.8.8');
    expect(canonicalIpv4('2606:4700:4700::1111')).toBeNull();
  });
});
