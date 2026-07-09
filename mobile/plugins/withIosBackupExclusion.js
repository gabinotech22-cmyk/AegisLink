/**
 * Expo config plugin — exclude locally-persisted private data from iOS backups.
 *
 * iOS includes the whole Documents directory in iCloud/iTunes backups by
 * default. AegisLink persists identifiable material there (contact/group/self
 * avatars, decrypted chat media, staged channel posts) plus the SQLCipher DB —
 * anyone with access to a device backup (iMazing/iBackup, no jailbreak) could
 * extract it. Audit 2026-07-09, finding #7 (PRIVACY).
 *
 * NSURLIsExcludedFromBackupKey is a per-item filesystem attribute that can only
 * be set at runtime, so this plugin injects a snippet into AppDelegate.swift's
 * didFinishLaunchingWithOptions that (re)creates each sensitive directory and
 * flags it as excluded on every launch. Directory-level exclusion covers all
 * current and future files inside it.
 *
 * Caveat: if JS deletes and recreates one of these directories mid-session
 * (e.g. panic wipe), the flag is re-applied on the next launch — a small
 * window during which a backup could include the (empty or fresh) directory.
 */
const { withAppDelegate } = require('@expo/config-plugins');

// Every documentDirectory subdir where the app persists user content.
// Keep in sync with the JS writers:
//   avatars/          — self/contact/group avatars (identity.ts, groups.ts,
//                       AvatarCropModal.tsx, db/groups.ts, socket/client.ts)
//   channel_avatars/  — channel avatar cache (channels/channelAvatarCache.ts)
//   media/            — chat media store (crypto/media.ts)
//   channelposts/     — staged channel post images (ChannelFeed.tsx,
//                       scheduledMessages.ts)
//   scheduledposts/   — staged group post images (GroupPosts.tsx)
//   SQLite/           — SQLCipher database files (db/core.ts); encrypted with
//                       a _THIS_DEVICE_ONLY key, so a backed-up copy is
//                       unrestorable anyway — excluded to minimize metadata.
const EXCLUDED_DIRS = [
  'avatars',
  'channel_avatars',
  'media',
  'channelposts',
  'scheduledposts',
  'SQLite',
];

const MARKER = 'AegisLink: exclude private data from iCloud/iTunes backups';

const SNIPPET = `
    // ${MARKER}.
    // NSURLIsExcludedFromBackupKey must be (re)applied at runtime; directory-
    // level exclusion covers every file inside. See plugins/withIosBackupExclusion.js.
    let aegisDocs = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    for aegisDirName in [${EXCLUDED_DIRS.map((d) => `"${d}"`).join(', ')}] {
      var aegisDir = aegisDocs.appendingPathComponent(aegisDirName, isDirectory: true)
      try? FileManager.default.createDirectory(at: aegisDir, withIntermediateDirectories: true)
      var aegisValues = URLResourceValues()
      aegisValues.isExcludedFromBackup = true
      try? aegisDir.setResourceValues(aegisValues)
    }`;

/**
 * Pure injection over the generated AppDelegate.swift source. Exported for the
 * regression test. Throws (fail loud at prebuild) if the anchor is missing —
 * a silent no-op would ship a build that backs up private media to iCloud.
 */
function injectBackupExclusion(src) {
  if (src.includes(MARKER)) return src; // idempotent

  const anchor = /(func application\([^)]*didFinishLaunchingWithOptions[^{]*\{)/;
  const next = src.replace(anchor, `$1${SNIPPET}`);
  if (next === src) {
    throw new Error(
      '[withIosBackupExclusion] failed to inject backup exclusion: the generated ' +
        'AppDelegate.swift did not match the expected didFinishLaunchingWithOptions ' +
        'anchor. The Expo template likely changed — update ' +
        'mobile/plugins/withIosBackupExclusion.js.',
    );
  }
  return next;
}

module.exports = function withIosBackupExclusion(config) {
  return withAppDelegate(config, (config) => {
    if (config.modResults.language !== 'swift') {
      throw new Error(
        '[withIosBackupExclusion] expected a Swift AppDelegate; got ' +
          config.modResults.language,
      );
    }
    config.modResults.contents = injectBackupExclusion(config.modResults.contents);
    return config;
  });
};

module.exports.injectBackupExclusion = injectBackupExclusion;
module.exports.EXCLUDED_DIRS = EXCLUDED_DIRS;
