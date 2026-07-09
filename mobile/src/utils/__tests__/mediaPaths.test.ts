/**
 * mediaPaths — regression tests for iOS audit finding #6 (ALTO):
 * absolute file:// URIs persisted across app data survive a TestFlight
 * build/reinstall (which changes the sandbox container UUID) as dangling
 * pointers. toRelativeMediaPath/toAbsoluteMediaUri fix this by storing a
 * container-independent relative pointer and re-resolving it on read.
 */

jest.mock('expo-file-system/legacy', () => ({
  documentDirectory: 'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/',
  cacheDirectory: 'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Library/Caches/',
}));

import { toRelativeMediaPath, toAbsoluteMediaUri } from '../mediaPaths';

describe('mediaPaths', () => {
  describe('toRelativeMediaPath / toAbsoluteMediaUri round-trip', () => {
    it('round-trips a documentDirectory URI', () => {
      const abs = 'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/avatars/self.jpg';
      const rel = toRelativeMediaPath(abs);
      expect(rel).toBe('doc:avatars/self.jpg');
      expect(toAbsoluteMediaUri(rel)).toBe(abs);
    });

    it('round-trips a cacheDirectory URI', () => {
      const abs = 'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Library/Caches/chgif_123.gif';
      const rel = toRelativeMediaPath(abs);
      expect(rel).toBe('cache:chgif_123.gif');
      expect(toAbsoluteMediaUri(rel)).toBe(abs);
    });
  });

  describe('hot migration of a stale absolute URI (old container UUID)', () => {
    it('rewrites a Documents-based URI from a different container to a relative pointer', () => {
      const stale = 'file:///var/mobile/Containers/Data/Application/OLD-UUID-FROM-PREVIOUS-BUILD/Documents/avatars/group_x_avatar.jpg';
      const rel = toRelativeMediaPath(stale);
      expect(rel).toBe('doc:avatars/group_x_avatar.jpg');
      // Resolves against the CURRENT container, not the stale one.
      expect(toAbsoluteMediaUri(rel)).toBe(
        'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/avatars/group_x_avatar.jpg',
      );
    });

    it('re-resolves a still-absolute stale URI directly (defensive passthrough path)', () => {
      const stale = 'file:///var/mobile/Containers/Data/Application/OLD-UUID/Library/Caches/media_1.jpg';
      expect(toAbsoluteMediaUri(stale)).toBe(
        'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Library/Caches/media_1.jpg',
      );
    });
  });

  describe('passthrough for non-local URIs', () => {
    it.each([
      'https://relay.example.com/blob/abc',
      'http://relay.example.com/blob/abc',
      'content://media/external/images/media/42',
      'ph://ABCDEF-1234',
      'data:image/jpeg;base64,AAAA',
      'blob:msg123:key:nonce',
    ])('leaves %s unchanged by toRelativeMediaPath and toAbsoluteMediaUri', (uri) => {
      expect(toRelativeMediaPath(uri)).toBe(uri);
      expect(toAbsoluteMediaUri(uri)).toBe(uri);
    });

    it('leaves an already-relative "doc:" pointer unchanged by toRelativeMediaPath (idempotent)', () => {
      expect(toRelativeMediaPath('doc:avatars/already-relative.jpg')).toBe('doc:avatars/already-relative.jpg');
    });

    it('leaves an already-relative "cache:" pointer unchanged by toRelativeMediaPath (idempotent)', () => {
      expect(toRelativeMediaPath('cache:already-relative.gif')).toBe('cache:already-relative.gif');
    });

    it('resolves an already-relative "doc:"/"cache:" pointer to the current absolute directory', () => {
      expect(toAbsoluteMediaUri('doc:avatars/already-relative.jpg')).toBe(
        'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Documents/avatars/already-relative.jpg',
      );
      expect(toAbsoluteMediaUri('cache:already-relative.gif')).toBe(
        'file:///var/mobile/Containers/Data/Application/CURRENT-UUID/Library/Caches/already-relative.gif',
      );
    });
  });

  describe('edge cases', () => {
    it('returns empty string for null/undefined/empty input', () => {
      expect(toRelativeMediaPath(null)).toBe('');
      expect(toRelativeMediaPath(undefined)).toBe('');
      expect(toRelativeMediaPath('')).toBe('');
      expect(toAbsoluteMediaUri(null)).toBe('');
      expect(toAbsoluteMediaUri(undefined)).toBe('');
      expect(toAbsoluteMediaUri('')).toBe('');
    });

    it('passes through an unrecognized absolute file:// URI outside sandboxed dirs', () => {
      const uri = 'file:///private/var/some/other/place.jpg';
      expect(toRelativeMediaPath(uri)).toBe(uri);
    });
  });
});
