/**
 * AegisLink -- Relative media path utilities (iOS audit finding #6)
 *
 * iOS sandboxes every app inside a container directory whose path includes a
 * UUID that CHANGES between TestFlight builds and reinstalls
 * (`file:///var/mobile/Containers/Data/Application/<UUID>/Documents/...`).
 * Persisting an *absolute* `file://` URI (in SecureStore, SQLite, etc.) means
 * that URI silently rots the next time the app is reinstalled or updated --
 * the file may still exist on disk, just under a different container UUID,
 * so the stored reference becomes a dangling pointer (orphaned avatar,
 * attachment, or scheduled-post draft).
 *
 * The fix: never persist an absolute URI. Store a small relative pointer
 * (`doc:<subpath>` / `cache:<subpath>`) that is re-resolved against
 * `FileSystem.documentDirectory` / `FileSystem.cacheDirectory` -- whatever
 * they currently are -- every time it is read. This also gives us a free
 * hot-migration path for data written before this fix: an old absolute URI
 * that still contains `/Documents/` or `/Library/Caches/` is recognized and
 * rewritten in place.
 */

// SDK 54: expo-file-system's default export dropped `EncodingType` etc. from
// its public surface; the rest of the codebase already standardized on the
// `/legacy` subpath for this reason (see CLAUDE.md "trampas críticas").
import * as FileSystem from 'expo-file-system/legacy';

const DOC_PREFIX = 'doc:';
const CACHE_PREFIX = 'cache:';

/** Directory markers a legacy absolute URI may contain, in priority order. */
const LEGACY_MARKERS: Array<{ marker: string; prefix: string }> = [
  { marker: '/Documents/', prefix: DOC_PREFIX },
  { marker: '/Library/Caches/', prefix: CACHE_PREFIX },
];

function isRemoteOrOpaque(uri: string): boolean {
  return (
    uri.startsWith('http://') ||
    uri.startsWith('https://') ||
    uri.startsWith('content://') ||
    uri.startsWith('ph://') ||
    uri.startsWith('asset://') ||
    uri.startsWith('data:') ||
    uri.startsWith(DOC_PREFIX) ||
    uri.startsWith(CACHE_PREFIX)
  );
}

/**
 * Convert an absolute `file://` URI (current-container OR a stale one from a
 * previous install/build) into a relative, container-independent pointer
 * safe to persist. Non-file URIs (remote, content://, already-relative, …)
 * pass through unchanged.
 */
export function toRelativeMediaPath(uri: string | null | undefined): string {
  if (!uri) return '';
  if (isRemoteOrOpaque(uri)) return uri;
  if (!uri.startsWith('file://')) return uri;

  const docDir = FileSystem.documentDirectory;
  const cacheDir = FileSystem.cacheDirectory;

  // Fast path: matches the CURRENT container's directories exactly.
  if (docDir && uri.startsWith(docDir)) {
    return DOC_PREFIX + uri.slice(docDir.length);
  }
  if (cacheDir && uri.startsWith(cacheDir)) {
    return CACHE_PREFIX + uri.slice(cacheDir.length);
  }

  // Hot-migration path: an absolute URI from a DIFFERENT container UUID
  // (old TestFlight build / pre-reinstall). Recover the subpath from the
  // well-known iOS/Android directory segment.
  for (const { marker, prefix } of LEGACY_MARKERS) {
    const idx = uri.indexOf(marker);
    if (idx !== -1) {
      return prefix + uri.slice(idx + marker.length);
    }
  }

  // Unrecognized absolute file:// URI (e.g. a picker temp path outside our
  // sandboxed dirs) -- nothing safe to rewrite, pass through.
  return uri;
}

/**
 * Reconstruct an absolute `file://` URI from a stored relative pointer,
 * resolved against the CURRENT container's directories. Passthrough for
 * remote/opaque URIs and for anything that isn't a recognized relative
 * pointer (defensive -- covers pre-migration rows that are still absolute
 * but happen to already match the current container).
 */
export function toAbsoluteMediaUri(stored: string | null | undefined): string {
  if (!stored) return '';
  if (
    stored.startsWith('http://') ||
    stored.startsWith('https://') ||
    stored.startsWith('content://') ||
    stored.startsWith('ph://') ||
    stored.startsWith('asset://') ||
    stored.startsWith('data:')
  ) {
    return stored;
  }

  if (stored.startsWith(DOC_PREFIX)) {
    return (FileSystem.documentDirectory ?? '') + stored.slice(DOC_PREFIX.length);
  }
  if (stored.startsWith(CACHE_PREFIX)) {
    return (FileSystem.cacheDirectory ?? '') + stored.slice(CACHE_PREFIX.length);
  }

  // Absolute file:// from an old build that toRelativeMediaPath couldn't
  // classify at write time (e.g. hadn't been migrated yet) -- try to
  // re-resolve it against the CURRENT container so a stale UUID doesn't
  // orphan the reference.
  if (stored.startsWith('file://')) {
    for (const { marker } of LEGACY_MARKERS) {
      const idx = stored.indexOf(marker);
      if (idx !== -1) {
        const suffix = stored.slice(idx + marker.length);
        const isCaches = marker === '/Library/Caches/';
        const base = isCaches ? FileSystem.cacheDirectory : FileSystem.documentDirectory;
        if (base) return base + suffix;
      }
    }
  }

  return stored;
}
