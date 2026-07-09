/**
 * Regression test — audit 2026-07-09, finding #7 (PRIVACY): avatars (and other
 * persisted media) were written to documentDirectory with no iOS backup
 * exclusion, leaking identifiable material into iCloud/iTunes backups.
 *
 * The fix is a config plugin that injects an NSURLIsExcludedFromBackupKey
 * snippet into AppDelegate.swift. These tests pin:
 *   1. the injection lands inside didFinishLaunchingWithOptions,
 *   2. every sensitive documentDirectory subdir is covered,
 *   3. the injection is idempotent and fails loud if the template changes.
 */
const {
  injectBackupExclusion,
  EXCLUDED_DIRS,
} = require('../withIosBackupExclusion.js');

// Trimmed-down copy of the SDK 54 (RN 0.81) generated AppDelegate.swift.
const APP_DELEGATE_SWIFT = `import Expo
import React
import ReactAppDependencyProvider

@UIApplicationMain
public class AppDelegate: ExpoAppDelegate {
  public override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }
}
`;

describe('withIosBackupExclusion', () => {
  it('injects the exclusion snippet inside didFinishLaunchingWithOptions', () => {
    const out = injectBackupExclusion(APP_DELEGATE_SWIFT);
    expect(out).toContain('isExcludedFromBackup = true');
    // Snippet lands after the method's opening brace, before its body.
    const anchorIdx = out.indexOf('didFinishLaunchingWithOptions');
    const snippetIdx = out.indexOf('isExcludedFromBackup');
    const bodyIdx = out.indexOf('let delegate = ReactNativeDelegate()');
    expect(anchorIdx).toBeGreaterThan(-1);
    expect(snippetIdx).toBeGreaterThan(anchorIdx);
    expect(snippetIdx).toBeLessThan(bodyIdx);
  });

  it('excludes every documentDirectory subdir holding private data', () => {
    const out = injectBackupExclusion(APP_DELEGATE_SWIFT);
    for (const dir of [
      'avatars', // finding #7: contact/group/self profile photos
      'channel_avatars',
      'media',
      'channelposts',
      'scheduledposts',
      'SQLite',
    ]) {
      expect(EXCLUDED_DIRS).toContain(dir);
      expect(out).toContain(`"${dir}"`);
    }
  });

  it('is idempotent (prebuild can run the plugin twice)', () => {
    const once = injectBackupExclusion(APP_DELEGATE_SWIFT);
    expect(injectBackupExclusion(once)).toBe(once);
  });

  it('fails loud when the AppDelegate template loses the anchor', () => {
    expect(() => injectBackupExclusion('public class AppDelegate {}')).toThrow(
      /did not match the expected/,
    );
  });
});
