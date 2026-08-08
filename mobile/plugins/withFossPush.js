/**
 * Expo config plugin — strip Google Play Services / Firebase from a `foss` build.
 *
 * Only active when EXPO_PUBLIC_DISTRIBUTION === 'foss' (the eas.json
 * `production-foss` profile and the F-Droid recipe). The Play build is
 * untouched, so this plugin cannot regress the store artifact.
 *
 * Why a build-time strip and not just "don't call the API": src/config.ts
 * already stops a foss build from ever asking for an FCM token
 * (REMOTE_PUSH_ENABLED), but that only changes runtime behaviour. F-Droid's
 * inclusion policy is about what the APK *contains* — expo-notifications pulls
 * com.google.firebase:firebase-messaging in transitively, so an unmodified
 * build ships Play Services libraries even when it never calls them. Anyone can
 * verify the result with `unzip -l app-release.apk | grep -i firebase`.
 *
 * Two things have to happen together:
 *
 *   1. Drop the dependencies (dependency-level exclude in app/build.gradle).
 *   2. Drop the manifest entries that reference them. This is the part that
 *      bites: expo-notifications registers ExpoFirebaseMessagingService, a class
 *      that extends FirebaseMessagingService. With the libraries excluded but
 *      the <service> still declared, Android would hit NoClassDefFoundError the
 *      moment it tried to instantiate it. Removing the declaration is what keeps
 *      the build launchable — local notifications live in a different code path
 *      and keep working.
 *
 * Wake-ups in a foss build come from the ntfy-over-Tor mailbox subscription
 * (src/notifications/mailboxPushSubscription.ts) and the call-wake foreground
 * service (withCallWakeService.js) — neither needs Google.
 *
 * NOT YET VALIDATED ON A DEVICE. The gradle + manifest edits are mechanical, but
 * "launches and rings on a Play-Services-free handset" needs a real build:
 *   gh workflow run build-apk-release.yml   (with EXPO_PUBLIC_DISTRIBUTION=foss)
 * then install on a de-Googled device or an AOSP emulator image.
 */
const { withAppBuildGradle, withAndroidManifest } = require('@expo/config-plugins');

/** Build is `foss` only when explicitly asked for; anything else stays Play. */
function isFoss() {
  return process.env.EXPO_PUBLIC_DISTRIBUTION === 'foss';
}

// Groups that make an APK non-free for F-Droid's purposes. `play-services-*`
// and `firebase-*` both live under these two.
const BLOCKED_GROUPS = ['com.google.firebase', 'com.google.android.gms'];

const MARKER = 'AegisLink: foss build — no Google Play Services';

// ── 1. Exclude the dependencies ──────────────────────────────────────────────
function withoutPlayServicesDeps(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('[withFossPush] expected a groovy build.gradle');
    }
    if (config.modResults.contents.includes(MARKER)) return config;

    const block = [
      '',
      `// ─── ${MARKER} ───`,
      '// Applied by plugins/withFossPush.js. expo-notifications pulls',
      '// firebase-messaging in transitively; a foss artifact must not carry it.',
      'configurations.all {',
      ...BLOCKED_GROUPS.map((g) => `    exclude group: '${g}'`),
      '}',
      '',
    ].join('\n');

    config.modResults.contents += block;
    return config;
  });
}

// ── 2. Drop manifest entries that reference the excluded classes ─────────────
// Anything whose android:name mentions firebase/gms would now point at a class
// that isn't in the APK. Covers expo-notifications' own
// ExpoFirebaseMessagingService as well as the libraries' own components.
function withoutPlayServicesManifest(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;

    const refersToGoogle = (node) => {
      const name = node?.$?.['android:name'] || '';
      return /firebase|com\.google\.android\.gms/i.test(name);
    };

    for (const kind of ['service', 'receiver', 'provider', 'activity', 'meta-data']) {
      if (!Array.isArray(app[kind])) continue;
      const before = app[kind].length;
      app[kind] = app[kind].filter((node) => !refersToGoogle(node));
      const removed = before - app[kind].length;
      if (removed > 0) {
        // Surfaces in the prebuild log so a packager can see what was taken out.
        console.log(`[withFossPush] removed ${removed} <${kind}> entry/entries referencing Google`);
      }
    }

    return config;
  });
}

module.exports = function withFossPush(config) {
  if (!isFoss()) return config;
  console.log('[withFossPush] foss build — stripping Play Services from the Android project');
  return withoutPlayServicesManifest(withoutPlayServicesDeps(config));
};
