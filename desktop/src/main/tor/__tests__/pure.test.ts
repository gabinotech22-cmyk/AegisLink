import { describe, it, expect } from 'vitest';
import { parseBootstrapLine, isTorErrorLine, isOnionUrl } from '../pure';

describe('parseBootstrapLine (tor notice log → progress)', () => {
  it('parses a mid-bootstrap line with a phase tag', () => {
    expect(parseBootstrapLine('Sep 14 19:48:15.000 [notice] Bootstrapped 45% (requesting_descriptors): Asking for relay descriptors'))
      .toEqual({ progress: 45, summary: 'Asking for relay descriptors' });
  });
  it('parses the 100% done line', () => {
    expect(parseBootstrapLine('Sep 14 19:48:20.000 [notice] Bootstrapped 100% (done): Done')).toEqual({ progress: 100, summary: 'Done' });
  });
  it('parses the 0% starting line', () => {
    expect(parseBootstrapLine('[notice] Bootstrapped 0% (starting): Starting')).toEqual({ progress: 0, summary: 'Starting' });
  });
  it('ignores unrelated notice lines', () => {
    expect(parseBootstrapLine('[notice] Opening Socks listener on 127.0.0.1:9151')).toBeNull();
    expect(parseBootstrapLine('')).toBeNull();
  });
  it('clamps a malformed percentage', () => {
    expect(parseBootstrapLine('[notice] Bootstrapped 250%: weird')?.progress).toBe(100);
  });
});

describe('isTorErrorLine', () => {
  it('flags [err] and not [warn]/[notice]', () => {
    expect(isTorErrorLine('[err] Failed to bind one of the listener ports.')).toBe(true);
    expect(isTorErrorLine('[warn] Path for DataDirectory is relative')).toBe(false);
    expect(isTorErrorLine('[notice] Bootstrapped 5%')).toBe(false);
  });
});

describe('isOnionUrl — the sio bridge only dials the hidden service', () => {
  it('accepts http/ws .onion', () => {
    expect(isOnionUrl('http://fhxnal5jmuuqsbtzz7avos4drhqmuy4c7ffd35gi3hw2uwbe5iqshfyd.onion')).toBe(true);
    expect(isOnionUrl('ws://abc.onion/socket.io')).toBe(true);
  });
  it('rejects clearnet, file, and lookalike hosts (fail-closed)', () => {
    expect(isOnionUrl('https://aegislink.duckdns.org')).toBe(false);
    expect(isOnionUrl('http://evil.onion.example.com')).toBe(false);
    expect(isOnionUrl('file:///C:/x.onion')).toBe(false);
    expect(isOnionUrl(42)).toBe(false);
    expect(isOnionUrl('not a url')).toBe(false);
  });
});
