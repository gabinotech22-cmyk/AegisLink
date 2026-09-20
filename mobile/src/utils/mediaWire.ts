/**
 * Rebuild the wire text of a media message from what we keep locally.
 *
 * A sent media message is stored SPLIT: `body` holds the caption (image) or the
 * duration tag (audio), `mediaUri` holds the blob reference. The receiver only
 * understands the joined form (`[image:blob:…]caption`, `[video:blob:…]`,
 * `[audio:Ns:blob:…]`, see socket/client.ts receive path), so a retry has to
 * put the two halves back together — sending `body` alone ships a bare caption
 * and the recipient never sees the attachment.
 */
export type MediaWireMessage = {
  type?: string | null;
  body: string;
  mediaUri?: string | null;
};

const MEDIA_TYPES: ReadonlySet<string> = new Set(['image', 'video', 'audio']);

/** True for the message types whose wire text embeds a blob reference. */
export function isMediaMessage(type: string | null | undefined): boolean {
  return !!type && MEDIA_TYPES.has(type);
}

/**
 * The plaintext to put on the wire for `msg`. Non-media messages (or a media
 * message with no reference yet) return `body` unchanged.
 */
export function mediaWireText(msg: MediaWireMessage): string {
  const uri = msg.mediaUri;
  if (!uri || !isMediaMessage(msg.type)) return msg.body;
  switch (msg.type) {
    case 'image':
      return `[image:${uri}]${msg.body}`;
    case 'video':
      return `[video:${uri}]`;
    case 'audio': {
      // Local body is `[audio:Ns]` (group bodies may carry a sender prefix).
      const dur = /\[audio:(\d+)s\]/.exec(msg.body)?.[1] ?? '0';
      return `[audio:${dur}s:${uri}]`;
    }
    default:
      return msg.body;
  }
}

/** MIME to (re)upload a local media file with, by message type and extension. */
export function mediaMimeFor(type: string | null | undefined, uri: string): string {
  switch (type) {
    case 'image':
      return /\.gif$/i.test(uri) ? 'image/gif' : 'image/jpeg';
    case 'video':
      return 'video/mp4';
    default:
      return 'audio/m4a';
  }
}

/** Cache extension resolveMedia should decrypt a blob to, by message type. */
export function mediaExtFor(type: string | null | undefined): string {
  switch (type) {
    case 'video':
      return 'mp4';
    case 'audio':
      return 'm4a';
    default:
      return 'jpg';
  }
}
