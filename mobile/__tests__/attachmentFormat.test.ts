import { buildMultiPayload, parseMultiPayload } from '../src/utils/attachmentFormat';
import type { Attachment } from '../src/db/local';

describe('buildMultiPayload', () => {
  it('builds payload for a single image', () => {
    const atts: Attachment[] = [{ type: 'image', uri: 'blob:abc:key:nonce' }];
    const result = buildMultiPayload(atts, '');
    expect(result).toBe('[multi:1][image:blob:abc:key:nonce]');
  });

  it('builds payload for multiple mixed attachments with caption', () => {
    const atts: Attachment[] = [
      { type: 'image', uri: 'blob:img1:k1:n1' },
      { type: 'video', uri: 'blob:vid1:k2:n2' },
      { type: 'file', uri: 'blob:file1:k3:n3', fileName: 'doc.pdf' },
    ];
    const result = buildMultiPayload(atts, 'hello');
    expect(result).toBe(
      '[multi:3][image:blob:img1:k1:n1][video:blob:vid1:k2:n2][file:doc.pdf:blob:file1:k3:n3]hello'
    );
  });

  it('builds payload for audio with duration', () => {
    const atts: Attachment[] = [{ type: 'audio', uri: 'blob:aud:k:n', duration: 15 }];
    const result = buildMultiPayload(atts, '');
    expect(result).toBe('[multi:1][audio:15s:blob:aud:k:n]');
  });

  it('rounds audio duration', () => {
    const atts: Attachment[] = [{ type: 'audio', uri: 'blob:aud:k:n', duration: 12.7 }];
    const result = buildMultiPayload(atts, '');
    expect(result).toBe('[multi:1][audio:13s:blob:aud:k:n]');
  });

  it('uses "file" as default fileName when missing', () => {
    const atts: Attachment[] = [{ type: 'file', uri: 'blob:f:k:n' }];
    const result = buildMultiPayload(atts, '');
    expect(result).toBe('[multi:1][file:file:blob:f:k:n]');
  });
});

describe('parseMultiPayload', () => {
  it('returns null for non-multi strings', () => {
    expect(parseMultiPayload('[image:blob:id:k:n]')).toBeNull();
    expect(parseMultiPayload('hello')).toBeNull();
    expect(parseMultiPayload('')).toBeNull();
  });

  it('round-trips a single image', () => {
    const atts: Attachment[] = [{ type: 'image', uri: 'blob:abc:key:nonce' }];
    const payload = buildMultiPayload(atts, '');
    const parsed = parseMultiPayload(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.attachments).toHaveLength(1);
    expect(parsed!.attachments[0].type).toBe('image');
    expect(parsed!.attachments[0].uri).toBe('blob:abc:key:nonce');
    expect(parsed!.caption).toBe('');
  });

  it('round-trips multiple attachments with caption', () => {
    const atts: Attachment[] = [
      { type: 'image', uri: 'blob:img1:k1:n1' },
      { type: 'file', uri: 'blob:file1:k3:n3', fileName: 'doc.pdf' },
    ];
    const payload = buildMultiPayload(atts, 'caption text');
    const parsed = parseMultiPayload(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.attachments).toHaveLength(2);
    expect(parsed!.attachments[1].fileName).toBe('doc.pdf');
    expect(parsed!.caption).toBe('caption text');
  });

  it('round-trips audio with duration', () => {
    const atts: Attachment[] = [{ type: 'audio', uri: 'blob:aud:k:n', duration: 30 }];
    const payload = buildMultiPayload(atts, '');
    const parsed = parseMultiPayload(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.attachments[0].type).toBe('audio');
    expect(parsed!.attachments[0].duration).toBe(30);
    expect(parsed!.attachments[0].uri).toBe('blob:aud:k:n');
  });

  it('round-trips video', () => {
    const atts: Attachment[] = [{ type: 'video', uri: 'blob:v:k:n' }];
    const payload = buildMultiPayload(atts, 'vid cap');
    const parsed = parseMultiPayload(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.attachments[0].type).toBe('video');
    expect(parsed!.caption).toBe('vid cap');
  });

  it('preserves empty caption', () => {
    const payload = buildMultiPayload([{ type: 'image', uri: 'blob:x:y:z' }], '');
    const parsed = parseMultiPayload(payload);
    expect(parsed!.caption).toBe('');
  });

  it('handles file without blob marker gracefully', () => {
    // Direct parse of an unusual segment shouldn't crash
    const payload = '[multi:1][file:oddfile]';
    const parsed = parseMultiPayload(payload);
    expect(parsed).not.toBeNull();
    expect(parsed!.attachments[0].type).toBe('file');
  });
});
