/**
 * blob URI v3 — desktop parity with mobile/src/crypto/__tests__/media.test.ts
 * (federation F2): the host segment names the relay that hosts the blob.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../config', () => ({ SERVER_URL: 'https://relay.test' }));
vi.mock('../../net/homeRelay', () => ({ getHomeRelay: () => null }));

import { parseBlobUri, formatBlobUri } from '../media';

const ONION = 'pg6mmjiyjmcrsslvykfwnntlaru7p5svn6y2ymmju6nubxndf4pscryd.onion';

describe('parseBlobUri / formatBlobUri (v1, v2, v3)', () => {
  it('parses every shape and normalises the host', () => {
    expect(parseBlobUri('blob:id1:K:N')).toEqual({ id: 'id1', keyB64: 'K', nonceB64: 'N', token: '', host: null });
    expect(parseBlobUri('blob:id1:K:N:T')).toEqual({ id: 'id1', keyB64: 'K', nonceB64: 'N', token: 'T', host: null });
    expect(parseBlobUri(`blob:id1:K:N:T:${ONION.toUpperCase()}`)).toEqual({ id: 'id1', keyB64: 'K', nonceB64: 'N', token: 'T', host: ONION });
  });

  it('a v3 with a bad host is malformed, never silently "official"', () => {
    expect(parseBlobUri('blob:id1:K:N:T:evil.example.com')).toBeNull();
    expect(parseBlobUri('not-a-blob')).toBeNull();
  });

  it('formatBlobUri appends the host only for a custom relay with a token', () => {
    expect(formatBlobUri('id', 'K', 'N', 'T', null)).toBe('blob:id:K:N:T');
    expect(formatBlobUri('id', 'K', 'N', 'T', ONION)).toBe(`blob:id:K:N:T:${ONION}`);
    expect(formatBlobUri('id', 'K', 'N', '', ONION)).toBe('blob:id:K:N');
  });
});
