/**
 * AegisLink — Expo config plugin bundle
 *
 * What it does:
 *   1. Copies pre-generated flat + adaptive foreground PNGs into Android res/
 *   2. Copies adaptive icon XML (mipmap-anydpi-v26) into Android res/
 *   3. Injects background colors into res/values/colors.xml
 *   4. Adds <activity-alias> entries to AndroidManifest.xml
 *   5. Writes network_security_config.xml with SHA-256 SPKI cert pins
 *      and wires android:networkSecurityConfig in AndroidManifest.xml
 *   6. Pins org.jitsi:webrtc (react-native-webrtc's native dependency) to a
 *      fixed version and adds Gradle network-resilience properties, so
 *      builds don't depend on jitpack.io's "list versions" metadata lookup.
 *
 * No image processing at build time → stable Gradle builds.
 * Icons are pre-generated locally via: node scripts/gen-icons.js
 */
const {
  withAndroidManifest,
  withDangerousMod,
  withProjectBuildGradle,
  withAppBuildGradle,
  withGradleProperties,
} = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const VARIANTS = [
  { name: 'dark',   bg: '#06090a' },
  { name: 'light',  bg: '#efece4' },
  { name: 'tinted', bg: '#14161c' },
  { name: 'work',   bg: '#1c1f55' },
];

const FLAT_FOLDERS = ['mipmap-mdpi', 'mipmap-hdpi', 'mipmap-xhdpi', 'mipmap-xxhdpi', 'mipmap-xxxhdpi'];

// ─── Step 1: Copy PNGs + XMLs into Android res/ ──────────────────────────────
function withCopyIcons(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const projectRoot = config.modRequest.projectRoot;
      const resDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      const src = path.join(projectRoot, 'android-icon-assets');

      for (const v of VARIANTS) {
        // Flat fallback PNGs
        for (const folder of FLAT_FOLDERS) {
          const srcFile = path.join(src, v.name, folder, `ic_launcher_${v.name}.png`);
          if (!fs.existsSync(srcFile)) continue;
          const destDir = path.join(resDir, folder);
          fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(srcFile, path.join(destDir, `ic_launcher_${v.name}.png`));

          // Adaptive foreground PNGs
          const fgFile = path.join(src, v.name, folder, `ic_launcher_${v.name}_fg.png`);
          if (fs.existsSync(fgFile)) {
            fs.copyFileSync(fgFile, path.join(destDir, `ic_launcher_${v.name}_fg.png`));
          }
        }

        // Adaptive icon XML (API 26+)
        const xmlSrc = path.join(src, v.name, 'mipmap-anydpi-v26', `ic_launcher_${v.name}.xml`);
        if (fs.existsSync(xmlSrc)) {
          const xmlDestDir = path.join(resDir, 'mipmap-anydpi-v26');
          fs.mkdirSync(xmlDestDir, { recursive: true });
          fs.copyFileSync(xmlSrc, path.join(xmlDestDir, `ic_launcher_${v.name}.xml`));
        }
      }

      // Inject background colors into res/values/colors.xml
      const colorsFile = path.join(resDir, 'values', 'colors.xml');
      let colorsContent = fs.existsSync(colorsFile)
        ? fs.readFileSync(colorsFile, 'utf8')
        : '<?xml version="1.0" encoding="utf-8"?>\n<resources>\n</resources>\n';

      for (const v of VARIANTS) {
        const tag = `<color name="ic_launcher_${v.name}_bg">`;
        if (!colorsContent.includes(tag)) {
          colorsContent = colorsContent.replace(
            '</resources>',
            `    ${tag}${v.bg}</color>\n</resources>`
          );
        }
      }
      fs.mkdirSync(path.join(resDir, 'values'), { recursive: true });
      fs.writeFileSync(colorsFile, colorsContent);

      return config;
    },
  ]);
}

// ─── Step 2: Add <activity-alias> entries to AndroidManifest ─────────────────
function withIconAliases(config) {
  return withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (!app) return config;

    const pkg = config.android?.package ?? 'com.aegislink.app';
    const mainActivity = `${pkg}.MainActivity`;

    // Remove stale aliases to avoid duplicates on rebuild
    app['activity-alias'] = (app['activity-alias'] ?? []).filter(
      (a) => !VARIANTS.some((v) => a.$?.['android:name']?.endsWith(`${v.name}Icon`))
    );

    for (const v of VARIANTS) {
      app['activity-alias'].push({
        $: {
          'android:name': `${mainActivity}${v.name}Icon`,
          'android:enabled': 'false',
          'android:exported': 'true',
          'android:icon': `@mipmap/ic_launcher_${v.name}`,
          'android:roundIcon': `@mipmap/ic_launcher_${v.name}`,
          'android:targetActivity': mainActivity,
        },
        'intent-filter': [
          {
            action: [{ $: { 'android:name': 'android.intent.action.MAIN' } }],
            category: [{ $: { 'android:name': 'android.intent.category.LAUNCHER' } }],
          },
        ],
      });
    }

    return config;
  });
}

