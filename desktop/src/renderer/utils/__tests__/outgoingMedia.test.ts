/**
 * Desktop sends attachments in mobile's formats. It used to wrap every picked
 * file — PDFs, ZIPs — in `[image:…]`, which the receiver showed as a broken
 * image.
 */
import { describe, it, expect } from 'vitest';
import { mediaKindOf, outgoingMediaWire, wireFileName } from '../outgoingMedia';
import { parseIncomingMedia } from '../incomingMedia';

const URI = 'blob:abc:S0VZ:Tk9OQ0U=:tok';

describe('outgoingMediaWire', () => {
  it('maps the MIME type to image, video or file', () => {
    expect(mediaKindOf('image/png')).toBe('image');
    expect(mediaKindOf('video/mp4')).toBe('video');
    expect(mediaKindOf('application/pdf')).toBe('file');
    expect(mediaKindOf('')).toBe('file');
  });

  it('a PDF goes as a file, not as an image', () => {
    expect(outgoingMediaWire('file', URI, '', 'report.pdf')).toBe(`[file:report.pdf:${URI}]`);
  });

  it('file names cannot break the wire format or carry a path', () => {
    expect(wireFileName('C:\\\\Users\\\\ana\\\\a:b[1].pdf')).toBe('ab1.pdf');
    expect(wireFileName('/tmp/x/notes.txt')).toBe('notes.txt');
    expect(wireFileName(':[]')).toBe('file');
  });

  it('round-trips through the receive parser (what the other side decodes)', () => {
    expect(parseIncomingMedia(outgoingMediaWire('image', URI, 'hola', 'x.jpg'))).toEqual({ type: 'image', body: 'hola', mediaUri: URI });
    expect(parseIncomingMedia(outgoingMediaWire('video', URI, '', 'x.mp4'))).toEqual({ type: 'video', body: '', mediaUri: URI });
    expect(parseIncomingMedia(outgoingMediaWire('file', URI, '', 'a:b.zip'))).toEqual({ type: 'file', body: 'ab.zip', mediaUri: URI });
  });
});
