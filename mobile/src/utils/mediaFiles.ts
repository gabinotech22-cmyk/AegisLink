/**
 * On-disk cleanup for a message's attachments.
 *
 * A message row going away (delete for me / for everyone, ephemeral expiry,
 * contact or group wipe) used to leave every file behind: the persisted
 * ciphertext `media/<id>.enc`, the DECRYPTED copy `dec_<id>.<ext>` in the
 * cache, and — for what we sent — the local original. An ephemeral photo was
 * decorative. `crypto/media.ts` had deletePersistedMedia() and no caller.
 *
 * Kept free of the crypto/network modules so the DB layer can call it.
 */
import * as FileSystem from 'expo-file-system/legacy';
import { toAbsoluteMediaUri } from './mediaPaths';

const MEDIA_DIR = (FileSystem.documentDirectory ?? FileSystem.cacheDirectory ?? '') + 'media/';

/** `blob:<id>:<key>:<nonce>[:token[:host]]` → id, else null. */
export function blobIdOf(uri: string): string | null {
  if (!uri.startsWith('blob:')) return null;
  const id = uri.slice(5).split(':')[0];
  return id && /^[A-Za-z0-9_-]+$/.test(id) ? id : null;
}

/** Every file a media URI may have on this device. */
export async function mediaFilesFor(uri: string): Promise<string[]> {
  const id = blobIdOf(uri);
  if (id) {
    const out = [`${MEDIA_DIR}${id}.enc`];
    const cacheDir = FileSystem.cacheDirectory;
    if (cacheDir) {
      const files = await FileSystem.readDirectoryAsync(cacheDir).catch(() => [] as string[]);
      for (const f of files as string[]) if (f.startsWith(`dec_${id}.`)) out.push(cacheDir + f);
    }
    return out;
  }
  if (uri.startsWith('http://') || uri.startsWith('https://') || uri.startsWith('data:')) return [];
  const abs = toAbsoluteMediaUri(uri);
  return abs.startsWith('file://') ? [abs] : [];
}

/** Delete every local file behind the given media URIs (best effort, idempotent). */
export async function deleteMediaFilesFor(uris: (string | null | undefined)[]): Promise<void> {
  const targets = new Set<string>();
  for (const u of uris) {
    if (!u) continue;
    for (const f of await mediaFilesFor(u)) targets.add(f);
  }
  await Promise.all([...targets].map((f) => FileSystem.deleteAsync(f, { idempotent: true }).catch(() => {})));
}
