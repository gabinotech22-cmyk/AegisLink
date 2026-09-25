/**
 * Parse the media wire text of an incoming 1:1 message (the formats mobile
 * sends, `mobile/src/utils/mediaWire.ts` and `attachmentFormat.ts`):
 *
 *   [image:<uri>]caption         [video:<uri>]           [audio:Ns:<uri>]
 *   [file:<name>:<blob uri>]     [multi:N][seg]…caption
 *
 * `<uri>` is a `blob:` wire URI (`crypto/media.ts` parseBlobUri: v1/v2/v3) or,
 * for small legacy media, a `data:` URI. The returned `mediaUri` is the WIRE
 * reference, stored as is (the messages DB encrypts it at rest) and decrypted
 * on demand when the bubble renders (`hooks/useMediaUrl.ts`), so it survives a
 * restart; an object URL made at receive time would not. An album keeps its
 * whole `[multi:N][seg]…` prefix as `mediaUri`; the bubble parses it again with
 * `parseMultiPayload`.
 *
 * View-once media is not handled here (see the caller). Returns null for text.
 */
export type IncomingMediaType = 'image' | 'video' | 'audio' | 'file' | 'album';

export interface IncomingMedia {
  type: IncomingMediaType;
  /** What the bubble shows as text: the caption, a file name, or `[audio:Ns]`. */
  body: string;
  mediaUri: string;
}

export interface AlbumItem {
  type: 'image' | 'video' | 'audio' | 'file';
  uri: string;
  fileName?: string;
  duration?: number;
}

export function parseIncomingMedia(body: string): IncomingMedia | null {
  if (body.startsWith('[multi:')) {
    const parsed = parseMultiPayload(body);
    if (!parsed) return null;
    return { type: 'album', body: parsed.caption, mediaUri: body.slice(0, body.length - parsed.caption.length) };
  }

  const close = body.indexOf(']');
  if (!body.startsWith('[') || close === -1) return null;
  const segment = body.slice(1, close);
  const rest = body.slice(close + 1);

  if (segment.startsWith('image:')) {
    const uri = segment.slice(6);
    return isMediaUri(uri) ? { type: 'image', body: rest, mediaUri: uri } : null;
  }
  // The formats below carry no caption: anything after `]` means it is not ours.
  if (rest !== '') return null;
  if (segment.startsWith('video:')) {
    const uri = segment.slice(6);
    return isMediaUri(uri) ? { type: 'video', body: '', mediaUri: uri } : null;
  }
  if (segment.startsWith('audio:')) {
    const m = /^audio:(\d+)s:(.+)$/.exec(segment);
    return m && isMediaUri(m[2]) ? { type: 'audio', body: `[audio:${m[1]}s]`, mediaUri: m[2] } : null;
  }
  if (segment.startsWith('file:')) {
    const inner = segment.slice(5);
    const at = inner.indexOf(':blob:');
    if (at === -1) return null;
    return { type: 'file', body: inner.slice(0, at) || 'file', mediaUri: inner.slice(at + 1) };
  }
  return null;
}

/** Twin of mobile's `parseMultiPayload` (`[multi:N][seg]…caption`). */
export function parseMultiPayload(body: string): { attachments: AlbumItem[]; caption: string } | null {
  if (!body.startsWith('[multi:')) return null;
  const firstClose = body.indexOf(']');
  if (firstClose === -1) return null;
  let rest = body.slice(firstClose + 1);
  const attachments: AlbumItem[] = [];

  while (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']');
    if (closeIdx === -1) break;
    const segment = rest.slice(1, closeIdx);
    rest = rest.slice(closeIdx + 1);

    if (segment.startsWith('image:')) {
      attachments.push({ type: 'image', uri: segment.slice(6) });
    } else if (segment.startsWith('video:')) {
      attachments.push({ type: 'video', uri: segment.slice(6) });
    } else if (segment.startsWith('audio:')) {
      const inner = segment.slice(6);
      const colonIdx = inner.indexOf(':');
      if (colonIdx !== -1) {
        attachments.push({ type: 'audio', uri: inner.slice(colonIdx + 1), duration: parseInt(inner.slice(0, colonIdx), 10) || 0 });
      }
    } else if (segment.startsWith('file:')) {
      const inner = segment.slice(5);
      const blobIdx = inner.indexOf(':blob:');
      if (blobIdx !== -1) {
        attachments.push({ type: 'file', uri: inner.slice(blobIdx + 1), fileName: inner.slice(0, blobIdx) });
      }
    }
    // Unknown segment types are skipped for forward compatibility (as on mobile).
  }

  if (attachments.length === 0) return null;
  return { attachments, caption: rest };
}

function isMediaUri(uri: string): boolean {
  return uri.startsWith('blob:') || uri.startsWith('data:');
}
