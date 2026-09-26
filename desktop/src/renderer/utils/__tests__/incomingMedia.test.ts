/**
 * Desktop receives every attachment format mobile sends (the media gap:
 * desktop only recognised the 4-part v1 `blob:` URI and captionless images,
 * so current attachments showed as broken images or raw text).
 */
import { describe, it, expect } from 'vitest';
import { parseIncomingMedia, parseMultiPayload } from '../incomingMedia';
import { parseBlobUri } from '../../crypto/media';

const V1 = 'blob:abc123:S0VZ:Tk9OQ0U=';
const V2 = 'blob:abc123:S0VZ:Tk9OQ0U=:tok456';
const V3 = 'blob:abc123:S0VZ:Tk9OQ0U=:tok456:' + 'a'.repeat(56) + '.onion';

describe('parseIncomingMedia', () => {
  it('keeps the wire URI of every blob version (the relay-hosted copy is decrypted on render)', () => {
    for (const uri of [V1, V2, V3]) {
      expect(parseBlobUri(uri)).not.toBeNull();
      expect(parseIncomingMedia(`[image:${uri}]`)).toEqual({ type: 'image', body: '', mediaUri: uri });
    }
  });

  it('an image keeps its caption (mobile puts it after the closing bracket)', () => {
    expect(parseIncomingMedia(`[image:${V2}]look at this]`)).toEqual({ type: 'image', body: 'look at this]', mediaUri: V2 });
    expect(parseIncomingMedia('[image:data:image/jpeg;base64,AAAA]hi')).toEqual({ type: 'image', body: 'hi', mediaUri: 'data:image/jpeg;base64,AAAA' });
  });

  it('video, audio and file', () => {
    expect(parseIncomingMedia(`[video:${V3}]`)).toEqual({ type: 'video', body: '', mediaUri: V3 });
    expect(parseIncomingMedia(`[audio:12s:${V2}]`)).toEqual({ type: 'audio', body: '[audio:12s]', mediaUri: V2 });
    expect(parseIncomingMedia(`[file:report.pdf:${V2}]`)).toEqual({ type: 'file', body: 'report.pdf', mediaUri: V2 });
  });

  it('an album keeps its segments as the media reference and the caption as the body', () => {
    const segs = `[multi:3][image:${V2}][video:${V3}][file:a.txt:${V1}]`;
    const m = parseIncomingMedia(`${segs}trip`);
    expect(m).toEqual({ type: 'album', body: 'trip', mediaUri: segs });
    const album = parseMultiPayload(m!.mediaUri);
    expect(album?.attachments.map((a) => a.type)).toEqual(['image', 'video', 'file']);
    expect(album?.attachments[2]).toEqual({ type: 'file', uri: V1, fileName: 'a.txt' });
    expect(album?.caption).toBe('');
  });

  it('plain text, unknown tags and malformed media stay text', () => {
    for (const body of ['hello', '[call:audio:ended]', '[contact:Ana:ABC-DEFG-HIJK]', '[image:javascript:alert(1)]', '[video:x]', '[audio:blob:x]', `[video:${V2}]extra`, '[multi:1]', '[file:noblob]']) {
      expect(parseIncomingMedia(body)).toBeNull();
    }
  });
});
