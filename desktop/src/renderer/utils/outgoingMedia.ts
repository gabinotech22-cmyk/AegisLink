/**
 * Build the wire text of an outgoing attachment in the formats mobile reads
 * (`mobile/src/utils/mediaWire.ts`, `attachmentFormat.ts`), and pick the
 * message type the sender's own bubble uses.
 *
 * Only images carry a caption on the wire (`[image:<uri>]caption`); for a
 * video or a file the caller sends the caption as its own text message.
 */
export type OutgoingMediaKind = 'image' | 'video' | 'file';

export function mediaKindOf(mimeType: string): OutgoingMediaKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  return 'file';
}

/** A file name safe inside `[file:<name>:<uri>]` (as mobile: no `:`, `[` or `]`). */
export function wireFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[:[\]]/g, '').trim() || 'file';
}

export function outgoingMediaWire(kind: OutgoingMediaKind, wireUri: string, caption: string, fileName: string): string {
  switch (kind) {
    case 'image':
      return `[image:${wireUri}]${caption}`;
    case 'video':
      return `[video:${wireUri}]`;
    case 'file':
      return `[file:${wireFileName(fileName)}:${wireUri}]`;
  }
}