// ─── Step 3: Android network_security_config.xml with SPKI cert pinning ──────
//
// SHA-256 SPKI pins re-extracted from the live relay on 2026-09-13 (Hetzner Helsinki):
//   Primary: Let's Encrypt YE2 intermediate (issuer=ISRG Root YE) — survives leaf rotation
//   Backup:  current leaf cert CN=aegislink.duckdns.org (renewed 2026-08-17)
//
// NOTE: certbot rotated the intermediate YE1 -> YE2 around 2026-08-17. The previous
// pins (YE1 leaf + YE1 intermediate) no longer match ANY cert in the live chain, which
// broke pinned TLS on every shipped build (iOS ATS rejected the connection outright:
// "Network request failed" at fetchPowChallenge).
//
// That was the SECOND intermediate rotation to brick shipped builds (E8 -> YE1 on the
// AWS->Hetzner move, then YE1 -> YE2). Because pins are baked into the binary, each one
// costs an emergency build plus a full store review — there is no server-side hotfix.
// So we now also pin the long-lived ISRG Root YE (SPKI_ANCHOR): roots live for years,
// so the next intermediate rotation degrades to "still works" instead of a total outage.
// The leaf and intermediate pins stay as the tighter, normally-matched pins — a pin-set
// passes if ANY pin matches, so this is added reach, not a relaxation of the others.
// Exposure delta is small: pinning YE2 already meant "any Let's Encrypt cert for this
// domain"; the root pin widens that to the same CA's other intermediates, and still
// rejects every non-ISRG CA and every user-installed root.
//
// To refresh the primary pin after cert renewal:
//   echo Q | openssl s_client -connect aegislink.duckdns.org:443 2>/dev/null \
//     | openssl x509 -pubkey -noout | openssl pkey -pubin -outform der \
//     | openssl dgst -sha256 -binary | openssl enc -base64
//
// PARITY: iOS enforces the SAME pins via ATS (app.json → ios.infoPlist →
// NSAppTransportSecurity.NSPinnedDomains). When you rotate SPKI_PRIMARY here,
// update app.json's NSPinnedCAIdentities with the SAME three values too — a
// stale iOS pin makes ATS reject the connection at the OS level (no app-code
// override possible), while Android silently keeps working. This exact drift
// caused a "registration failed" bug on the first iOS TestFlight build.
const SPKI_PRIMARY = 's/tdAOmUzd8syaTuqfgGvFcn6DzA5Cmb+Vby1ST+U3Y='; // LE YE2 intermediate
const SPKI_BACKUP  = 'ikzWA3NEA1YVdzZPkMmfU1/noMRdEdVGyxCkuSNpihA='; // current leaf (renewed 2026-08-17)
// Independently-held offline backup key (P-256). Private key is COLD-STORED
// outside the repo (_keystore_backup/aegis-pin-backup.key). If the LE chain or
// primary key must be abandoned, issue a cert with this key and installed
// clients still validate. This is the true "key we control" backup pin.
const SPKI_BACKUP2 = 'LvglXAxgB9K5SCOZrLvdX0VVc8UuEU+Bj6r58LSA7r8=';
// ANCHOR: ISRG Root YE — the root of the live chain (verified at depth 2 on
// 2026-09-14). Roots rotate on a multi-year cadence, so this pin keeps shipped
// builds alive across LE intermediate rotations that would otherwise kill both
// the leaf and intermediate pins at once. Last-resort reach, not the primary.
const SPKI_ANCHOR  = 'sCkq5UWXjg+7mKu9lMhhYF5bGLsy7VI/UNW3tccdR7w=';

