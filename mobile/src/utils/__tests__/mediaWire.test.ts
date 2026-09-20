import { isMediaMessage, mediaWireText, mediaMimeFor, mediaExtFor } from '../mediaWire';

const BLOB = 'blob:abc:key==:nonce==';

describe('mediaWireText — rebuilds what the receiver parses', () => {
  it('image: blob reference first, caption after', () => {
    expect(mediaWireText({ type: 'image', body: 'hola', mediaUri: BLOB })).toBe(`[image:${BLOB}]hola`);
    expect(mediaWireText({ type: 'image', body: '', mediaUri: BLOB })).toBe(`[image:${BLOB}]`);
  });

  it('video: reference only (videos carry no caption)', () => {
    expect(mediaWireText({ type: 'video', body: '', mediaUri: BLOB })).toBe(`[video:${BLOB}]`);
  });

  it('audio: keeps the stored duration, also behind a group sender prefix', () => {
    expect(mediaWireText({ type: 'audio', body: '[audio:12s]', mediaUri: BLOB })).toBe(`[audio:12s:${BLOB}]`);
    expect(mediaWireText({ type: 'audio', body: 'ABCD1234: [audio:7s]', mediaUri: BLOB })).toBe(`[audio:7s:${BLOB}]`);
    expect(mediaWireText({ type: 'audio', body: 'garbage', mediaUri: BLOB })).toBe(`[audio:0s:${BLOB}]`);
  });

  it('non-media or missing reference: body untouched', () => {
    expect(mediaWireText({ type: 'text', body: 'hi', mediaUri: BLOB })).toBe('hi');
    expect(mediaWireText({ type: 'image', body: 'caption', mediaUri: null })).toBe('caption');
    expect(mediaWireText({ type: 'view_once', body: '[viewonce]', mediaUri: BLOB })).toBe('[viewonce]');
  });
});

describe('type helpers', () => {
  it('isMediaMessage', () => {
    expect(isMediaMessage('image')).toBe(true);
    expect(isMediaMessage('video')).toBe(true);
    expect(isMediaMessage('audio')).toBe(true);
    expect(isMediaMessage('text')).toBe(false);
    expect(isMediaMessage('view_once')).toBe(false);
    expect(isMediaMessage(undefined)).toBe(false);
  });

  it('mediaMimeFor / mediaExtFor', () => {
    expect(mediaMimeFor('image', 'file:///a/b.gif')).toBe('image/gif');
    expect(mediaMimeFor('image', 'file:///a/b.jpg')).toBe('image/jpeg');
    expect(mediaMimeFor('video', 'x')).toBe('video/mp4');
    expect(mediaMimeFor('audio', 'x')).toBe('audio/m4a');
    expect(mediaExtFor('image')).toBe('jpg');
    expect(mediaExtFor('video')).toBe('mp4');
    expect(mediaExtFor('audio')).toBe('m4a');
  });
});
