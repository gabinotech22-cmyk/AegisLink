/**
 * groupPost wire-format — build/parse/strip round-trip and spoof-resistance.
 */
import { buildGroupPostBody, parseGroupPostMarker, stripGroupPostMarker } from '../groupPost';

describe('groupPost wire format', () => {
  it('round-trips every flag combination', () => {
    const metas = [
      { asGroup: true, pinned: true, silent: true, repliesOff: true },
      { asGroup: true, pinned: false, silent: false, repliesOff: false },
      { asGroup: false, pinned: true, silent: false, repliesOff: true },
      { asGroup: false, pinned: false, silent: false, repliesOff: false },
    ];
    for (const meta of metas) {
      const body = buildGroupPostBody('Hola grupo 🎉', meta);
      const parsed = parseGroupPostMarker(body);
      expect(parsed.isPost).toBe(true);
      expect(parsed.asGroup).toBe(meta.asGroup);
      expect(parsed.pinned).toBe(meta.pinned);
      expect(parsed.silent).toBe(meta.silent);
      expect(parsed.repliesOff).toBe(meta.repliesOff);
      expect(parsed.text).toBe('Hola grupo 🎉');
    }
  });

  it('builds the documented compact format', () => {
    expect(buildGroupPostBody('x', { asGroup: true, pinned: true, silent: true, repliesOff: true }))
      .toBe('[post:gpsr]x');
    expect(buildGroupPostBody('x', { asGroup: false, pinned: false, silent: false, repliesOff: false }))
      .toBe('[post:]x');
  });

  it('treats regular messages as non-posts and leaves them untouched', () => {
    for (const body of ['hola', '[poll:q|a|b]', '', '[image:data:abc]caption']) {
      const p = parseGroupPostMarker(body);
      expect(p.isPost).toBe(false);
      expect(p.text).toBe(body);
    }
  });

  it('rejects marker-lookalikes typed by users (non-flag content)', () => {
    // Uppercase, digits, spaces, long strings — all must NOT parse as a post.
    for (const body of ['[post:HOLA]x', '[post:12]x', '[post:hello world]x', '[post:abcdefghij]x']) {
      expect(parseGroupPostMarker(body).isPost).toBe(false);
    }
  });

  it('ignores unknown lowercase flags (forward compatible)', () => {
    const p = parseGroupPostMarker('[post:gpz]texto');
    expect(p.isPost).toBe(true);
    expect(p.asGroup).toBe(true);
    expect(p.pinned).toBe(true);
    expect(p.silent).toBe(false);
    expect(p.text).toBe('texto');
  });

  it('stripGroupPostMarker returns display text for posts and passthrough otherwise', () => {
    expect(stripGroupPostMarker('[post:g]Anuncio')).toBe('Anuncio');
    expect(stripGroupPostMarker('mensaje normal')).toBe('mensaje normal');
  });
});