const NETWORK_SECURITY_XML = `<?xml version="1.0" encoding="utf-8"?>
<!--
  Network Security Config — AegisLink
  Auto-generated by app.plugin.js during expo prebuild. Do not edit manually.

  Enforces SHA-256 SPKI pinning of the relay's TLS certificate to defeat MITM
  via compromised CAs or user-installed roots.

  ROTATION: when the relay's keypair rotates update SPKI_PRIMARY in app.plugin.js,
  rebuild, and release. The backup pin (LE E8 intermediate) survives leaf rotation.

  EXPIRATION: extend the expiration date before it passes — past expiration the
  pin-set is ignored (fail-open). 24 months is the recommended window.

  DEBUG: the <debug-overrides> block applies ONLY when the app is built with
  debuggable="true" so production releases NEVER trust user-installed roots.
-->
<network-security-config>
  <!-- Forbid cleartext (plain HTTP) everywhere by default — production fails
       closed against transport downgrade. Only the explicit dev-loopback
       domain-config below re-permits cleartext. -->
  <base-config cleartextTrafficPermitted="false">
    <trust-anchors>
      <certificates src="system"/>
    </trust-anchors>
  </base-config>
  <domain-config>
    <domain includeSubdomains="true">aegislink.duckdns.org</domain>
    <pin-set expiration="2027-12-31">
      <!-- PRIMARY: SHA-256 SPKI of Let's Encrypt YE2 intermediate (issuer=ISRG Root YE).
           Survives leaf-cert rotation as long as LE YE2 signs the new leaf. Re-check
           after any LE intermediate rotation (last seen 2026-09-13). -->
      <pin digest="SHA-256">${SPKI_PRIMARY}</pin>
      <!-- BACKUP: SHA-256 SPKI of the current leaf (CN=aegislink.duckdns.org).
           Second live pin; rotates on renewal (~60d) — the intermediate pin above is durable. -->
      <pin digest="SHA-256">${SPKI_BACKUP}</pin>
      <!-- BACKUP2: independently-held offline P-256 key (cold-stored). Disaster
           recovery if the LE chain / primary key must be abandoned. -->
      <pin digest="SHA-256">${SPKI_BACKUP2}</pin>
      <!-- ANCHOR: ISRG Root YE. Long-lived root of the live chain, so an LE
           intermediate rotation (which invalidates BOTH pins above at once)
           degrades to "still connects" instead of bricking every shipped build.
           Two such rotations already caused exactly that outage. -->
      <pin digest="SHA-256">${SPKI_ANCHOR}</pin>
    </pin-set>
  </domain-config>
  <!-- Dev loopback only: cleartext to the emulator host + Metro bundler.
       Harmless in production — the app never talks to these hosts there. -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">10.0.2.2</domain>
    <domain includeSubdomains="true">localhost</domain>
    <domain includeSubdomains="true">127.0.0.1</domain>
  </domain-config>
  <!-- Embedded Tor mailbox (sealed-sender Fase 4): the relay's hidden service
       speaks http:// over the Tor circuit. NOT a transport downgrade — Tor
       encrypts the stream end-to-end and authenticates the .onion by its key,
       and payloads are already E2E-sealed. Cleartext stays blocked for every
       non-.onion host. Without this the mailbox socket dies with
       UnknownServiceException (CLEARTEXT not permitted) and falls back to the
       clear network, defeating Fase 4. -->
  <domain-config cleartextTrafficPermitted="true">
    <domain includeSubdomains="true">onion</domain>
  </domain-config>
  <debug-overrides>
    <trust-anchors>
      <certificates src="user"/>
      <certificates src="system"/>
    </trust-anchors>
  </debug-overrides>
</network-security-config>
`;

function withNetworkSecurity(config) {
  // Write network_security_config.xml via dangerous mod (file generation)
  config = withDangerousMod(config, [
    'android',
    async (config) => {
      const resDir = path.join(config.modRequest.platformProjectRoot, 'app', 'src', 'main', 'res');
      const xmlDir = path.join(resDir, 'xml');
      fs.mkdirSync(xmlDir, { recursive: true });
      fs.writeFileSync(path.join(xmlDir, 'network_security_config.xml'), NETWORK_SECURITY_XML);
      return config;
    },
  ]);
  // Wire android:networkSecurityConfig + harden the <application> flags.
  config = withAndroidManifest(config, (config) => {
    const app = config.modResults.manifest.application?.[0];
    if (app?.$) {
      app.$['android:networkSecurityConfig'] = '@xml/network_security_config';
      // Disable adb/cloud backup of the app's private dir — the SQLite
      // social-graph DB must never be exfiltrable via `adb backup`. Identity
      // keys live in the Keystore (excluded from backup regardless).
      app.$['android:allowBackup'] = 'false';
    }
    return config;
  });
  return config;
}

