/**
 * Avatar image-source allowlist (security/privacy).
 *
 * Avatar sources are contact-controlled, so isImageUri is a trust boundary:
 *   - remote http(s) must be rejected — fetching a peer-chosen URL on render
 *     would leak our IP + online status (zero-metadata is non-negotiable);
 *   - data: must be image-only — a data:text/html payload reaching an <img>
 *     src is the CodeQL js/xss-through-dom sink.
 * Regression for the XSS/IP-leak CodeQL flagged on Avatar.tsx.
 */
import { describe, it, expect } from 'vitest';
import { isImageUri, safeImageSrc } from '../Avatar';

describe('Avatar isImageUri allowlist', () => {
  it('accepts local / embedded image schemes', () => {
    expect(isImageUri('file:///tmp/a.png')).toBe(true);
    expect(isImageUri('content://media/1')).toBe(true);
    expect(isImageUri('blob:abc')).toBe(true);
    expect(isImageUri('data:image/png;base64,AAAA')).toBe(true);
  });

  it('rejects remote URLs (IP / online-status leak)', () => {
    expect(isImageUri('http://evil.example/track.gif')).toBe(false);
    expect(isImageUri('https://evil.example/track.gif')).toBe(false);
  });

  it('rejects non-image data: payloads (XSS sink)', () => {
    expect(isImageUri('data:text/html,<script>alert(1)</script>')).toBe(false);
    expect(isImageUri('data:application/javascript,alert(1)')).toBe(false);
  });

  it('rejects empty / non-URI text (renders as initials/emoji instead)', () => {
    expect(isImageUri(null)).toBe(false);
    expect(isImageUri(undefined)).toBe(false);
    expect(isImageUri('Alice')).toBe(false);
    expect(isImageUri('🛡️')).toBe(false);
    expect(isImageUri('javascript:alert(1)')).toBe(false);
  });
});

describe('Avatar safeImageSrc (sink guard)', () => {
  it('passes through inert local schemes unchanged', () => {
    expect(safeImageSrc('blob:abc')).toBe('blob:abc');
    expect(safeImageSrc('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
  });

  it('reconstructs allowlisted-protocol URLs from the parsed URL', () => {
    expect(safeImageSrc('file:///tmp/a.png')).toBe('file:///tmp/a.png');
    expect(safeImageSrc('content://media/1')?.startsWith('content://')).toBe(true);
  });

  it('returns undefined for unsafe / non-URI sources (no DOM sink)', () => {
    expect(safeImageSrc('http://evil.example/track.gif')).toBeUndefined();
    expect(safeImageSrc('https://evil.example/track.gif')).toBeUndefined();
    expect(safeImageSrc('data:text/html,<script>alert(1)</script>')).toBeUndefined();
    expect(safeImageSrc('javascript:alert(1)')).toBeUndefined();
    expect(safeImageSrc('Alice')).toBeUndefined();
    expect(safeImageSrc(null)).toBeUndefined();
    expect(safeImageSrc(undefined)).toBeUndefined();
  });
});
