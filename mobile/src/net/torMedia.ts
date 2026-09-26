/**
 * torMedia — fetch remote bytes to a local file without the device touching the
 * network outside Tor (Tor always-on).
 *
 * Used for everything the app downloads that is not a relay JSON call: E2EE
 * blob ciphertext, public-channel avatars, GIFs picked to send, GIF picker
 * thumbnails and link-preview images. Before this, the GIF and link-preview
 * images were fetched by the OS straight from the CDN / the linked site. That
 * leaked the device IP, and on a RECEIVED link preview it handed any sender a
 * tracking pixel.
 *
 * Dispatch: `mustUseTor(url)` (net/relayHttp.ts) → native SOCKS download
 * (`torHttpDownload`), fail-closed (no Tor → null, never a clearnet retry).
 * Otherwise (dev build, loopback dev relay) → the OS downloader.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { sha256 } from '../crypto/sodium';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';
import { mustUseTor } from './relayHttp';
import { isTorAvailable, startTor, torHttpDownload } from './tor';

/** Download `url` to `dest`. Resolves the HTTP status, or null on transport failure. */
export async function torDownloadTo(url: string, dest: string): Promise<number | null> {
  if (mustUseTor(url)) {
    if (!isTorAvailable()) return null;
    try { await startTor(); } catch { return null; }
    return torHttpDownload(url, dest);
  }
  try {
    const result = await FileSystem.downloadAsync(url, dest);
    return result.status;
  } catch {
    return null;
  }
}

const CACHE_DIR = `${FileSystem.cacheDirectory ?? ''}tor-media/`;
const inflight = new Map<string, Promise<string | null>>();

/**
 * Local `file://` copy of a remote image, downloaded over Tor and cached by
 * URL hash (the URL itself never becomes a file name). null when it cannot be
 * fetched (no Tor, HTTP error, not https/onion).
 */
export async function torCachedImage(url: string): Promise<string | null> {
  if (!/^https:\/\//i.test(url) && !/^http:\/\/[a-z2-7]{56}\.onion/i.test(url)) return null;
  const key = bytesToHex(sha256(utf8ToBytes(url))).slice(0, 32);
  const existing = inflight.get(key);
  if (existing) return existing;
  const job = (async (): Promise<string | null> => {
    const dest = `${CACHE_DIR}${key}`;
    try {
      const info = await FileSystem.getInfoAsync(dest);
      if (info.exists) return dest;
      await FileSystem.makeDirectoryAsync(CACHE_DIR, { intermediates: true }).catch(() => undefined);
      const tmp = `${dest}.part`;
      const status = await torDownloadTo(url, tmp);
      if (status !== 200) {
        await FileSystem.deleteAsync(tmp, { idempotent: true }).catch(() => undefined);
        return null;
      }
      await FileSystem.moveAsync({ from: tmp, to: dest });
      return dest;
    } catch {
      return null;
    }
  })();
  inflight.set(key, job);
  try {
    return await job;
  } finally {
    inflight.delete(key);
  }
}
