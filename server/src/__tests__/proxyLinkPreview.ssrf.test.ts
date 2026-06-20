/**
 * proxyLinkPreview.ssrf.test.ts — security roadmap Ola 9 (B-8)
 *
 * The IP block list backing the DNS-rebinding defence (assertPublicHost) must
 * reject private/loopback/link-local/metadata addresses — including the cloud
 * metadata IP and IPv4-mapped IPv6 forms — and allow ordinary public IPs.
 */

import { isBlockedIp } from '../routes/proxyLinkPreview.js';

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
});
