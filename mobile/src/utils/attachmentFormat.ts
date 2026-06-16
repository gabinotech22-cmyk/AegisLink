import type { Attachment } from '../db/local';

/**
 * Builds a multi-attachment wire payload.
 *
 * Format:
 *   [multi:N][image:blob:id:key:nonce][video:blob:id:key:nonce][file:name.pdf:blob:id:key:nonce]caption
 *
 * Each segment is wrapped in square brackets. The trailing caption (which may be
 * empty) follows immediately after all segments.
 */
export function buildMultiPayload(attachments: Attachment[], caption: string): string {
  const segments = attachments.map((att) => {
    switch (att.type) {
      case 'image':
        return `[image:${att.uri}]`;
      case 'video':
        return `[video:${att.uri}]`;
      case 'audio': {
        const dur = att.duration ?? 0;
        return `[audio:${Math.round(dur)}s:${att.uri}]`;
      }
      case 'file':
        return `[file:${att.fileName ?? 'file'}:${att.uri}]`;
    }
  });
  return `[multi:${attachments.length}]${segments.join('')}${caption}`;
}

/**
 * Parses a multi-attachment wire payload produced by `buildMultiPayload`.
 * Returns null if the string is not a valid multi payload.
 */
export function parseMultiPayload(
  body: string
): { attachments: Attachment[]; caption: string } | null {
  if (!body.startsWith('[multi:')) return null;

  // Extract and discard the [multi:N] header
  const firstClose = body.indexOf(']');
  if (firstClose === -1) return null;
  let rest = body.slice(firstClose + 1);

  const attachments: Attachment[] = [];

  while (rest.startsWith('[')) {
    const closeIdx = rest.indexOf(']');
    if (closeIdx === -1) break;

    const segment = rest.slice(1, closeIdx); // strip '[' and ']'
    rest = rest.slice(closeIdx + 1);

    if (segment.startsWith('image:')) {
      const uri = segment.slice(6); // 'image:'.length = 6
      attachments.push({ type: 'image', uri });
    } else if (segment.startsWith('video:')) {
      const uri = segment.slice(6);
      attachments.push({ type: 'video', uri });
    } else if (segment.startsWith('audio:')) {
      // Format: audio:Ns:blob:id:key:nonce
      const inner = segment.slice(6); // strip 'audio:'
      const colonIdx = inner.indexOf(':');
      if (colonIdx !== -1) {
        const durStr = inner.slice(0, colonIdx); // e.g. "30s"
        const durSec = parseInt(durStr, 10) || 0;
        const uri = inner.slice(colonIdx + 1);
        attachments.push({ type: 'audio', uri, duration: durSec });
      }
    } else if (segment.startsWith('file:')) {
      const inner = segment.slice(5); // strip 'file:'
      const blobIdx = inner.indexOf(':blob:');
      if (blobIdx !== -1) {
        const fileName = inner.slice(0, blobIdx);
        const uri = inner.slice(blobIdx + 1); // 'blob:id:key:nonce'
        attachments.push({ type: 'file', uri, fileName });
      } else {
        // fallback — no blob marker
        attachments.push({ type: 'file', uri: inner, fileName: inner });
      }
    }
    // Unknown segment types are silently skipped for forward-compat
  }

  if (attachments.length === 0) return null;

  return { attachments, caption: rest };
}