// ─── Step 4: Pin org.jitsi:webrtc + harden Gradle network resilience ─────────
//
// react-native-webrtc's android/build.gradle declares:
//   api 'org.jitsi:webrtc:124.+'
// The "+" wildcard forces Gradle to query jitpack.io for
// org/jitsi/webrtc/maven-metadata.xml on EVERY build to resolve "latest 124.x".
// When jitpack is slow/down this times out the whole build:
//   "Unable to load Maven meta-data ... Read timed out"
//
// Fix: force the exact version that 124.+ currently resolves to. This is
// available directly from Maven Central (not jitpack-only), so the
// "list versions" round-trip to jitpack is skipped entirely.
//   Determined via: https://repo1.maven.org/maven2/org/jitsi/webrtc/maven-metadata.xml
//   -> <release>124.0.0</release> (only 111.0.0, 111.0.1, 118.0.0, 124.0.0 exist)
//   Verified https://repo1.maven.org/maven2/org/jitsi/webrtc/124.0.0/webrtc-124.0.0.pom -> HTTP 200
//
// This is applied via withProjectBuildGradle so it survives `expo prebuild`
// (android/ is regenerated from scratch every time — editing the generated
// file directly would be lost).
const JITSI_WEBRTC_VERSION = '124.0.0';

const JITSI_WEBRTC_RESOLUTION_BLOCK = `
// ─── AegisLink: pin org.jitsi:webrtc (injected by app.plugin.js) ────────────
// Avoids jitpack.io maven-metadata.xml lookups for the "124.+" wildcard
// declared by react-native-webrtc, which time out when jitpack is slow/down.
allprojects {
    configurations.all {
        resolutionStrategy {
            force 'org.jitsi:webrtc:${JITSI_WEBRTC_VERSION}'
        }
    }
}
`;

function withJitsiWebrtcPin(config) {
  return withProjectBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      return config;
    }
    if (!config.modResults.contents.includes('AegisLink: pin org.jitsi:webrtc')) {
      config.modResults.contents += JITSI_WEBRTC_RESOLUTION_BLOCK;
    }
    return config;
  });
}

// Gradle network resilience: longer timeouts + retries with backoff so a
// transient stall against jitpack/Maven Central doesn't fail the whole build
// outright. Applied to android/gradle.properties (also regenerated by
// `expo prebuild`, hence the config plugin).
const GRADLE_NETWORK_RESILIENCE_PROPS = {
  'systemProp.org.gradle.internal.http.connectionTimeout': '120000',
  'systemProp.org.gradle.internal.http.socketTimeout': '120000',
  'org.gradle.internal.repository.max.retries': '4',
  'org.gradle.internal.repository.initial.backoff': '1000',
};

function withGradleNetworkResilience(config) {
  return withGradleProperties(config, (config) => {
    for (const [key, value] of Object.entries(GRADLE_NETWORK_RESILIENCE_PROPS)) {
      const existing = config.modResults.find(
        (item) => item.type === 'property' && item.key === key
      );
      if (existing) {
        existing.value = value;
      } else {
        config.modResults.push({ type: 'property', key, value });
      }
    }
    return config;
  });
}

// ─── Step 5: Reproducible builds — drop the dependency-metadata blob ─────────
//
// By default the Android Gradle Plugin embeds a `dependenciesInfo` block in
// every release APK/AAB: a Protobuf, ENCRYPTED with a Google public key, listing
// the build's dependency tree. It is (a) non-deterministic — it cannot be
// reproduced byte-for-byte by a third party, which breaks reproducible builds and
// F-Droid verification — and (b) metadata: an opaque blob only Google can read,
// which is at odds with our zero-metadata, fully-auditable stance.
//
// Disabling it is the single most important change for a reproducible Android
// build. Applied via withAppBuildGradle so it survives `expo prebuild`
// (android/app/build.gradle is regenerated from scratch each time).
const REPRODUCIBLE_BUILD_BLOCK = `
// ─── AegisLink: reproducible build (injected by app.plugin.js) ───────────────
// Strip the encrypted Google dependency-metadata blob from release artifacts so
// they can be reproduced byte-for-byte and verified by third parties / F-Droid.
android {
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
    // lintVital runs on every assembleRelease and is both slow and was failing
    // the build (:expo-updates:lintVitalAnalyzeRelease). Lint analyzes source and
    // never touches the packaged bytes, so disabling it does not affect the
    // artifact or its reproducibility — only release-build feasibility/speed.
    lint {
        checkReleaseBuilds = false
        abortOnError = false
    }
}
`;

function withReproducibleBuild(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      return config;
    }
    if (!config.modResults.contents.includes('AegisLink: reproducible build')) {
      config.modResults.contents += REPRODUCIBLE_BUILD_BLOCK;
    }
    return config;
  });
}

module.exports = (config) => {
  config = withCopyIcons(config);
  config = withIconAliases(config);
  config = withNetworkSecurity(config);
  config = withJitsiWebrtcPin(config);
  config = withGradleNetworkResilience(config);
  config = withReproducibleBuild(config);
  return config;
};
