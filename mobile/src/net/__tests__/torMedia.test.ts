/**
 * torMedia — remote bytes reach the device only through Tor (Tor always-on).
 *
 *   - In a production build every non-loopback URL — the relay onion AND a
 *     clearnet GIF CDN / link-preview host — goes through the native Tor
 *     download; the OS downloader is never called.
 *   - Fail-closed: no Tor → null, never a direct fetch.
 *   - `torCachedImage` caches by URL hash, only for https / onion URLs.
 */
const mockTor = {
  available: true,
  download: jest.fn(async (..._a: unknown[]): Promise<number | null> => 200),
};
jest.mock('../tor', () => ({
  __esModule: true,
  isTorAvailable: () => mockTor.available,
  startTor: jest.fn(async () => ({ state: 'on', socksPort: 9050 })),
  torHttpDownload: (...a: unknown[]) => mockTor.download(...a),
  torHttpRequest: jest.fn(),
}));

const mockFs = {
  files: new Set<string>(),
  downloadAsync: jest.fn(async () => ({ status: 200 })),
};
jest.mock('expo-file-system/legacy', () => ({
  __esModule: true,
  cacheDirectory: 'file:///cache/',
  downloadAsync: (...a: unknown[]) => mockFs.downloadAsync(...(a as [])),
  getInfoAsync: jest.fn(async (p: string) => ({ exists: mockFs.files.has(p) })),
  makeDirectoryAsync: jest.fn(async () => undefined),
  deleteAsync: jest.fn(async () => undefined),
  moveAsync: jest.fn(async ({ to }: { from: string; to: string }) => { mockFs.files.add(to); }),
}));

import { torDownloadTo, torCachedImage } from '../torMedia';

const ONION = `http://${'a'.repeat(56)}.onion`;
const g = globalThis as { __DEV__?: boolean };

describe('torMedia', () => {
  const dev = g.__DEV__;
  beforeEach(() => {
    g.__DEV__ = false; // production build
    mockTor.available = true;
    mockTor.download.mockReset().mockResolvedValue(200);
    mockFs.downloadAsync.mockClear();
    mockFs.files.clear();
  });
  afterAll(() => { g.__DEV__ = dev; });

  it('production: a clearnet CDN URL goes through Tor, never the OS downloader', async () => {
    expect(await torDownloadTo('https://static.klipy.com/x.gif', '/tmp/x')).toBe(200);
    expect(mockTor.download).toHaveBeenCalledWith('https://static.klipy.com/x.gif', '/tmp/x');
    expect(mockFs.downloadAsync).not.toHaveBeenCalled();
  });

  it('the relay onion goes through Tor', async () => {
    await torDownloadTo(`${ONION}/blob/download/1`, '/tmp/b');
    expect(mockTor.download).toHaveBeenCalledTimes(1);
    expect(mockFs.downloadAsync).not.toHaveBeenCalled();
  });

  it('fail-closed: no Tor → null, no direct fetch', async () => {
    mockTor.available = false;
    expect(await torDownloadTo('https://example.org/a.png', '/tmp/a')).toBeNull();
    expect(mockFs.downloadAsync).not.toHaveBeenCalled();
  });

  it('a loopback dev relay uses the OS downloader (unreachable through Tor)', async () => {
    await torDownloadTo('http://10.0.2.2:3001/blob/download/1', '/tmp/l');
    expect(mockFs.downloadAsync).toHaveBeenCalledTimes(1);
    expect(mockTor.download).not.toHaveBeenCalled();
  });

  it('torCachedImage: downloads once over Tor, then serves the cached file', async () => {
    const url = 'https://example.org/og.png';
    const first = await torCachedImage(url);
    expect(first).toMatch(/^file:\/\/\/cache\/tor-media\/[0-9a-f]{32}$/);
    expect(first).not.toContain('example');
    const second = await torCachedImage(url);
    expect(second).toBe(first);
    expect(mockTor.download).toHaveBeenCalledTimes(1);
  });

  it('torCachedImage: non-https / non-onion URLs and HTTP errors yield null', async () => {
    expect(await torCachedImage('http://example.org/a.png')).toBeNull();
    expect(await torCachedImage('javascript:alert(1)')).toBeNull();
    mockTor.download.mockResolvedValueOnce(404);
    expect(await torCachedImage('https://example.org/missing.png')).toBeNull();
  });
});
