/**
 * Stored media references are decrypted on demand and cached; local object
 * URLs and data: URIs pass through; an expired blob is reported, not retried
 * from cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const download = vi.fn<(uri: string, mime?: string) => Promise<string>>();

vi.mock('../../crypto/media', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../crypto/media')>();
  return { ...real, downloadAndDecryptMedia: (uri: string, mime?: string) => download(uri, mime) };
});

const { resolveMediaUrl, primeMediaUrl } = await import('../useMediaUrl');

describe('resolveMediaUrl', () => {
  beforeEach(() => download.mockReset());

  it('decrypts a wire URI once and serves the cached object URL after', async () => {
    download.mockResolvedValue('blob:file:///decrypted-1');
    const uri = 'blob:id1:S0VZ:Tk9OQ0U=:tok';
    expect(await resolveMediaUrl(uri, 'image/jpeg')).toBe('blob:file:///decrypted-1');
    expect(await resolveMediaUrl(uri, 'image/jpeg')).toBe('blob:file:///decrypted-1');
    expect(download).toHaveBeenCalledTimes(1);
  });

  it('passes data: URIs and this renderer\'s object URLs through untouched', async () => {
    for (const uri of ['data:image/png;base64,AAAA', 'blob:http://localhost:5173/0a1b', 'blob:file:///0a1b']) {
      expect(await resolveMediaUrl(uri)).toBe(uri);
    }
    expect(download).not.toHaveBeenCalled();
  });

  it('a failure is not cached: the next render retries', async () => {
    download.mockRejectedValueOnce(new Error('attachment_unavailable')).mockResolvedValueOnce('blob:file:///ok');
    const uri = 'blob:id2:S0VZ:Tk9OQ0U=:tok';
    await expect(resolveMediaUrl(uri)).rejects.toThrow('attachment_unavailable');
    await Promise.resolve();
    expect(await resolveMediaUrl(uri)).toBe('blob:file:///ok');
    expect(download).toHaveBeenCalledTimes(2);
  });

  it('a primed wire URI (this device sent it) never downloads', async () => {
    const uri = 'blob:id3:S0VZ:Tk9OQ0U=:tok';
    primeMediaUrl(uri, 'blob:file:///local');
    expect(await resolveMediaUrl(uri)).toBe('blob:file:///local');
    expect(download).not.toHaveBeenCalled();
  });
});
