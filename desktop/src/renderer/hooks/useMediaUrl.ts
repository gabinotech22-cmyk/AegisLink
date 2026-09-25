/**
 * Turn a stored media reference into something an <img>/<video>/<audio> can
 * play. A `blob:` WIRE URI (`crypto/media.ts` parseBlobUri) is downloaded and
 * decrypted on demand; anything else (a `data:` URI, an object URL made on this
 * device) is used as is.
 *
 * Decrypted object URLs are cached per wire URI for the session (bounded; the
 * oldest is revoked), so scrolling back does not download again. The cache is
 * memory only: nothing decrypted is written to disk.
 */
import { useEffect, useState } from 'react';
import { downloadAndDecryptMedia, parseBlobUri } from '../crypto/media';

export type MediaState = 'loading' | 'ready' | 'expired' | 'error';

const MAX_CACHED = 200;
const cache = new Map<string, Promise<string>>();

/** Resolve a stored media reference to a playable URL (see the header). */
export function resolveMediaUrl(uri: string, mimeType?: string): Promise<string> {
  if (!parseBlobUri(uri) || isLocalObjectUrl(uri)) return Promise.resolve(uri);
  const hit = cache.get(uri);
  if (hit) return hit;
  const pending = downloadAndDecryptMedia(uri, mimeType);
  cache.set(uri, pending);
  pending.catch(() => cache.delete(uri)); // a failure is retried on the next render
  evictOverflow();
  return pending;
}

/**
 * Seed the cache with a local object URL for a wire URI this device just sent,
 * so its own bubble shows at once without downloading what it uploaded.
 */
export function primeMediaUrl(uri: string, objectUrl: string): void {
  cache.set(uri, Promise.resolve(objectUrl));
  evictOverflow();
}

export function useMediaUrl(uri: string | null | undefined, mimeType?: string): { url: string | null; state: MediaState } {
  const [result, setResult] = useState<{ url: string | null; state: MediaState }>({ url: null, state: 'loading' });

  useEffect(() => {
    let alive = true;
    if (!uri) {
      setResult({ url: null, state: 'error' });
      return;
    }
    setResult({ url: null, state: 'loading' });
    resolveMediaUrl(uri, mimeType).then(
      (url) => { if (alive) setResult({ url, state: 'ready' }); },
      (e: unknown) => {
        if (!alive) return;
        const expired = e instanceof Error && e.message === 'attachment_expired';
        setResult({ url: null, state: expired ? 'expired' : 'error' });
      },
    );
    return () => { alive = false; };
  }, [uri, mimeType]);

  return result;
}

/** `blob:http…`/`blob:file…`: an object URL of this renderer, not a wire URI. */
function isLocalObjectUrl(uri: string): boolean {
  return /^blob:[a-z]+:\/\//i.test(uri) || uri.startsWith('blob:null/');
}

function evictOverflow(): void {
  while (cache.size > MAX_CACHED) {
    const oldest = cache.keys().next().value as string;
    const p = cache.get(oldest);
    cache.delete(oldest);
    void p?.then((url) => { if (url.startsWith('blob:')) URL.revokeObjectURL(url); }, () => undefined);
  }
}
